/**
 * wabidbVideoLane.ts — VIDEO lane for the wabidb media relay.
 *
 * Layers WebCodecs video (camera + screenshare) onto the SAME socket.io
 * `wabidb-media` channel that carries audio. The server in
 * media_reactions_signaling.rs re-emits the WHOLE envelope verbatim
 * (`data.clone()`), so we can extend the envelope with `kind`/`seq`/chunk
 * metadata without touching any Rust. Receivers on old builds simply ignore
 * the unknown fields (and `kind` defaults to `'audio'` when absent).
 *
 * IMPORTANT: every frame is shipped as a BASE64 STRING inside `payload`.
 * socketioxide's `Data<serde_json::Value>` extractor silently drops binary
 * attachments, so ArrayBuffer/ArrayBufferView in the emit would never arrive.
 *
 * Design decisions:
 *  - Encoder: WebCodecs VideoEncoder. Prefer VP8 (software decode everywhere),
 *    fall back to VP9 / H.264 via VideoEncoder.isConfigSupported.
 *  - Frame source: draw the live MediaStream into an offscreen canvas at the
 *    target resolution, then `new VideoFrame(canvas, …)`. This avoids needing a
 *    track-derived frame source and lets the bandwidth guard re-scale cheaply.
 *  - Chunking: a single encoded frame may exceed a safe socket.io message size,
 *    so each frame is split into base64 chunks carrying (seq, chunkIndex,
 *    chunkCount). The receiver reassembles per (userId, seq) before decoding.
 *  - Receiver: per-user VideoDecoder → draw VideoFrame into a per-user <canvas>,
 *    then expose `canvas.captureStream()` as a MediaStream handle for UI tiles.
 *  - Bandwidth guard: measure sent bytes/s; if sustained over threshold, drop
 *    RESOLUTION first (reconfigure encoder), then fps. Keyframe after reconfig.
 */

import { writable } from 'svelte/store';

// ============================================================================
// Envelope types
// ============================================================================

export type WabidbMediaKind = 'audio' | 'video';

export interface WabidbMediaEnvelope {
  sessionId: string;
  userId: string;
  kind: WabidbMediaKind;
  seq: number;
  payload: string; // base64 — ALWAYS a string, never binary
  // Which outbound feed produced this video frame. Absent on audio, and
  // absent on video sent by pre-P1 senders (receiver treats those as camera).
  source?: WabidbVideoSource;
  // video-only chunking / metadata (absent for audio)
  chunkIndex?: number;
  chunkCount?: number;
  keyFrame?: boolean;
  codec?: string;
  width?: number;
  height?: number;
}

export type WabidbVideoSource = 'camera' | 'screen';

export interface WabidbVideoQualityStep {
  width: number;
  height: number;
  fps: number;
}

const VIDEO_CHUNK_RAW_BYTES = 16 * 1024; // 16 KiB raw → ~21 KiB base64

/**
 * Parse an incoming `wabidb-media` message into a normalized envelope.
 * Backward compatible: old audio senders emit `{ sessionId, userId, payload }`
 * (no `kind`) — we treat those as audio. Anything with `kind: 'video'` is
 * routed to the video path.
 */
export function parseWabidbMediaEnvelope(raw: any): WabidbMediaEnvelope | null {
  if (!raw || typeof raw !== 'object') return null;
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : '';
  const userId = typeof raw.userId === 'string' ? raw.userId : '';
  if (!sessionId || !userId) return null;

  const kind: WabidbMediaKind = raw.kind === 'video' ? 'video' : 'audio';
  const seq = typeof raw.seq === 'number' ? raw.seq : 0;
  const payload = typeof raw.payload === 'string' ? raw.payload : '';

  return {
    sessionId,
    userId,
    kind,
    seq,
    payload,
    source: raw.source === 'screen' ? 'screen' : raw.source === 'camera' ? 'camera' : undefined,
    chunkIndex: typeof raw.chunkIndex === 'number' ? raw.chunkIndex : undefined,
    chunkCount: typeof raw.chunkCount === 'number' ? raw.chunkCount : undefined,
    keyFrame: raw.keyFrame === true,
    codec: typeof raw.codec === 'string' ? raw.codec : undefined,
    width: typeof raw.width === 'number' ? raw.width : undefined,
    height: typeof raw.height === 'number' ? raw.height : undefined
  };
}

export function buildAudioEnvelope(
  sessionId: string,
  userId: string,
  payloadBase64: string,
  seq: number
): WabidbMediaEnvelope {
  return { sessionId, userId, kind: 'audio', seq, payload: payloadBase64 };
}

/**
 * Split a single encoded frame (raw bytes) into one-or-more base64 chunk
 * envelopes. `seq` is the frame index; chunkIndex/chunkCount let the receiver
 * reassemble. Metadata (codec/width/height/keyFrame) rides on EVERY chunk so
 * reassembly can configure the decoder as soon as the first chunk lands.
 */
export function splitFrameIntoChunks(
  sessionId: string,
  userId: string,
  seq: number,
  frameBytes: Uint8Array,
  meta: { codec: string; width: number; height: number; keyFrame: boolean; source?: WabidbVideoSource }
): WabidbMediaEnvelope[] {
  const total = frameBytes.length;
  const chunkCount = Math.max(1, Math.ceil(total / VIDEO_CHUNK_RAW_BYTES));
  const out: WabidbMediaEnvelope[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const start = i * VIDEO_CHUNK_RAW_BYTES;
    const end = Math.min(total, start + VIDEO_CHUNK_RAW_BYTES);
    const slice = frameBytes.subarray(start, end);
    out.push({
      sessionId,
      userId,
      kind: 'video',
      seq,
      payload: bytesToBase64(slice),
      source: meta.source,
      chunkIndex: i,
      chunkCount,
      keyFrame: meta.keyFrame,
      codec: meta.codec,
      width: meta.width,
      height: meta.height
    });
  }
  return out;
}

// Local base64 helpers (kept private to avoid clashing with the relay's).
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ============================================================================
// Reassembly buffer (receiver side)
// ============================================================================

/**
 * Collects video chunks keyed by (stableUserId, source, seq) and returns the
 * full frame bytes once every chunk has arrived (order-independent).
 */
export interface ReassembledFrame {
  frame: Uint8Array;
  codec: string;
  width: number;
  height: number;
  keyFrame: boolean;
  source: WabidbVideoSource;
}

/**
 * Stable stream key: `toStableUserKey(userId):source`. Absent source (video
 * from pre-P1 senders) defaults to 'camera' so old senders still render.
 */
export function videoStreamKey(rawUserId: string, source?: WabidbVideoSource): string {
  const stable = /^\d+$/.test(rawUserId) ? `user-${rawId(rawUserId)}` : rawUserId;
  return `${stable}:${source ?? 'camera'}`;
}

function rawId(userId: string): string { return userId; }

/** `user-2:screen` -> ['2', 'screen'] (raw form for reassembler.clearStream). */
export function splitStreamKey(key: string): [string, WabidbVideoSource | undefined] {
  const idx = key.lastIndexOf(':');
  const source = key.slice(idx + 1);
  const stable = key.slice(0, idx);
  return [stable.replace(/^user-/, ''), source === 'camera' || source === 'screen' ? source : undefined];
}

function stableUserPrefix(rawUserId: string): string {
  return /^\d+$/.test(rawUserId) ? `user-${rawUserId}` : rawUserId;
}

export class WabidbVideoReassembler {
  // `${stableUserId}:${source}` -> seq -> ChunkSet
  private byStream = new Map<string, Map<number, ChunkSet>>();

  push(env: WabidbMediaEnvelope): ReassembledFrame | null {
    if (env.kind !== 'video' || !env.payload) return null;
    const chunkCount = env.chunkCount ?? 1;
    const chunkIndex = env.chunkIndex ?? 0;
    const bytes = base64ToBytes(env.payload);
    const key = videoStreamKey(env.userId, env.source);

    let userMap = this.byStream.get(key);
    if (!userMap) {
      userMap = new Map();
      this.byStream.set(key, userMap);
    }
    let set = userMap.get(env.seq);
    if (!set) {
      set = {
        seq: env.seq,
        chunkCount,
        chunks: new Array(chunkCount).fill(null),
        codec: env.codec ?? '',
        width: env.width ?? 0,
        height: env.height ?? 0,
        keyFrame: env.keyFrame === true
      };
      userMap.set(env.seq, set);
    }
    if (set.chunks[chunkIndex] === null) {
      set.chunks[chunkIndex] = bytes;
    }
    if (set.chunks.every((c) => c !== null)) {
      const totalLen = set.chunks.reduce((n, c) => n + (c ? c.length : 0), 0);
      const frame = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of set.chunks) {
        if (!c) continue;
        frame.set(c, offset);
        offset += c.length;
      }
      userMap.delete(env.seq);
      return { frame, codec: set.codec, width: set.width, height: set.height, keyFrame: set.keyFrame, source: env.source ?? 'camera' };
    }
    return null;
  }

  clearStream(rawUserId: string, source?: WabidbVideoSource): void {
    this.byStream.delete(videoStreamKey(rawUserId, source));
  }

  /** Legacy name kept for compatibility — clears every source for the user. */
  clearUser(rawUserId: string): void {
    for (const key of Array.from(this.byStream.keys())) {
      if (key.startsWith(`${this.stableOf(rawUserId)}:`)) this.byStream.delete(key);
    }
  }

  private stableOf(rawUserId: string): string {
    return /^\d+$/.test(rawUserId) ? `user-${rawUserId}` : rawUserId;
  }
}

interface ChunkSet {
  seq: number;
  chunkCount: number;
  chunks: (Uint8Array | null)[];
  codec: string;
  width: number;
  height: number;
  keyFrame: boolean;
}

// ============================================================================
// Quality ladders + bandwidth guard
// ============================================================================

const CAMERA_LADDER: WabidbVideoQualityStep[] = [
  { width: 640, height: 360, fps: 24 },
  { width: 480, height: 270, fps: 24 },
  { width: 480, height: 270, fps: 15 },
  { width: 320, height: 180, fps: 12 }
];

// Screen ladder starts at 720p (not 1080p): every frame rides the shared
// socket.io connection as base64 JSON — the 2026-08-27 field test showed
// 1080p15 (~1.5 Mbps) saturating the client socket until the engine.io
// heartbeat missed ("transport close" → Wabidb reconnects → lag). 720p keeps
// text readable at a fraction of the envelope rate; the ladder still steps
// down under sustained overshoot.
const SCREEN_LADDER: WabidbVideoQualityStep[] = [
  { width: 1280, height: 720, fps: 12 },
  { width: 1280, height: 720, fps: 8 },
  { width: 854, height: 480, fps: 8 },
  { width: 640, height: 360, fps: 6 }
];

// Sustained bytes/sec ceilings per source. Exceeded → step DOWN the ladder.
// Screen ceiling lowered 1.5 → 0.9 Mbps for the same socket-health reason.
const BANDWIDTH_CEIL_BYTES_PER_SEC: Record<WabidbVideoSource, number> = {
  camera: (600 * 1000) / 8, // ~600 kbps
  screen: (900 * 1000) / 8 // ~900 kbps
};

// ============================================================================
// Feature detection
// ============================================================================

function hasWebCodecs(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    !!(globalThis as any).VideoEncoder &&
    !!(globalThis as any).VideoDecoder &&
    !!(globalThis as any).VideoFrame
  );
}

async function selectVideoConfig(
  width: number,
  height: number,
  fps: number
): Promise<{ codec: string; config: any } | null> {
  const candidates = ['vp8', 'vp09.00.10.08', 'avc1.42E01E', 'avc1.42001f'];
  const bitrate = Math.max(200_000, Math.floor((width * height * fps) / 12));
  for (const codec of candidates) {
    try {
      const VE = (globalThis as any).VideoEncoder;
      const support = await VE.isConfigSupported({
        codec,
        width,
        height,
        framerate: fps,
        bitrate
      });
      if (support && support.supported) {
        return {
          codec,
          config: {
            codec,
            width,
            height,
            framerate: fps,
            bitrate
          }
        };
      }
    } catch {
      // try next codec
    }
  }
  return null;
}

// ============================================================================
// Public store handles (exposed for UI tiles — not wired into components here)
// ============================================================================

/**
 * Remote video MediaStreams keyed by `videoStreamKey` (`stableUserId:source`,
 * e.g. "user-2:camera" / "user-3:screen"). Consumers must key through
 * videoStreamKey()/toStableUserKey() — never raw envelope ids.
 */
export const wabidbRemoteVideoStreams = writable<Map<string, MediaStream>>(new Map());

/** Whether the LOCAL user currently has any active wabidb outbound video. */
export const wabidbLocalVideoActive = writable<boolean>(false);

/**
 * Local preview streams keyed by source while the corresponding outbound feed
 * is live ('camera' and/or 'screen').
 */
export const wabidbLocalPreviewStreams = writable<Map<WabidbVideoSource, MediaStream>>(new Map());

export function setWabidbRemoteVideoStream(streamKey: string, stream: MediaStream | null): void {
  wabidbRemoteVideoStreams.update((m) => {
    const next = new Map(m);
    if (stream) next.set(streamKey, stream);
    else next.delete(streamKey);
    return next;
  });
}

// ============================================================================
// Video lane
// ============================================================================

export interface WabidbVideoLaneConfig {
  sessionId: string;
  userId: string;
  socket: any; // Socket.IO client
  onError?: (err: Error) => void;
}

/**
 * One independent outbound encoder pipeline for a single source (camera OR
 * screen). Owns its capture loop, encoder, quality ladder, and bandwidth
 * guard. Multiple LaneSenders can run concurrently inside one lane.
 */
class LaneSender {
  readonly source: WabidbVideoSource;
  private lane: WabidbVideoLane;
  private ladder: WabidbVideoQualityStep[];
  private qualityLevel = 0;

  private videoEl: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private canvasCtx: CanvasRenderingContext2D | null = null;
  private sourceStream: MediaStream | null = null;
  private encoder: any = null;
  private encoderConfig: any = null;
  private codec = 'vp8';
  private frameSeq = 0;
  private rafHandle: number | null = null;
  private rvfcHandle: number | null = null;
  private lastKeyFrameAt = 0;
  private forceKeyFrame = false;
  private active = false;

  // bandwidth guard
  private sentBytesLog: { t: number; n: number }[] = [];
  private overshootSince: number | null = null;

  // WO-2 diagnostics
  private framesEncoded = 0;
  private firstFrameLogged = false;

  private noteEncodeError(): void {
    const entry = (this.lane.diag.senders[this.source] ??= {
      framesEncoded: 0,
      envelopesSent: 0,
      encodeErrors: 0
    });
    entry.encodeErrors++;
  }

  constructor(source: WabidbVideoSource, lane: WabidbVideoLane) {
    this.source = source;
    this.lane = lane;
    this.ladder = source === 'camera' ? CAMERA_LADDER : SCREEN_LADDER;
  }

  get isActive(): boolean {
    return this.active;
  }

  async start(stream: MediaStream): Promise<void> {
    if (this.active) return;
    const step = this.ladder[0];
    const selected = await selectVideoConfig(step.width, step.height, step.fps);
    if (!selected) {
      throw new Error('No supported video codec for WebCodecs encoder');
    }
    this.codec = selected.codec;
    this.encoderConfig = selected.config;

    const VE = (globalThis as any).VideoEncoder;
    this.encoder = new VE({
      output: (chunk: any) => this.onEncodedChunk(chunk),
      error: (e: any) => {
        this.noteEncodeError();
        this.lane.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    });
    this.encoder.configure(this.encoderConfig);

    // Hidden <video> plays the source; we sample it into the canvas.
    if (typeof document !== 'undefined') {
      this.videoEl = document.createElement('video');
      this.videoEl.srcObject = stream;
      this.videoEl.muted = true;
      this.videoEl.playsInline = true;
      await this.videoEl.play().catch(() => undefined);

      this.canvas = document.createElement('canvas');
      this.canvas.width = step.width;
      this.canvas.height = step.height;
      this.canvasCtx = this.canvas.getContext('2d');
    }

    this.sourceStream = stream;
    this.frameSeq = 0;
    this.lastKeyFrameAt = 0;
    this.forceKeyFrame = true;
    this.active = true;
    this.startCaptureLoop();
  }

  private startCaptureLoop(): void {
    if (!this.videoEl || !this.canvas || !this.canvasCtx) return;
    const step = this.ladder[this.qualityLevel];

    const captureFrame = () => {
      if (!this.active || !this.videoEl || !this.canvas || !this.canvasCtx) return;
      const now = performance.now();
      // Periodic keyframe (~2s) for seekability / late joiners, plus forced
      // keyframes after an encoder reconfigure.
      const isKeyFrame = this.forceKeyFrame || now - this.lastKeyFrameAt > 2000;
      if (isKeyFrame) {
        this.forceKeyFrame = false;
        this.lastKeyFrameAt = now;
      }

      try {
        this.canvasCtx.drawImage(this.videoEl, 0, 0, this.canvas.width, this.canvas.height);
        const vf = new (globalThis as any).VideoFrame(this.canvas, {
          timestamp: this.frameSeq * Math.round(1_000_000 / step.fps),
          duration: Math.round(1_000_000 / step.fps)
        });
        this.encoder.encode(vf, { keyFrame: isKeyFrame });
        vf.close();
        this.framesEncoded++;
        const entry = (this.lane.diag.senders[this.source] ??= {
          framesEncoded: 0,
          envelopesSent: 0,
          encodeErrors: 0
        });
        entry.framesEncoded++;
        if (!this.firstFrameLogged) {
          this.firstFrameLogged = true;
          console.info(
            `[WabidbVideoLane] first encoded frame (source=${this.source}, codec=${this.codec}, ${this.canvas.width}x${this.canvas.height})`
          );
        }
      } catch (e) {
        this.noteEncodeError();
        this.lane.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
      this.frameSeq++;
      this.maybeGuardBandwidth();
    };

    // Prefer requestVideoFrameCallback for frame-accurate capture.
    const rvfc = (this.videoEl as any).requestVideoFrameCallback;
    if (typeof rvfc === 'function') {
      const tick = () => {
        if (!this.active) return;
        captureFrame();
        this.rvfcHandle = rvfc.call(this.videoEl!, tick);
      };
      this.rvfcHandle = rvfc.call(this.videoEl, tick);
    } else if (typeof requestAnimationFrame !== 'undefined') {
      const tick = () => {
        if (!this.active) return;
        captureFrame();
        this.rafHandle = requestAnimationFrame(tick);
      };
      this.rafHandle = requestAnimationFrame(tick);
    }
  }

  private onEncodedChunk(chunk: any): void {
    try {
      const buffer = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buffer);
      const step = this.ladder[this.qualityLevel];
      const meta = {
        codec: this.codec,
        width: this.canvas?.width ?? step.width,
        height: this.canvas?.height ?? step.height,
        keyFrame: chunk.type === 'key',
        source: this.source
      };
      const envelopes = splitFrameIntoChunks(
        this.lane.sessionId,
        this.lane.userId,
        this.lane.nextEmitSeq(),
        buffer,
        meta
      );
      for (const env of envelopes) {
        this.lane.socket.emit('wabidb-media', env);
      }
      const bytes = buffer.length + envelopes.length * 120; // payload + envelope overhead
      this.sentBytesLog.push({ t: performance.now(), n: bytes });
      const entry = (this.lane.diag.senders[this.source] ??= {
        framesEncoded: 0,
        envelopesSent: 0,
        encodeErrors: 0
      });
      entry.envelopesSent += envelopes.length;
    } catch (e) {
      this.noteEncodeError();
      this.lane.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private maybeGuardBandwidth(): void {
    const now = performance.now();
    // keep only the last 1s window
    this.sentBytesLog = this.sentBytesLog.filter((e) => now - e.t <= 1000);
    const sent = this.sentBytesLog.reduce((s, e) => s + e.n, 0);
    const ceil = BANDWIDTH_CEIL_BYTES_PER_SEC[this.source];
    if (sent > ceil) {
      if (this.overshootSince == null) this.overshootSince = now;
      // sustained overshoot > 2s → step down (resolution first, then fps)
      if (now - this.overshootSince > 2000 && this.qualityLevel < this.ladder.length - 1) {
        this.stepDownQuality();
        this.overshootSince = null;
      }
    } else {
      this.overshootSince = null;
    }
  }

  private stepDownQuality(): void {
    this.qualityLevel = Math.min(this.ladder.length - 1, this.qualityLevel + 1);
    const step = this.ladder[this.qualityLevel];
    if (this.canvas) {
      this.canvas.width = step.width;
      this.canvas.height = step.height;
    }
    // Reconfigure encoder at the new resolution/fps; force a keyframe after.
    const reselect = async () => {
      const selected = await selectVideoConfig(step.width, step.height, step.fps);
      if (!selected) return;
      this.codec = selected.codec;
      this.encoderConfig = selected.config;
      try {
        this.encoder.configure(this.encoderConfig);
        this.forceKeyFrame = true;
      } catch (e) {
        this.lane.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    };
    void reselect();
  }

  stop(): void {
    this.active = false;
    if (this.rvfcHandle != null && this.videoEl) {
      try {
        (this.videoEl as any).cancelVideoFrameCallback?.(this.rvfcHandle);
      } catch { /* noop */ }
      this.rvfcHandle = null;
    }
    if (this.rafHandle != null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.encoder) {
      try { this.encoder.close(); } catch { /* noop */ }
      this.encoder = null;
    }
    if (this.videoEl) {
      this.videoEl.srcObject = null;
      this.videoEl = null;
    }
    if (this.sourceStream) {
      this.sourceStream.getTracks().forEach((t) => t.stop());
      this.sourceStream = null;
    }
    this.canvas = null;
    this.canvasCtx = null;
  }
}

/** WO-2 smoke-remediation counters — surfaced in CallModal's Diag overlay.
 *  Formatting lives in callingWabidb (type-only import keeps the lane's
 *  guarded dynamic import intact). */
export interface WabidbVideoSourceDiagnostics {
  framesEncoded: number;
  envelopesSent: number;
  encodeErrors: number;
}

export interface WabidbVideoLaneDiagnostics {
  senders: Partial<Record<WabidbVideoSource, WabidbVideoSourceDiagnostics>>;
  receiver: { envelopesReceived: number; framesDecoded: number };
}

export class WabidbVideoLane {
  readonly sessionId: string;
  readonly userId: string;
  readonly socket: any;
  readonly onError?: (err: Error) => void;

  // Per-source outbound senders. P1: camera and screen run CONCURRENTLY as
  // independent encoder pipelines (the pre-P1 lane had a single `active`
  // flag, so whichever source started second silently lost).
  private senders = new Map<WabidbVideoSource, LaneSender>();
  private emitSeq = 0;

  /** WO-2 counters (senders keyed by source; receiver totals). */
  readonly diag: WabidbVideoLaneDiagnostics = {
    senders: {},
    receiver: { envelopesReceived: 0, framesDecoded: 0 }
  };

  // receiver side
  private reassembler = new WabidbVideoReassembler();
  private decoders = new Map<string, any>(); // videoStreamKey -> decoder
  private decoderConfigured = new Map<string, boolean>();
  private remoteCanvases = new Map<string, HTMLCanvasElement>(); // streamKey -> canvas
  private remoteCtx = new Map<string, CanvasRenderingContext2D>();
  private remoteStreams = new Map<string, MediaStream>(); // streamKey -> MediaStream
  private remoteLastFrameAt = new Map<string, number>();

  constructor(cfg: WabidbVideoLaneConfig) {
    this.sessionId = cfg.sessionId;
    this.userId = cfg.userId;
    this.socket = cfg.socket;
    this.onError = cfg.onError;
  }

  get isActive(): boolean {
    return this.senders.size > 0;
  }

  get activeSources(): WabidbVideoSource[] {
    return Array.from(this.senders.keys());
  }

  // --------------------------------------------------------------------------
  // Sender
  // --------------------------------------------------------------------------

  async startLocalVideo(source: WabidbVideoSource, stream: MediaStream): Promise<void> {
    if (!hasWebCodecs()) {
      const err = new Error('WebCodecs not available in this browser — video lane disabled');
      this.onError?.(err);
      throw err;
    }
    if (this.senders.get(source)?.isActive) return; // already live for this source

    const sender = new LaneSender(source, this);
    try {
      await sender.start(stream);
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
    this.senders.set(source, sender);
    wabidbLocalPreviewStreams.update((m) => {
      const next = new Map(m);
      next.set(source, stream);
      return next;
    });
    wabidbLocalVideoActive.set(true);
  }

  /** Stop exactly one outbound feed; the other keeps running. */
  stopLocalVideoSource(source: WabidbVideoSource): void {
    const sender = this.senders.get(source);
    if (!sender) return;
    sender.stop();
    this.senders.delete(source);
    wabidbLocalPreviewStreams.update((m) => {
      const next = new Map(m);
      next.delete(source);
      return next;
    });
    if (this.senders.size === 0) {
      wabidbLocalVideoActive.set(false);
    }
  }

  /** Compatibility: stop every outbound feed. */
  stopLocalVideo(): void {
    for (const source of Array.from(this.senders.keys())) {
      this.stopLocalVideoSource(source);
    }
  }

  /** Shared monotonic envelope sequence across all outbound sources. */
  nextEmitSeq(): number {
    return this.emitSeq++;
  }

  // --------------------------------------------------------------------------
  // Receiver
  // --------------------------------------------------------------------------

  /** Called by WabidbMediaRelay for every inbound `wabidb-media` message. */
  handleRemoteEnvelope(raw: any): void {
    const env = parseWabidbMediaEnvelope(raw);
    if (!env || env.kind !== 'video') return;
    // Socket-scoped self-filter (WO-1c) — the relay's handler already applied
    // its own check; this mirrors it so same-account two-device video flows
    // (userId equality is only a fallback for older servers).
    const isSelf = raw?.senderSocket
      ? raw.senderSocket === this.socket.id
      : env.userId === this.userId;
    if (isSelf) return;
    this.diag.receiver.envelopesReceived++;
    const reassembled = this.reassembler.push(env);
    if (reassembled) {
      void this.decodeRemoteFrame(videoStreamKey(env.userId, reassembled.source), reassembled);
    }
  }

  private async decodeRemoteFrame(
    streamKey: string,
    frame: ReassembledFrame
  ): Promise<void> {
    if (!hasWebCodecs()) return;
    let decoder = this.decoders.get(streamKey);
    const needConfig = !this.decoderConfigured.get(streamKey) && frame.codec;
    if (!decoder) {
      const VD = (globalThis as any).VideoDecoder;
      decoder = new VD({
        output: (vf: any) => this.onDecodedFrame(streamKey, vf),
        error: (e: any) => this.onError?.(e instanceof Error ? e : new Error(String(e)))
      });
      this.decoders.set(streamKey, decoder);
    }
    if (needConfig) {
      try {
        decoder.configure({ codec: frame.codec, width: frame.width || 640, height: frame.height || 360 });
        this.decoderConfigured.set(streamKey, true);
      } catch (e) {
        this.onError?.(e instanceof Error ? e : new Error(String(e)));
        return;
      }
    }
    try {
      const chunk = new (globalThis as any).EncodedVideoChunk({
        type: frame.keyFrame ? 'key' : 'delta',
        timestamp: (this.remoteLastFrameAt.get(streamKey) ?? 0),
        data: frame.frame
      });
      decoder.decode(chunk);
    } catch (e) {
      this.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private onDecodedFrame(streamKey: string, vf: any): void {
    this.diag.receiver.framesDecoded++;
    let canvas = this.remoteCanvases.get(streamKey);
    let ctx = this.remoteCtx.get(streamKey);
    if (!canvas && typeof document !== 'undefined') {
      canvas = document.createElement('canvas');
      const w = vf.codedWidth || 640;
      const h = vf.codedHeight || 360;
      canvas.width = w;
      canvas.height = h;
      ctx = canvas.getContext('2d');
      this.remoteCanvases.set(streamKey, canvas);
      this.remoteCtx.set(streamKey, ctx!);
      this.exposeRemoteStream(streamKey, canvas);
    }
    if (canvas && ctx) {
      try {
        ctx.drawImage(vf, 0, 0, canvas.width, canvas.height);
      } catch { /* noop */ }
    }
    try { vf.close(); } catch { /* noop */ }
    this.remoteLastFrameAt.set(streamKey, (this.remoteLastFrameAt.get(streamKey) ?? 0) + 1);
  }

  private exposeRemoteStream(streamKey: string, canvas: HTMLCanvasElement): void {
    let stream = this.remoteStreams.get(streamKey);
    if (!stream) {
      // 2026-08-27 round 5: ALWAYS capture the decode canvas. The previous
      // "lighter" path preferred a MediaStreamTrackGenerator on Chromium, but
      // its `writable` end was never connected to anything — the exposed track
      // received zero frames and every remote video tile rendered black on
      // Chrome/Edge (the 2026-08-26 "picked a window, nothing rendered" and
      // 2026-08-27 "call renders, screenshare doesn't" reports; Firefox lacks
      // the constructor, took this canvas path, and worked — hence "one-way").
      // onDecodedFrame paints every decoded frame into this canvas, so
      // captureStream(15) always carries live pixels.
      if (typeof (canvas as any).captureStream === 'function') {
        stream = (canvas as any).captureStream(15);
      }
      if (stream) {
        this.remoteStreams.set(streamKey, stream);
        setWabidbRemoteVideoStream(streamKey, stream);
      }
    }
  }

  /** Stop decoding/exposing one remote feed (`stableUserId` + optional source). */
  stopRemoteUser(rawUserId: string, source?: WabidbVideoSource): void {
    if (source) {
      const key = videoStreamKey(rawUserId, source);
      this.teardownRemoteStream(key);
      return;
    }
    for (const key of Array.from(this.decoders.keys())) {
      if (key.startsWith(`${stableUserPrefix(rawUserId)}:`)) this.teardownRemoteStream(key);
    }
  }

  private teardownRemoteStream(streamKey: string): void {
    const decoder = this.decoders.get(streamKey);
    if (decoder) {
      try { decoder.close(); } catch { /* noop */ }
      this.decoders.delete(streamKey);
    }
    this.decoderConfigured.delete(streamKey);
    this.reassembler.clearStream(...splitStreamKey(streamKey));
    this.remoteCanvases.delete(streamKey);
    this.remoteCtx.delete(streamKey);
    this.remoteLastFrameAt.delete(streamKey);
    const stream = this.remoteStreams.get(streamKey);
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      this.remoteStreams.delete(streamKey);
    }
    setWabidbRemoteVideoStream(streamKey, null);
  }

  stopAll(): void {
    this.stopLocalVideo();
    for (const streamKey of Array.from(this.decoders.keys())) {
      this.teardownRemoteStream(streamKey);
    }
  }
}

// Re-export for callers that need a base64 helper.
export { bytesToBase64, base64ToBytes };
