/**
 * wabiDB audio media relay — capture/playback pipeline via wabiDB call state.
 *
 * Capture: getUserMedia → opus-recorder WASM encoder → Socket.IO base64 emit
 * Receive: Socket.IO listen → jitter buffer → opus-recorder decoder → AudioWorklet playback
 *
 * IMPORTANT: payloads are base64 STRINGS, not binary. socketioxide's
 * `Data<serde_json::Value>` extractor silently drops binary attachments
 * (handler never fires); strings relay fine. See wabi-calling skill.
 */

import OpusRecorder from 'opus-recorder';
// Decoder worker + its sibling wasm, resolved through the bundler so the
// build actually ships them (see opus-assets.d.ts for the full story).
import decoderWorkerSource from 'opus-recorder/dist/decoderWorker.min.js?raw';
import decoderWasmUrl from 'opus-recorder/dist/decoderWorker.min.wasm?url';
import { parseWabidbMediaEnvelope, type WabidbVideoLane } from './wabidbVideoLane';
import { attachSessionSource, detachSession, ensureCallAudioGraph } from './callAudioGraph';

// Blob URL for the decoder worker. opus-recorder's decoderWorker.min.js is an
// Emscripten module whose FIRST line is `var Module=typeof Module!=="undefined"?Module:{}`.
// Prepending our own `var Module = { locateFile … }` makes the glue resolve
// `decoderWorker.min.wasm` at the Vite-emitted asset URL instead of a sibling
// file next to the hashed worker (which never exists → SPA-fallback HTML →
// "failed to match magic number" abort → zero decoded audio, the 2026-08-27
// no-audio field report). The URL is created once per page and intentionally
// never revoked (relays are created per call).
let decoderWorkerBlobUrl: string | null = null;

function getDecoderWorkerUrl(): string {
	if (!decoderWorkerBlobUrl) {
		const prelude =
			'var Module={locateFile:function(path,prefix){' +
			`return path.endsWith('.wasm') ? ${JSON.stringify(decoderWasmUrl)} : prefix + path;` +
			'}};';
		decoderWorkerBlobUrl = URL.createObjectURL(
			new Blob([prelude + '\n' + decoderWorkerSource], { type: 'application/javascript' })
		);
	}
	return decoderWorkerBlobUrl;
}

// addModule is per-AudioContext; the shared call graph registers the playback
// worklet once and every relay reuses it.
const contextsWithPlaybackModule = new WeakSet<AudioContext>();

// Socket.IO via socketioxide `Data<serde_json::Value>` silently DROPS binary
// attachments (they become `{"_placeholder":true,"num":0}` placeholders and the
// handler is never called). The proven storefwd path ships audio as a base64
// string (`audioBase64`) which survives the JSON extractor. Do the same here.
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000; // avoid stack overflow on large buffers
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Decoder worker does `new DataView(pages.buffer)` — it needs a typed array
// (which has `.buffer`), NOT a raw ArrayBuffer or plain JS array.
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export type WabidbMediaRelayKind = 'channel' | 'dm';

/** WO-1 smoke-remediation counters — surfaced in CallModal's Diag overlay. */
export interface WabidbMediaRelayDiagnostics {
  sessionId: string;
  isActive: boolean;
  captureEnabled: boolean;
  audioContextState: string | null;
  sentEnvelopes: number;
  recvEnvelopes: number;
  droppedSelfFilter: number;
  droppedSessionMismatch: number;
  decodeOk: number;
  decodeFail: number;
  playedChunks: number;
  /** 2026-08-27 wire-level counters feeding CallDebugPanel on this transport. */
  sentBytes: number;
  recvBytes: number;
  /** Inbound seq-gap estimate (audio envelopes); late reorders count once. */
  lostPackets: number;
  /** EMA of inter-arrival deviation (ms) — a stability proxy, not RFC3550. */
  jitterMs: number;
}

export interface WabidbMediaRelayConfig {
  sessionId: string;
  userId: string;
  socket: any; // Socket.IO client
  onError?: (err: Error) => void;
  /** Fired when inbound audio arrives from a user (speaking-ring feed). */
  onRemoteAudioActivity?: (fromUserId: string) => void;
  kind?: WabidbMediaRelayKind;
  peerStableUserId?: string;
  capture?: boolean;
  /**
   * Phase 2: id of this call's chain in the shared audio graph (defaults to
   * the wabidb session key). Callers pass the CallSessionManager session id
   * (channelId / direct:{peer}) so per-call volume and the session model
   * address the SAME chain.
   */
  audioSessionId?: string;
}

export function wabidbDmSessionKey(peerA: string, peerB: string): string {
  const [first, second] = [normalizeStableUserId(peerA), normalizeStableUserId(peerB)].sort();
  return `dm:${first}:${second}`;
}

// Deterministic session key for a voice CHANNEL / group call. All participants
// joining the same channel must derive the SAME key or they end up in separate
// wabidb sessions and audio never crosses (the random `session-{ts}-{rnd}`
// fallback per-participant was the F19 gap for channels — see wabi-calling).
export function wabidbChannelSessionKey(channelId: string): string {
  return `channel:${channelId.trim()}`;
}

export function resolveWabidbSessionKey(
  kind: WabidbMediaRelayKind | undefined,
  sessionId: string,
  userId: string,
  peerStableUserId?: string,
): string {
  if (kind === 'dm' && peerStableUserId) {
    return wabidbDmSessionKey(userId, peerStableUserId);
  }
  return sessionId;
}

function normalizeStableUserId(id: string): string {
  const trimmed = id.trim();
  if (/^\d+$/.test(trimmed)) return `user-${trimmed}`;
  return trimmed;
}

interface JitterEntry {
  data: Uint8Array;
  timestamp: number;
  fromUserId?: string;
}

export class WabidbMediaRelay {
  private sessionId: string;
  /** Chain id in the shared call audio graph (Phase 2 per-call volume). */
  private audioSessionId: string;
  private userId: string;
  private socket: any;
  private onError?: (err: Error) => void;
  private onRemoteAudioActivity?: (fromUserId: string) => void;
  private localStream: MediaStream | null = null;
  private opusRecorder: OpusRecorder | null = null;
  private audioContext: AudioContext | null = null;
  /** False when the context is the shared call graph's (never close it). */
  private ownsAudioContext = true;
  /**
   * Phase 3: ONE playback chain per REMOTE USER (worklet→panner→gain) so
   * each speaker can be spatially positioned independently — the old single
   * mixed worklet made per-user panning impossible for relayed audio.
   */
  private userPlaybackChains = new Map<string, {
    worklet: AudioWorkletNode;
    panner: StereoPannerNode;
    gain: GainNode;
    position: { x: number; y: number; z: number };
  }>();
  /**
   * Seats set for users who have not spoken yet (playback chains are lazy —
   * created on first decoded audio). Applied the moment the chain exists so
   * a pre-positioned speaker never pops in at dead-center.
   */
  private pendingPositions = new Map<string, { x: number; y: number; z: number }>();
  private jitterBuffer: JitterEntry[] = [];
  private opusDecoder: Worker | null = null;
  private pendingDecodeResolvers: Array<(pcm: Float32Array | null) => void> = [];
  private onIncomingMediaHandler: ((msg: any) => void) | null = null;
  private isActive = false;
  private captureEnabled = true;
  private jitterTargetMs = 80;
  private playbackTimer: number | null = null;
  private videoLane: WabidbVideoLane | null = null;
  private audioSeq = 0;
  private counters = {
    sentEnvelopes: 0,
    recvEnvelopes: 0,
    droppedSelfFilter: 0,
    droppedSessionMismatch: 0,
    decodeOk: 0,
    decodeFail: 0,
    playedChunks: 0,
    sentBytes: 0,
    recvBytes: 0,
    lostPackets: 0,
    jitterMs: 0
  };
  /** Last forwarded sequence number per remote user (audio gap detection). */
  private lastSeqByUser = new Map<string, number>();
  private lastArrivalMs = 0;
  private avgInterArrivalMs = 0;
  private firstRecvLogged = false;

  getDiagnostics(): WabidbMediaRelayDiagnostics {
    return {
      sessionId: this.sessionId,
      isActive: this.isActive,
      captureEnabled: this.captureEnabled,
      audioContextState: this.audioContext?.state ?? null,
      ...this.counters
    };
  }

  constructor(cfg: WabidbMediaRelayConfig) {
    this.sessionId = resolveWabidbSessionKey(cfg.kind, cfg.sessionId, cfg.userId, cfg.peerStableUserId);
    this.audioSessionId = cfg.audioSessionId ?? this.sessionId;
    this.userId = cfg.userId;
    this.socket = cfg.socket;
    this.onError = cfg.onError;
    this.onRemoteAudioActivity = cfg.onRemoteAudioActivity;
    this.captureEnabled = cfg.capture !== false;
  }

  async start(stream: MediaStream): Promise<void> {
    try {
      this.isActive = true;
      this.localStream = stream;

      // Phase 2: prefer the SHARED call audio graph — one AudioContext for
      // every relay, with per-session gain→panner→master chains (per-call
      // volume + spatialization). Nodes cannot cross contexts, so the worklet
      // must live in the shared context. Fallback (non-browser): own context.
      const sharedGraph = ensureCallAudioGraph();
      if (sharedGraph) {
        this.audioContext = sharedGraph.ctx;
        this.ownsAudioContext = false;
      } else {
        this.audioContext = new AudioContext({ sampleRate: 48000 });
        this.ownsAudioContext = true;
      }
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      if (this.captureEnabled) {
        await this.startCapture();
      }

      this.onIncomingMediaHandler = (msg: any) => {
        if (!msg) return;
        // Self-filter, socket-scoped (WO-1c): the server relays with
        // `.except(sender_socket)` AND stamps `senderSocket`, so a socket
        // never receives its own emissions. Filtering on userId here was
        // REDUNDANT for that case and WRONG for one account signed in on two
        // devices (each device dropped the other's audio as "self-echo" —
        // the 2026-08-26 smoke-test no-audio bug). Keep the userId check
        // only as a fallback for older servers that don't stamp senderSocket.
        const isSelf = msg.senderSocket
          ? msg.senderSocket === this.socket.id
          : msg.userId === this.userId;
        if (isSelf) {
          this.counters.droppedSelfFilter++;
          return;
        }
        if (msg.sessionId !== this.sessionId) {
          this.counters.droppedSessionMismatch++;
          return;
        }
        this.counters.recvEnvelopes++;
        if (!this.firstRecvLogged) {
          this.firstRecvLogged = true;
          console.info(
            `[WabidbMediaRelay] first audio/video envelope received (session=${this.sessionId}, from=${msg.userId})`
          );
        }
        // Video lanes ride on the same channel; route video envelopes to the
        // attached lane. The server forwards the whole envelope verbatim, and
        // `kind` defaults to 'audio' for legacy/compatible senders.
        const env = parseWabidbMediaEnvelope(msg);
        if (!env) return;
        // Wire-level accounting for every accepted envelope (audio + video).
        const now = performance.now();
        this.counters.recvBytes += Math.floor((env.payload?.length ?? 0) * 0.75);
        if (this.lastArrivalMs > 0) {
          const inter = now - this.lastArrivalMs;
          // EMA of the deviation from the running mean inter-arrival time —
          // a rough jitter/stability indicator for the debug panel.
          const dev = Math.abs(inter - this.avgInterArrivalMs);
          this.avgInterArrivalMs = this.avgInterArrivalMs
            ? this.avgInterArrivalMs * 0.9 + inter * 0.1
            : inter;
          this.counters.jitterMs = this.counters.jitterMs * 0.9 + dev * 0.1;
        }
        this.lastArrivalMs = now;
        if (env.kind === 'video') {
          this.videoLane?.handleRemoteEnvelope(msg);
          return;
        }
        if (env.seq > 0) { // 0 = legacy sender without seq — gaps unmeasurable
          const last = this.lastSeqByUser.get(env.userId);
          if (last != null && env.seq > last + 1) {
            this.counters.lostPackets += env.seq - last - 1;
          }
          if (last == null || env.seq > last) this.lastSeqByUser.set(env.userId, env.seq);
        }
        this.handleIncomingMedia(env.userId, env.payload);
      };
      this.socket.on('wabidb-media', this.onIncomingMediaHandler);

      this.startPlaybackLoop();

      console.log(`[WabidbMediaRelay] Started capture for session ${this.sessionId}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.onError?.(err);
      throw err;
    }
  }

  /**
   * Toggle outbound capture without touching the receive path. Used when the
   * transmit routing mode changes ("all listening channels" broadcast) or when
   * mute/deafen state should gate the wabidb relay like it gates WebRTC/LiveKit.
   */
  async setCapture(enabled: boolean): Promise<void> {
    if (this.captureEnabled === enabled) return;
    this.captureEnabled = enabled;
    if (!this.isActive) return;
    if (enabled && this.localStream && !this.opusRecorder) {
      await this.startCapture();
    } else if (!enabled && this.opusRecorder) {
      this.opusRecorder.stop();
      this.opusRecorder = null;
    }
  }

  /**
   * Attach the video lane so inbound `wabidb-media` video envelopes are routed
   * to it. The lane owns its own socket emit path for outbound frames; the
   * relay only forwards inbound video to it. A null argument detaches.
   */
  attachVideoLane(lane: WabidbVideoLane | null): void {
    this.videoLane = lane;
  }

  private async startCapture(): Promise<void> {
    if (!this.localStream || this.opusRecorder) return;
    this.opusRecorder = new OpusRecorder({
      encoderSampleRate: 48000,
      encoderChannels: 1,
      streamPages: true,
      numberOfChannels: 1,
      // Must point at the bundled worker URL. The library defaults to
      // "encoderWorker.min.js" at the site root, which the SPA fallback
      // serves as text/html → worker is killed (MIME mismatch) and the
      // media relay silently dies ("DOMException: The operation was
      // aborted"). Same pattern as the decoder worker below.
      encoderPath: new URL('opus-recorder/dist/encoderWorker.min.js', import.meta.url).href,
    });

      this.opusRecorder.ondataavailable = (data: ArrayBuffer) => {
        if (this.isActive && this.captureEnabled) {
          // Base64 string payload — raw ArrayBuffer binary is silently dropped
          // by the server's Data<serde_json::Value> extractor. The `kind`/
          // `seq` fields keep the envelope forward-compatible with the video
          // lane on the same channel; legacy receivers ignore them.
          this.socket.emit('wabidb-media', {
            sessionId: this.sessionId,
            userId: this.userId,
            kind: 'audio',
            seq: this.audioSeq++,
            payload: arrayBufferToBase64(data),
          });
          this.counters.sentEnvelopes++;
          this.counters.sentBytes += data.byteLength;
        }
      };

    await this.opusRecorder.start(this.localStream);
  }

  private handleIncomingMedia(fromUserId: string, opusPayload: string): void {
    // Decode base64 → Uint8Array. The decoder worker needs a typed array
    // (`new DataView(pages.buffer)`), not a raw ArrayBuffer.
    const bytes = base64ToUint8Array(opusPayload);
    this.jitterBuffer.push({ data: bytes, timestamp: Date.now(), fromUserId });

    if (this.jitterBuffer.length > 50) {
      this.jitterBuffer.splice(0, this.jitterBuffer.length - 50);
    }
    // Speaking-ring feed: notify the host app which user this audio belongs
    // to. The relay owns playback but not UI state; the callback bridges it.
    this.onRemoteAudioActivity?.(fromUserId);
  }

  private startPlaybackLoop(): void {
    if (this.playbackTimer != null) return;
    this.playbackTimer = window.setInterval(() => {
      this.drainJitterBuffer();
    }, 20);
  }

  private drainJitterBuffer(): void {
    if (!this.isActive || this.jitterBuffer.length === 0) return;

    const now = Date.now();
    while (this.jitterBuffer.length > 0) {
      const entry = this.jitterBuffer[0];
      const age = now - entry.timestamp;
      if (age >= this.jitterTargetMs) {
        this.jitterBuffer.shift();
        void this.decodeAndPlay(entry.fromUserId, entry.data);
      } else {
        break;
      }
    }
  }

  private async decodeAndPlay(fromUserId: string | undefined, opusPayload: Uint8Array): Promise<void> {
    try {
      if (!this.opusDecoder) {
        await this.initializeOpusDecoder();
      }
      const pcmData = await this.decodeOpus(opusPayload);
      if (pcmData) {
        this.counters.decodeOk++;
        await this.playbackViaAudioWorklet(fromUserId ?? 'unknown', pcmData);
      } else {
        // null = worker never answered (dead worker / wasm abort / timeout) —
        // count it as a failure so the Diag overlay shows dec=0 + fail>0
        // instead of a silent zero.
        this.counters.decodeFail++;
      }
    } catch (error) {
      this.counters.decodeFail++;
      console.error('[WabidbMediaRelay] decode/playback error:', error);
    }
  }

  private async initializeOpusDecoder(): Promise<void> {
    this.opusDecoder = new Worker(getDecoderWorkerUrl(), { type: 'classic' });
    this.opusDecoder.onerror = (e: ErrorEvent) => {
      // WO-1 spirit: a dead decoder worker means every decode times out with
      // NO other trace — make the failure loud instead of silently deaf.
      console.error('[WabidbMediaRelay] decoder worker error:', e.message ?? e);
    };
    this.opusDecoder.onmessage = (e: MessageEvent) => {
      if (e.data === null || e.data === undefined) {
        // Decoder flush signal in live mode; nothing to hand back.
        return;
      }
      const resolve = this.pendingDecodeResolvers.shift();
      if (!resolve) return;
      const buffers: Float32Array[] = e.data;
      resolve(this.mergeFloat32(buffers));
    };
    // opus-recorder v8 decoder worker requires an `init` command with the
    // decoder config before any `decode` command will produce output.
    this.opusDecoder.postMessage({
      command: 'init',
      decoderSampleRate: 48000,
      decoderChannels: 1,
      outputBufferLength: 4096,
    });
  }

  private mergeFloat32(buffers: Float32Array[]): Float32Array {
    if (buffers.length === 0) return new Float32Array(0);
    if (buffers.length === 1) return buffers[0];
    let total = 0;
    for (const b of buffers) total += b.length;
    const out = new Float32Array(total);
    let offset = 0;
    for (const b of buffers) {
      out.set(b, offset);
      offset += b.length;
    }
    return out;
  }

  private async decodeOpus(opusPayload: Uint8Array): Promise<Float32Array | null> {
    return new Promise((resolve) => {
      if (!this.opusDecoder) {
        resolve(null);
        return;
      }
      const timeout = window.setTimeout(() => {
        const idx = this.pendingDecodeResolvers.indexOf(resolve);
        if (idx !== -1) {
          this.pendingDecodeResolvers.splice(idx, 1);
          resolve(null);
        }
      }, 500);
      this.pendingDecodeResolvers.push((pcm) => {
        window.clearTimeout(timeout);
        resolve(pcm);
      });
      // opus-recorder v8 decoder worker expects `command: 'decode'` and the
      // opus pages under `pages`.
      this.opusDecoder!.postMessage({ command: 'decode', pages: opusPayload });
    });
  }

  private async playbackViaAudioWorklet(fromUserId: string, pcmData: Float32Array): Promise<void> {
    if (!this.audioContext) return;
    let chain = this.userPlaybackChains.get(fromUserId);
    if (!chain) {
      try {
        const workletUrl = new URL('./audio-worklet-playback.js', import.meta.url);
        // addModule is per-context; skip re-registration when the shared
        // graph context already has the module (multiple relays).
        if (!contextsWithPlaybackModule.has(this.audioContext)) {
          await this.audioContext.audioWorklet.addModule(workletUrl);
          contextsWithPlaybackModule.add(this.audioContext);
        }
        const worklet = new AudioWorkletNode(this.audioContext, 'wabidb-audio-playback');
        const panner = this.audioContext.createStereoPanner();
        const gain = this.audioContext.createGain();
        worklet.connect(panner);
        panner.connect(gain);
        // Phase 2/3: into the per-session chain (gain→panner→master), NOT the
        // raw destination — per-call volume + per-user spatialization.
        const attached = attachSessionSource(this.audioSessionId, gain);
        if (!attached) {
          gain.connect(this.audioContext.destination);
        }
        chain = { worklet, panner, gain, position: { x: 0, y: 0, z: 2 } };
        this.userPlaybackChains.set(fromUserId, chain);
        // Seat set before this user first spoke — apply it immediately.
        const pending = this.pendingPositions.get(fromUserId);
        if (pending) {
          this.pendingPositions.delete(fromUserId);
          chain.position = { ...pending };
          this.applyChainPosition(chain);
        }
      } catch (error) {
        console.error('[WabidbMediaRelay] Failed to load AudioWorklet:', error);
        return;
      }
    }
    chain.worklet.port.postMessage({ pcm: pcmData });
    this.counters.playedChunks++;
  }

  /** Ramp one chain's pan + distance attenuation to its stored position. */
  private applyChainPosition(chain: {
    panner: StereoPannerNode;
    gain: GainNode;
    position: { x: number; y: number; z: number };
  }): void {
    const now = this.audioContext?.currentTime ?? 0;
    try {
      const pan = Math.max(-1, Math.min(1, chain.position.x / 6));
      chain.panner.pan.cancelScheduledValues(now);
      chain.panner.pan.linearRampToValueAtTime(pan, now + 0.08);
      const distance = Math.sqrt(
        chain.position.x * chain.position.x + chain.position.z * chain.position.z
      );
      const attenuation = Math.max(0.45, Math.min(1, 1 - distance / 24));
      chain.gain.gain.cancelScheduledValues(now);
      chain.gain.gain.linearRampToValueAtTime(attenuation, now + 0.08);
    } catch {
      // chain already torn down
    }
  }

  /**
   * Phase 3: position one remote user in this relay's stereo field
   * (pan_distance semantics mirroring the spatial engine: pan from x,
   * distance attenuation from the x/z plane). Values are in the same
   * coordinate space as SpatialAudioEngine positions. Seats for users who
   * have not spoken yet are buffered and applied on chain creation.
   */
  setSpatialPosition(fromUserId: string, position: { x: number; y: number; z: number }): void {
    const chain = this.userPlaybackChains.get(fromUserId);
    if (!chain) {
      this.pendingPositions.set(fromUserId, { ...position });
      return;
    }
    chain.position = position;
    this.applyChainPosition(chain);
  }

  stop(): void {
    this.isActive = false;
    if (this.playbackTimer != null) {
      window.clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
    if (this.opusRecorder) {
      this.opusRecorder.stop();
      this.opusRecorder = null;
    }
    // Phase 3: tear down every per-user playback chain.
    for (const chain of this.userPlaybackChains.values()) {
      try {
        chain.worklet.disconnect();
        chain.panner.disconnect();
        chain.gain.disconnect();
      } catch {
        /* already detached */
      }
    }
    this.userPlaybackChains.clear();
    this.pendingPositions.clear();
    // Phase 2: the shared graph context serves every relay — only close one
    // we own. The session chain itself is disposed via detachSession.
    if (this.audioContext && this.ownsAudioContext) {
      this.audioContext.close();
    }
    this.audioContext = null;
    detachSession(this.audioSessionId);
    if (this.opusDecoder) {
      this.opusDecoder.terminate();
      this.opusDecoder = null;
    }
    this.jitterBuffer = [];
    if (this.videoLane) {
      this.videoLane.stopAll();
      this.videoLane = null;
    }
    if (this.onIncomingMediaHandler) {
      this.socket.off('wabidb-media', this.onIncomingMediaHandler);
      this.onIncomingMediaHandler = null;
    }
    console.log(`[WabidbMediaRelay] Stopped for session ${this.sessionId}`);
  }
}
