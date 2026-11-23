// Media capability probe. Runs inside a WebKitGTK webview and reports back
// through the `probe` script message handler.
(() => {
  const R = {};
  const params = new URLSearchParams(location.search);
  const MODE = params.get('mode') || 'matrix';
  const post = (kind, payload) => {
    try {
      window.webkit.messageHandlers.probe.postMessage(JSON.stringify({ kind, payload }));
    } catch (e) {
      console.log('post failed', e);
    }
  };
  const timeout = (p, ms, label) =>
    Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT ${label} after ${ms}ms`)), ms))
    ]);
  const err = (e) => ({ error: (e && e.name) || 'Error', message: String((e && e.message) || e) });
  const HW = params.get('hw') ? { hardwareAcceleration: params.get('hw') } : {};
  const SKIP = new Set((params.get('skip') || '').split(',').filter(Boolean));
  async function step(name, fn, ms = 10000) {
    if (SKIP.has(name)) {
      R[name] = { skipped: 'by flag' };
      return;
    }
    try {
      R[name] = await timeout(Promise.resolve().then(fn), ms, name);
    } catch (e) {
      R[name] = err(e);
    }
    post('progress', { name, value: R[name] });
  }
  const trackInfo = (t) => ({
    kind: t.kind,
    label: t.label,
    readyState: t.readyState,
    muted: t.muted,
    enabled: t.enabled,
    settings: (() => {
      try {
        return t.getSettings();
      } catch (e) {
        return err(e);
      }
    })()
  });
  const devInfo = (d) => ({ kind: d.kind, label: d.label, deviceId: d.deviceId ? d.deviceId.slice(0, 12) + '…' : '', groupId: d.groupId ? 'set' : '' });

  let micStream = null;
  let camStream = null;

  async function matrix() {
    await step('env', () => ({
      href: location.href,
      origin: location.origin,
      isSecureContext: window.isSecureContext,
      crossOriginIsolated: window.crossOriginIsolated,
      hasFocus: document.hasFocus(),
      visibility: document.visibilityState,
      userAgent: navigator.userAgent
    }));

    await step('globals', () => {
      const names = [
        'RTCPeerConnection', 'RTCDataChannel', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCSessionDescription', 'RTCIceCandidate',
        'MediaStream', 'MediaStreamTrack', 'MediaRecorder', 'MediaDevices',
        'AudioContext', 'webkitAudioContext', 'AudioWorklet', 'AudioWorkletNode', 'OfflineAudioContext',
        'VideoEncoder', 'VideoDecoder', 'VideoFrame', 'EncodedVideoChunk', 'AudioEncoder', 'AudioDecoder', 'AudioData',
        'MediaStreamTrackProcessor', 'MediaStreamTrackGenerator', 'VideoTrackGenerator',
        'OffscreenCanvas', 'WebAssembly', 'Worker', 'SharedWorker', 'SharedArrayBuffer', 'WebTransport', 'WebSocket',
        'ImageCapture', 'MediaSource', 'ManagedMediaSource', 'Notification', 'BroadcastChannel', 'CompressionStream'
      ];
      const out = {};
      for (const n of names) out[n] = typeof window[n];
      out['navigator.mediaDevices'] = typeof navigator.mediaDevices;
      out['mediaDevices.getUserMedia'] = typeof navigator.mediaDevices?.getUserMedia;
      out['mediaDevices.enumerateDevices'] = typeof navigator.mediaDevices?.enumerateDevices;
      out['mediaDevices.getDisplayMedia'] = typeof navigator.mediaDevices?.getDisplayMedia;
      out['mediaDevices.selectAudioOutput'] = typeof navigator.mediaDevices?.selectAudioOutput;
      out['mediaDevices.getSupportedConstraints'] = typeof navigator.mediaDevices?.getSupportedConstraints;
      out['HTMLMediaElement.setSinkId'] = typeof HTMLMediaElement.prototype.setSinkId;
      out['HTMLCanvasElement.captureStream'] = typeof HTMLCanvasElement.prototype.captureStream;
      out['HTMLVideoElement.requestVideoFrameCallback'] = typeof HTMLVideoElement.prototype.requestVideoFrameCallback;
      out['navigator.permissions'] = typeof navigator.permissions;
      out['navigator.wakeLock'] = typeof navigator.wakeLock;
      return out;
    });

    if (!navigator.mediaDevices) {
      R.note = 'navigator.mediaDevices is undefined; capture probes skipped';
    } else {
      await step('supportedConstraints', () => navigator.mediaDevices.getSupportedConstraints());
      await step('permissions.query', async () => {
        const out = {};
        for (const name of ['microphone', 'camera']) {
          try {
            out[name] = (await navigator.permissions.query({ name })).state;
          } catch (e) {
            out[name] = err(e);
          }
        }
        return out;
      }, 5000);
      await step('enumerate_before', async () => (await navigator.mediaDevices.enumerateDevices()).map(devInfo));
      await step('gum_audio_basic', async () => {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        return micStream.getTracks().map(trackInfo);
      }, 15000);
      await step('enumerate_after_audio', async () => (await navigator.mediaDevices.enumerateDevices()).map(devInfo));
      await step('gum_audio_dsp_constraints', async () => {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000 },
          video: false
        });
        const info = s.getTracks().map(trackInfo);
        s.getTracks().forEach((t) => t.stop());
        return info;
      }, 15000);
      await step('gum_audio_deviceId', async () => {
        const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId);
        if (!inputs.length) return { skipped: 'no audioinput with deviceId' };
        const out = [];
        for (const d of inputs.slice(0, 4)) {
          try {
            const s = await timeout(navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: d.deviceId } } }), 8000, 'deviceId');
            out.push({ label: d.label, ok: true, track: s.getAudioTracks()[0]?.label });
            s.getTracks().forEach((t) => t.stop());
          } catch (e) {
            out.push({ label: d.label, ...err(e) });
          }
        }
        return out;
      }, 40000);
      await step('gum_video', async () => {
        camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        return camStream.getTracks().map(trackInfo);
      }, 12000);
      await step('enumerate_after_video', async () => (await navigator.mediaDevices.enumerateDevices()).map(devInfo));
      await step('gdm_no_gesture', async () => {
        const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const info = s.getTracks().map(trackInfo);
        s.getTracks().forEach((t) => t.stop());
        return info;
      }, 6000);
    }

    // Web Audio graph: does captured microphone audio actually flow?
    await step('audio_graph', async () => {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const out = { initialState: ctx.state, sampleRate: ctx.sampleRate, baseLatency: ctx.baseLatency };
      try {
        await timeout(ctx.resume(), 3000, 'resume');
      } catch (e) {
        out.resume = err(e);
      }
      out.stateAfterResume = ctx.state;
      out.hasAudioWorklet = !!ctx.audioWorklet;
      if (ctx.audioWorklet) {
        // same-origin module (what the app ships) and a blob module (what the codec uses)
        try {
          await timeout(ctx.audioWorklet.addModule('/worklet.js'), 5000, 'addModule self');
          out.workletSelf = 'ok';
        } catch (e) {
          out.workletSelf = err(e);
        }
        try {
          const src = `registerProcessor('probe-blob', class extends AudioWorkletProcessor { process() { return true; } });`;
          const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
          await timeout(ctx.audioWorklet.addModule(url), 5000, 'addModule blob');
          out.workletBlob = 'ok';
        } catch (e) {
          out.workletBlob = err(e);
        }
      }
      if (micStream && out.workletSelf === 'ok') {
        const source = ctx.createMediaStreamSource(micStream);
        const node = new AudioWorkletNode(ctx, 'probe-meter');
        const stats = { calls: 0, frames: 0, peak: 0, nonZeroBlocks: 0 };
        node.port.onmessage = (ev) => Object.assign(stats, ev.data);
        const sink = ctx.createGain();
        sink.gain.value = 0;
        source.connect(node).connect(sink).connect(ctx.destination);
        await new Promise((r) => setTimeout(r, 2500));
        out.micThroughWorklet = { ...stats };
        try {
          source.disconnect();
          node.disconnect();
        } catch {}
      } else {
        out.micThroughWorklet = { skipped: micStream ? 'worklet unavailable' : 'no mic stream' };
      }
      // Oscillator through the worklet proves the render thread runs at all.
      if (out.workletSelf === 'ok') {
        const osc = ctx.createOscillator();
        const node = new AudioWorkletNode(ctx, 'probe-meter');
        const stats = { calls: 0, frames: 0, peak: 0, nonZeroBlocks: 0 };
        node.port.onmessage = (ev) => Object.assign(stats, ev.data);
        const sink = ctx.createGain();
        sink.gain.value = 0;
        osc.connect(node).connect(sink).connect(ctx.destination);
        osc.start();
        await new Promise((r) => setTimeout(r, 1200));
        osc.stop();
        out.oscillatorThroughWorklet = { ...stats };
      }
      try {
        const dest = ctx.createMediaStreamDestination();
        out.mediaStreamDestination = dest.stream.getAudioTracks().length + ' track(s)';
      } catch (e) {
        out.mediaStreamDestination = err(e);
      }
      out.finalState = ctx.state;
      await ctx.close().catch(() => {});
      return out;
    }, 25000);

    await step('workers_wasm', async () => {
      const out = {};
      try {
        const url = URL.createObjectURL(new Blob([`onmessage = (e) => postMessage(e.data * 2);`], { type: 'application/javascript' }));
        const w = new Worker(url);
        out.blobWorker = await timeout(new Promise((res, rej) => {
          w.onmessage = (e) => res(e.data === 42 ? 'ok' : 'bad');
          w.onerror = (e) => rej(new Error(e.message || 'worker error'));
          w.postMessage(21);
        }), 5000, 'blob worker');
        w.terminate();
      } catch (e) {
        out.blobWorker = err(e);
      }
      try {
        // (module (func (export "f") (result i32) i32.const 7))
        const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 5, 1, 1, 102, 0, 0, 10, 6, 1, 4, 0, 65, 7, 11]);
        const { instance } = await WebAssembly.instantiate(bytes);
        out.wasm = instance.exports.f() === 7 ? 'ok' : 'bad';
      } catch (e) {
        out.wasm = err(e);
      }
      return out;
    });

    await step('mediaRecorder', async () => {
      if (typeof MediaRecorder === 'undefined') return { supported: false };
      const types = ['audio/webm', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'video/webm', 'video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8,opus', 'video/mp4', 'video/mp4;codecs=avc1.42E01E'];
      const out = { types: {} };
      for (const t of types) out.types[t] = MediaRecorder.isTypeSupported(t);
      if (micStream) {
        try {
          const rec = new MediaRecorder(micStream);
          out.defaultMime = rec.mimeType;
          const chunks = [];
          rec.ondataavailable = (e) => chunks.push(e.data.size);
          rec.start(250);
          await new Promise((r) => setTimeout(r, 1300));
          await new Promise((r) => {
            rec.onstop = r;
            rec.stop();
          });
          out.recorded = { mime: rec.mimeType, chunks: chunks.length, bytes: chunks.reduce((a, b) => a + b, 0) };
        } catch (e) {
          out.recorded = err(e);
        }
        out.explicit = {};
        for (const mimeType of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']) {
          try {
            const rec = new MediaRecorder(micStream, { mimeType });
            const chunks = [];
            rec.ondataavailable = (e) => chunks.push(e.data.size);
            rec.start(250);
            await new Promise((r) => setTimeout(r, 1500));
            await new Promise((r) => {
              rec.onstop = r;
              rec.stop();
            });
            await new Promise((r) => setTimeout(r, 200));
            out.explicit[mimeType] = { mime: rec.mimeType, chunks: chunks.length, bytes: chunks.reduce((a, b) => a + b, 0) };
          } catch (e) {
            out.explicit[mimeType] = err(e);
          }
        }
      }
      return out;
    }, 30000);

    // A live WebGL context makes the web process create its shared GL display.
    if (params.get('webgl') === '1') {
      await step('webgl_first', () => {
        const c = document.createElement('canvas');
        c.width = 64;
        c.height = 64;
        document.body.appendChild(c);
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        if (!gl) return { created: false };
        window.__probeGl = gl;
        gl.clearColor(0.2, 0.4, 0.6, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        return { created: true, version: gl.getParameter(gl.VERSION), renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
      });
    }

    await step('webcodecs_support', async () => {
      const out = { video_encode: {}, video_decode: {}, audio_encode: {}, audio_decode: {} };
      const vcodecs = ['vp8', 'vp09.00.10.08', 'avc1.42001f', 'avc1.42E01E', 'av01.0.04M.08', 'hvc1.1.6.L93.B0'];
      if (typeof VideoEncoder !== 'undefined') {
        for (const codec of vcodecs) {
          post('progress', { name: 'trace:venc:' + codec });
          try {
            const r = await VideoEncoder.isConfigSupported({ codec, width: 640, height: 360, bitrate: 600_000, framerate: 15, latencyMode: 'realtime' });
            out.video_encode[codec] = !!r.supported;
          } catch (e) {
            out.video_encode[codec] = err(e);
          }
        }
      } else out.video_encode = 'VideoEncoder undefined';
      if (typeof VideoDecoder !== 'undefined') {
        for (const codec of vcodecs) {
          post('progress', { name: 'trace:vdec:' + codec });
          try {
            const r = await VideoDecoder.isConfigSupported({ codec, codedWidth: 640, codedHeight: 360, ...HW });
            out.video_decode[codec] = !!r.supported;
          } catch (e) {
            out.video_decode[codec] = err(e);
          }
        }
      } else out.video_decode = 'VideoDecoder undefined';
      if (typeof AudioEncoder !== 'undefined') {
        for (const codec of ['opus', 'mp4a.40.2']) {
          post('progress', { name: 'trace:aenc:' + codec });
          try {
            const r = await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 1, bitrate: 32000 });
            out.audio_encode[codec] = !!r.supported;
          } catch (e) {
            out.audio_encode[codec] = err(e);
          }
        }
      } else out.audio_encode = 'AudioEncoder undefined';
      if (typeof AudioDecoder !== 'undefined') {
        for (const codec of ['opus', 'mp4a.40.2']) {
          post('progress', { name: 'trace:adec:' + codec });
          try {
            const r = await AudioDecoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 1 });
            out.audio_decode[codec] = !!r.supported;
          } catch (e) {
            out.audio_decode[codec] = err(e);
          }
        }
      } else out.audio_decode = 'AudioDecoder undefined';
      return out;
    }, 20000);

    // Real round trip in the same shape as wabidbVideoLane: canvas -> VideoFrame
    // -> VideoEncoder -> VideoDecoder -> canvas.captureStream.
    await step('webcodecs_roundtrip', async () => {
      if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined' || typeof VideoFrame === 'undefined') {
        return { skipped: 'WebCodecs video missing' };
      }
      const result = {};
      for (const codec of ['vp8', 'vp09.00.10.08', 'avc1.42001f']) {
        const r = { encoded: 0, bytes: 0, decoded: 0, keyFrames: 0 };
        post('progress', { name: 'trace:roundtrip:' + codec });
        try {
          const sup = await VideoEncoder.isConfigSupported({ codec, width: 640, height: 360, bitrate: 600_000, framerate: 15 });
          if (!sup.supported) {
            result[codec] = { skipped: 'unsupported' };
            continue;
          }
          const canvas = document.createElement('canvas');
          canvas.width = 640;
          canvas.height = 360;
          const g = canvas.getContext('2d');
          let decoderError = null;
          let encoderError = null;
          const decoder = new VideoDecoder({
            output: (f) => {
              r.decoded++;
              r.decodedSize = `${f.displayWidth}x${f.displayHeight}`;
              f.close();
            },
            error: (e) => (decoderError = String(e))
          });
          let configured = false;
          const encoder = new VideoEncoder({
            output: (chunk, meta) => {
              r.encoded++;
              r.bytes += chunk.byteLength;
              if (chunk.type === 'key') r.keyFrames++;
              try {
                if (!configured) {
                  decoder.configure({ ...(meta?.decoderConfig ?? { codec, codedWidth: 640, codedHeight: 360 }), ...HW });
                  configured = true;
                }
                decoder.decode(chunk);
              } catch (e) {
                decoderError = String(e);
              }
            },
            error: (e) => (encoderError = String(e))
          });
          encoder.configure({ codec, width: 640, height: 360, bitrate: 600_000, framerate: 15, latencyMode: 'realtime' });
          for (let i = 0; i < 12; i++) {
            g.fillStyle = `hsl(${i * 30}, 80%, 50%)`;
            g.fillRect(0, 0, 640, 360);
            g.fillStyle = '#fff';
            g.fillRect(i * 40, 100, 80, 80);
            const frame = new VideoFrame(canvas, { timestamp: i * 66_666 });
            encoder.encode(frame, { keyFrame: i === 0 });
            frame.close();
            await new Promise((res) => setTimeout(res, 20));
          }
          await timeout(encoder.flush(), 6000, 'encoder flush');
          await timeout(decoder.flush(), 6000, 'decoder flush');
          if (encoderError) r.encoderError = encoderError;
          if (decoderError) r.decoderError = decoderError;
          encoder.close();
          decoder.close();
        } catch (e) {
          Object.assign(r, err(e));
        }
        result[codec] = r;
      }
      try {
        const c = document.createElement('canvas');
        c.width = 64;
        c.height = 64;
        c.getContext('2d').fillRect(0, 0, 64, 64);
        const s = c.captureStream(15);
        result.canvasCaptureStream = s.getVideoTracks().length + ' video track(s)';
      } catch (e) {
        result.canvasCaptureStream = err(e);
      }
      return result;
    }, 60000);

    // Camera stream through <video> + canvas, the capture half of the relay video lane.
    await step('camera_to_canvas', async () => {
      if (!camStream) return { skipped: 'no camera stream' };
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.srcObject = camStream;
      await timeout(v.play(), 5000, 'video.play');
      await new Promise((r) => setTimeout(r, 1200));
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = 90;
      const g = c.getContext('2d');
      g.drawImage(v, 0, 0, 160, 90);
      const px = g.getImageData(0, 0, 160, 90).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
      return { videoWidth: v.videoWidth, videoHeight: v.videoHeight, readyState: v.readyState, meanLuma: Math.round(sum / (px.length / 4) / 3) };
    }, 15000);

    await step('rtc', async () => {
      if (typeof RTCPeerConnection === 'undefined') return { supported: false, reason: 'RTCPeerConnection undefined' };
      const out = { supported: true };
      const a = new RTCPeerConnection();
      const b = new RTCPeerConnection();
      try {
        a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
        b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
        const dc = a.createDataChannel('probe');
        const opened = new Promise((res) => (dc.onopen = () => res('open')));
        const echoed = new Promise((res) => {
          b.ondatachannel = (ev) => {
            ev.channel.onmessage = (m) => res(m.data);
          };
        });
        let gotTrack = null;
        b.ontrack = (ev) => (gotTrack = ev.track.kind);
        if (micStream) micStream.getAudioTracks().forEach((t) => a.addTrack(t, micStream));
        const offer = await a.createOffer();
        out.offerSdpBytes = offer.sdp.length;
        out.offerCodecs = [...offer.sdp.matchAll(/a=rtpmap:\d+ ([^\r\n]+)/g)].map((m) => m[1]).slice(0, 12);
        await a.setLocalDescription(offer);
        await b.setRemoteDescription(offer);
        const answer = await b.createAnswer();
        await b.setLocalDescription(answer);
        await a.setRemoteDescription(answer);
        out.dataChannel = await timeout(opened, 10000, 'datachannel open');
        dc.send('ping');
        out.dataChannelEcho = await timeout(echoed, 5000, 'datachannel message');
        out.connectionState = a.connectionState;
        out.iceConnectionState = a.iceConnectionState;
        out.remoteTrack = gotTrack;
      } catch (e) {
        Object.assign(out, { failure: err(e), connectionState: a.connectionState, iceConnectionState: a.iceConnectionState });
      } finally {
        a.close();
        b.close();
      }
      return out;
    }, 30000);

    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    if (camStream) camStream.getTracks().forEach((t) => t.stop());
    post('done', R);
  }

  // Screen share needs a real user gesture: the harness synthesises a click on
  // this full-page button, and the portal picker then needs a person.
  function gesture() {
    const b = document.createElement('button');
    b.textContent = 'share';
    b.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;font-size:40px';
    document.body.appendChild(b);
    b.addEventListener('click', async () => {
      post('progress', { name: 'click', value: { isTrusted: true, userActivation: navigator.userActivation?.isActive } });
      await step('gdm_gesture', async () => {
        // audio=1 mirrors callingScreenShare.ts: the "auto" quality profile plus audio: true.
        const appShape = params.get('audio') === '1';
        const s = await navigator.mediaDevices.getDisplayMedia(appShape
          ? { video: { frameRate: { ideal: 24, max: 30 }, width: { ideal: 1920, max: 2560 }, height: { ideal: 1080, max: 1440 } }, audio: true }
          : { video: true, audio: false });
        const info = s.getTracks().map(trackInfo);
        const v = document.createElement('video');
        v.muted = true;
        v.srcObject = s;
        await v.play().catch(() => {});
        await new Promise((r) => setTimeout(r, 1500));
        const dims = { videoWidth: v.videoWidth, videoHeight: v.videoHeight };
        s.getTracks().forEach((t) => t.stop());
        return { tracks: info, ...dims };
      }, Number(params.get('wait') || 20000));
      post('done', R);
    });
    post('ready', {});
  }

  // Wabi's relay audio path with the production pieces: opus-recorder encoder
  // (an AudioWorklet module carrying WASM), the decoder as a blob Worker that
  // fetches its .wasm from the app origin, and the app's playback worklet.
  async function relayOnce(ctx, track, label, opts = {}) {
    const durationMs = opts.durationMs ?? 3000;
    const fanout = opts.fanout ?? 1;
    const out = { label };
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const stats = { pages: 0, pageBytes: 0, firstPageIsBOS: null, decoderMessages: 0, decodedSamples: 0, decodedPeak: 0, renderedAcks: 0, renderedSamples: 0 };
    const errors = [];
    const t0 = performance.now();
    const recorder = new Recorder({
      sourceNode: source, numberOfChannels: 1, encoderSampleRate: 48000, encoderFrameSize: 20,
      maxFramesPerPage: 2, bufferLength: 1024, monitorGain: 0, streamPages: true,
      encoderPath: new URL('/_app/encoderWorker.min.js', location.href).href
    });
    out.usesWorklet = !!recorder.encoderNode || undefined;
    // Decoder: same construction as wabidbMediaRelay.getDecoderWorkerUrl().
    const decoderSource = await (await fetch('/_app/decoderWorker.min.js')).text();
    const wasmUrl = new URL('/_app/decoderWorker.min.wasm', location.href).href;
    const prelude = 'var Module={locateFile:function(path,prefix){' +
      "return path.endsWith('.wasm') ? " + JSON.stringify(wasmUrl) + ' : prefix + path;' +
      '}};';
    const workerUrl = URL.createObjectURL(new Blob([prelude + '\n' + decoderSource], { type: 'application/javascript' }));
    const worker = new Worker(workerUrl, { type: 'classic' });
    worker.onerror = (e) => errors.push('decoder worker: ' + (e.message || 'error'));
    await ctx.audioWorklet.addModule(new URL('/_app/audio-worklet-playback.js', location.href));
    const playback = new AudioWorkletNode(ctx, 'wabidb-audio-playback');
    playback.port.onmessage = ({ data }) => {
      if (data?.type === 'rendered' && data.samples > 0) {
        stats.renderedAcks++;
        stats.renderedSamples += data.samples;
      }
    };
    const panner = ctx.createStereoPanner();
    const gain = ctx.createGain();
    gain.gain.value = 0; // keep the test silent on the speakers
    playback.connect(panner);
    panner.connect(gain);
    gain.connect(ctx.destination);
    worker.onmessage = (e) => {
      if (!Array.isArray(e.data) || !e.data.length || !e.data.every((b) => b instanceof Float32Array)) return;
      stats.decoderMessages++;
      const buffers = e.data;
      const pcm = new Float32Array(buffers[0].length);
      for (const channel of buffers) for (let i = 0; i < pcm.length; i++) pcm[i] += (channel[i] ?? 0) / buffers.length;
      stats.decodedSamples += pcm.length;
      for (let i = 0; i < pcm.length; i++) {
        const v = Math.abs(pcm[i]);
        if (v > stats.decodedPeak) stats.decodedPeak = v;
      }
      playback.port.postMessage({ pcm });
    };
    worker.postMessage({ command: 'init', decoderSampleRate: 48000, outputBufferSampleRate: ctx.sampleRate, bufferLength: 960 });
    const extras = [];
    for (let n = 1; n < fanout; n++) {
      const w = new Worker(workerUrl, { type: 'classic' });
      const node = new AudioWorkletNode(ctx, 'wabidb-audio-playback');
      const g = ctx.createGain();
      g.gain.value = 0;
      node.connect(g);
      g.connect(ctx.destination);
      w.onmessage = (e) => {
        if (!Array.isArray(e.data) || !e.data.length) return;
        node.port.postMessage({ pcm: new Float32Array(e.data[0]) });
      };
      w.postMessage({ command: 'init', decoderSampleRate: 48000, outputBufferSampleRate: ctx.sampleRate, bufferLength: 960 });
      extras.push({ w, node });
    }
    recorder.ondataavailable = (page) => {
      if (stats.firstPageIsBOS === null) stats.firstPageIsBOS = page[0] === 0x4f && page[1] === 0x67 && (page[5] & 0x02) !== 0;
      stats.pages++;
      stats.pageBytes += page.length;
      worker.postMessage({ command: 'decode', pages: new Uint8Array(page) });
      for (const extra of extras) extra.w.postMessage({ command: 'decode', pages: new Uint8Array(page) });
    };
    try {
      await timeout(Promise.resolve(recorder.initialize), 10000, 'encoder initialize');
      out.initMs = Math.round(performance.now() - t0);
      await timeout(Promise.resolve(recorder.start()), 5000, 'recorder.start');
      await new Promise((r) => setTimeout(r, durationMs * 0.65));
      if (opts.onMid) await opts.onMid();
      await new Promise((r) => setTimeout(r, durationMs * 0.35));
    } catch (e) {
      errors.push(String((e && e.message) || e));
    }
    try {
      await timeout(Promise.resolve(recorder.close()), 3000, 'recorder.close');
    } catch (e) {
      errors.push('close: ' + String((e && e.message) || e));
    }
    try {
      source.disconnect();
      playback.disconnect();
    } catch {}
    worker.terminate();
    for (const extra of extras) {
      extra.w.terminate();
      try { extra.node.disconnect(); } catch {}
    }
    stats.decodedPeak = Math.round(stats.decodedPeak * 10000) / 10000;
    return { ...out, ...stats, errors };
  }

  async function relayLoop() {
    await step('env', () => ({ origin: location.origin, isSecureContext: window.isSecureContext }));
    await step('recorder_script', () => new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = '/_app/recorder.min.js';
      s.onload = () => res(typeof Recorder);
      s.onerror = () => rej(new Error('recorder script failed to load'));
      document.head.appendChild(s);
    }));
    let ctx = null;
    let mic = null;
    await step('capture_48k', async () => {
      // Constraints from mediaRuntime.getAudioCaptureConstraints (full DSP mode).
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000, channelCount: 1 }, video: false });
      ctx = new AudioContext({ sampleRate: 48000 }); // as audioCapture.ts / wabidbMediaRelay.ts
      await timeout(ctx.resume(), 4000, 'resume');
      return { contextState: ctx.state, contextSampleRate: ctx.sampleRate, track: trackInfo(mic.getAudioTracks()[0]) };
    }, 20000);
    if (ctx && mic) {
      await step('relay_mic', () => relayOnce(ctx, mic.getAudioTracks()[0], 'microphone'), 40000);
      await step('relay_tone', async () => {
        // A known 440 Hz tone at 0.5 amplitude through the same path proves fidelity, not just flow.
        const osc = ctx.createOscillator();
        const level = ctx.createGain();
        level.gain.value = 0.5;
        const dest = ctx.createMediaStreamDestination();
        osc.connect(level);
        level.connect(dest);
        osc.start();
        const result = await relayOnce(ctx, dest.stream.getAudioTracks()[0], 'tone 440Hz @0.5');
        osc.stop();
        return result;
      }, 40000);
      mic.getTracks().forEach((t) => t.stop());
      await ctx.close().catch(() => {});
    }
    post('done', R);
  }

  // Memory mode: ask the harness to sample process-tree memory at each stage.
  async function memMode() {
    const sample = async (label) => {
      post('sample', { label });
      await new Promise((r) => setTimeout(r, 1200));
    };
    await new Promise((r) => setTimeout(r, 6000));
    await sample('1 idle page');
    await new Promise((res, rej) => {
      const el = document.createElement('script');
      el.src = '/_app/recorder.min.js';
      el.onload = res;
      el.onerror = () => rej(new Error('recorder script failed'));
      document.head.appendChild(el);
    });
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, sampleRate: 48000, channelCount: 1 }, video: false });
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.resume();
    // Voice: one outgoing encoder, three remote speakers (decoder worker + playback node each).
    const ticker = (prefix) => {
      let t = 0;
      const id = setInterval(() => {
        t += 6;
        post('sample', { label: prefix + ' t=' + String(t).padStart(2, '0') + 's' });
      }, 6000);
      return () => clearInterval(id);
    };
    const stopVoiceTicker = ticker('2 voice (1 send, 3 receive)');
    R.voice = await relayOnce(ctx, mic.getAudioTracks()[0], 'voice, 3 remote speakers', {
      durationMs: 32000, fanout: 3, onMid: null
    });
    stopVoiceTicker();
    // Voice + video: add one 640x360 VP8 encode at 15 fps and two decoders drawing to canvases.
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const g = canvas.getContext('2d');
    const views = [0, 1].map(() => {
      const c = document.createElement('canvas');
      c.width = 640;
      c.height = 360;
      document.body.appendChild(c);
      return c.getContext('2d');
    });
    const video = { encoded: 0, decoded: 0, errors: [] };
    const decoders = views.map((view) => new VideoDecoder({
      output: (f) => {
        video.decoded++;
        view.drawImage(f, 0, 0, 640, 360);
        f.close();
      },
      error: (e) => video.errors.push('decoder: ' + e)
    }));
    let configured = false;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        video.encoded++;
        if (!configured) {
          for (const d of decoders) d.configure(meta?.decoderConfig ?? { codec: 'vp8', codedWidth: 640, codedHeight: 360 });
          configured = true;
        }
        for (const d of decoders) d.decode(chunk);
      },
      error: (e) => video.errors.push('encoder: ' + e)
    });
    encoder.configure({ codec: 'vp8', width: 640, height: 360, bitrate: 600000, framerate: 15, latencyMode: 'realtime' });
    let i = 0;
    const timer = setInterval(() => {
      g.fillStyle = 'hsl(' + ((i * 7) % 360) + ',70%,45%)';
      g.fillRect(0, 0, 640, 360);
      g.fillStyle = '#fff';
      g.fillRect((i * 9) % 560, 120, 80, 80);
      const frame = new VideoFrame(canvas, { timestamp: i * 66666 });
      encoder.encode(frame, { keyFrame: i % 60 === 0 });
      frame.close();
      i++;
    }, 66);
    const stopVideoTicker = ticker('3 voice+video (1 send, 2 receive)');
    R.voiceVideo = await relayOnce(ctx, mic.getAudioTracks()[0], 'voice + video', {
      durationMs: 44000, fanout: 3, onMid: null
    });
    stopVideoTicker();
    clearInterval(timer);
    try {
      encoder.close();
      decoders.forEach((d) => d.close());
    } catch {}
    R.video = video;
    mic.getTracks().forEach((t) => t.stop());
    await ctx.close().catch(() => {});
    await new Promise((r) => setTimeout(r, 6000));
    await sample('4 after call ended');
    post('done', R);
  }

  // What does a WebGL context cost in this engine?
  async function glMem() {
    const sample = async (label) => {
      post('sample', { label });
      await new Promise((r) => setTimeout(r, 1200));
    };
    await new Promise((r) => setTimeout(r, 6000));
    await sample('1 idle page');
    const small = document.createElement('canvas');
    small.width = 1;
    small.height = 1;
    window.__gl1 = small.getContext('webgl');
    R.small = !!window.__gl1;
    await new Promise((r) => setTimeout(r, 4000));
    await sample('2 + one 1x1 WebGL context (never drawn)');
    const big = document.createElement('canvas');
    big.width = 1200;
    big.height = 832;
    big.style.cssText = 'position:fixed;inset:0';
    document.body.appendChild(big);
    const gl = big.getContext('webgl2') || big.getContext('webgl');
    R.big = !!gl;
    let t = 0;
    (function frame() {
      t++;
      gl.clearColor((t % 100) / 100, 0.3, 0.6, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      requestAnimationFrame(frame);
    })();
    await new Promise((r) => setTimeout(r, 6000));
    await sample('3 + one animated 1200x832 WebGL canvas');
    post('done', R);
  }

  function stress() {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:0;top:0;width:120px;height:120px;background:linear-gradient(45deg,#e33,#33e);will-change:transform';
    document.body.appendChild(d);
    let t = 0;
    R.rafFrames = 0;
    (function frame() {
      t++;
      R.rafFrames = t;
      d.style.transform = 'translate(' + ((t * 5) % 480) + 'px,' + ((t * 3) % 320) + 'px) rotate(' + t + 'deg)';
      requestAnimationFrame(frame);
    })();
  }
  window.addEventListener('load', () => {
    if (params.get('stress') === '1') stress();
    if (MODE === 'gesture') gesture();
    else if (MODE === 'relay') relayLoop();
    else if (MODE === 'glmem') glMem();
    else if (MODE === 'mem') memMode().catch((e) => { R.memError = String(e && e.message || e); post('done', R); });
    else matrix();
  });
})();
