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

export interface WabidbMediaRelayConfig {
  sessionId: string;
  userId: string;
  socket: any; // Socket.IO client
  onError?: (err: Error) => void;
  kind?: WabidbMediaRelayKind;
  peerStableUserId?: string;
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
}

export class WabidbMediaRelay {
  private sessionId: string;
  private userId: string;
  private socket: any;
  private onError?: (err: Error) => void;
  private localStream: MediaStream | null = null;
  private opusRecorder: OpusRecorder | null = null;
  private audioContext: AudioContext | null = null;
  private audioWorklet: AudioWorkletNode | null = null;
  private jitterBuffer: JitterEntry[] = [];
  private opusDecoder: Worker | null = null;
  private pendingDecodeResolvers: Array<(pcm: Float32Array | null) => void> = [];
  private onIncomingMediaHandler: ((msg: any) => void) | null = null;
  private isActive = false;
  private jitterTargetMs = 80;
  private playbackTimer: number | null = null;

  constructor(cfg: WabidbMediaRelayConfig) {
    this.sessionId = resolveWabidbSessionKey(cfg.kind, cfg.sessionId, cfg.userId, cfg.peerStableUserId);
    this.userId = cfg.userId;
    this.socket = cfg.socket;
    this.onError = cfg.onError;
  }

  async start(stream: MediaStream): Promise<void> {
    try {
      this.isActive = true;
      this.localStream = stream;

      this.audioContext = new AudioContext({ sampleRate: 48000 });
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

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
        if (this.isActive) {
          // Base64 string payload — raw ArrayBuffer binary is silently dropped
          // by the server's Data<serde_json::Value> extractor.
          this.socket.emit('wabidb-media', {
            sessionId: this.sessionId,
            userId: this.userId,
            payload: arrayBufferToBase64(data),
          });
        }
      };

      await this.opusRecorder.start(stream);

      this.onIncomingMediaHandler = (msg: any) => {
        if (msg.userId !== this.userId && msg.sessionId === this.sessionId) {
          this.handleIncomingMedia(msg.payload);
        }
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

  private handleIncomingMedia(opusPayload: string): void {
    // Decode base64 → Uint8Array. The decoder worker needs a typed array
    // (`new DataView(pages.buffer)`), not a raw ArrayBuffer.
    const bytes = base64ToUint8Array(opusPayload);
    this.jitterBuffer.push({ data: bytes, timestamp: Date.now() });

    if (this.jitterBuffer.length > 50) {
      this.jitterBuffer.splice(0, this.jitterBuffer.length - 50);
    }
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
        void this.decodeAndPlay(entry.data);
      } else {
        break;
      }
    }
  }

  private async decodeAndPlay(opusPayload: Uint8Array): Promise<void> {
    try {
      if (!this.opusDecoder) {
        await this.initializeOpusDecoder();
      }
      const pcmData = await this.decodeOpus(opusPayload);
      if (pcmData) {
        await this.playbackViaAudioWorklet(pcmData);
      }
    } catch (error) {
      console.error('[WabidbMediaRelay] decode/playback error:', error);
    }
  }

  private async initializeOpusDecoder(): Promise<void> {
    const workerUrl = new URL('opus-recorder/dist/decoderWorker.min.js', import.meta.url);
    this.opusDecoder = new Worker(workerUrl, { type: 'classic' });
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

  private async playbackViaAudioWorklet(pcmData: Float32Array): Promise<void> {
    if (!this.audioContext) return;
    if (!this.audioWorklet) {
      try {
        const workletUrl = new URL('./audio-worklet-playback.js', import.meta.url);
        await this.audioContext.audioWorklet.addModule(workletUrl);
        this.audioWorklet = new AudioWorkletNode(this.audioContext, 'wabidb-audio-playback');
        this.audioWorklet.connect(this.audioContext.destination);
      } catch (error) {
        console.error('[WabidbMediaRelay] Failed to load AudioWorklet:', error);
        return;
      }
    }
    this.audioWorklet.port.postMessage({ pcm: pcmData });
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
    if (this.audioWorklet) {
      this.audioWorklet.disconnect();
      this.audioWorklet = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    if (this.opusDecoder) {
      this.opusDecoder.terminate();
      this.opusDecoder = null;
    }
    this.jitterBuffer = [];
    if (this.onIncomingMediaHandler) {
      this.socket.off('wabidb-media', this.onIncomingMediaHandler);
      this.onIncomingMediaHandler = null;
    }
    console.log(`[WabidbMediaRelay] Stopped for session ${this.sessionId}`);
  }
}
