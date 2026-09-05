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
import { attachSessionSource, detachSession, ensureCallAudioGraph, resumeCallAudioGraph } from './callAudioGraph';

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

/**
 * True when `pages` contains an Ogg page with the BOS (beginning-of-stream)
 * header flag set — the page opus-recorder's decoder requires before it
 * allocates its buffers. Mirrors the worker's own check: "OggS" magic
 * followed by the header_type byte, bit 1 = BOS. Gates mid-stream pages we
 * can't decode anyway (a late join / reconnect that missed the sender's
 * header pages) so they drop with a counter instead of throwing
 * "this.decoderBuffer is undefined" inside the worker on every frame.
 */
export function oggHasBosPage(pages: Uint8Array): boolean {
	for (let i = 0; i + 6 <= pages.length; i++) {
		if (
			pages[i] === 0x4f &&
			pages[i + 1] === 0x67 &&
			pages[i + 2] === 0x67 &&
			pages[i + 3] === 0x53 &&
			(pages[i + 5] & 0x02) !== 0
		) {
			return true;
		}
	}
	return false;
}

// addModule is per-AudioContext; the shared call graph registers the playback
// worklet once and every relay reuses it.
const contextsWithPlaybackModule = new WeakSet<AudioContext>();
// Sticky failure latch for the playback worklet module. Without it a failed
// addModule() (e.g. CSP blocking the module URL) retried on EVERY incoming
// frame — hundreds of AbortErrors per call and zero audio. The load cannot
// heal within a page load (CSP is fixed per document), so latch and drop.
let playbackWorkletLoadFailed = false;

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
  /** Pages dropped because the sender's BOS header pages never arrived
   * (late join / reconnect race) — undecodable by contract, not lost wire. */
  droppedHeaderless: number;
  /** Envelopes that failed envelope parsing (shape mismatch / corruption). */
  droppedParseFail: number;
  /** Oldest jitter entries dropped by the 50-entry clamp under backlog. */
  droppedJitterOverflow: number;
}

export interface WabidbMediaRelayConfig {
  sessionId: string;
  userId: string;
  socket: any; // Socket.IO client
  onError?: (err: Error) => void;
  /** Fired when inbound audio arrives from a user (speaking-ring feed). */
  onRemoteAudioActivity?: (fromUserId: string) => void;
  /**
   * One-shot: fired once inbound audio has actually DECODED to PCM
   * (threshold below), i.e. this relay provably carries live voices — not
   * merely that its socket joined a room. The transport layer uses it to
   * retire a redundant p2p mesh only after the relay proves itself, so a
   * just-started (possibly one-sided) relay never kills working audio.
   */
  onFirstDecodedAudio?: () => void;
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
  private onFirstDecodedAudio?: () => void;
  private firstDecodedFired = false;
  private localStream: MediaStream | null = null;
  private opusRecorder: OpusRecorder | null = null;
  /** Screen-share audio encoder — a second, independent opus stream. */
  private screenOpusRecorder: OpusRecorder | null = null;
  private screenAudioSeq = 0;
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
  /**
   * One decoder worker per REMOTE sender (2026-09-03): Ogg streams are
   * per-sender — the old single shared decoder interleaved every talker's
   * pages into one stream state, corrupting all of them, and its shared
   * resolver queue misaligned whenever the 500ms timeout dropped an entry.
   */
  private userDecoders = new Map<string, {
    worker: Worker;
    resolvers: Array<(pcm: Float32Array | null) => void>;
  }>();
  /** Per-sender BOS-seen flag (gating in decodeAndPlay); survives worker recreation. */
  private streamSawBos = new Map<string, boolean>();
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
    jitterMs: 0,
    droppedHeaderless: 0,
    droppedParseFail: 0,
    droppedJitterOverflow: 0
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
    this.onFirstDecodedAudio = cfg.onFirstDecodedAudio;
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
        if (!env) {
          this.counters.droppedParseFail++;
          return;
        }
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
        // Screen-share audio (2026-09-04) is a SECOND opus stream from the
        // same sender. Key the whole audio path (seq accounting, jitter,
        // per-stream decoder, BOS gating) by a composite id so the two
        // streams never interleave; skip the speaking-ring feed — screen
        // sound is not the sharer talking.
        const isScreenAudio = env.source === 'screen';
        const streamKey = isScreenAudio ? `${env.userId}::screen` : env.userId;
        if (env.seq > 0) { // 0 = legacy sender without seq — gaps unmeasurable
          const last = this.lastSeqByUser.get(streamKey);
          if (last != null && env.seq > last + 1) {
            this.counters.lostPackets += env.seq - last - 1;
          }
          if (last == null || env.seq > last) this.lastSeqByUser.set(streamKey, env.seq);
        }
        this.handleIncomingMedia(streamKey, env.payload, !isScreenAudio);
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
    // Every encoder stream starts its header (BOS) pages at seq 0/1 — the
    // server caches seq≤1 audio envelopes per sender and replays them to
    // late joiners (media_reactions_signaling.rs), so the counter must
    // restart with each new stream.
    this.audioSeq = 0;
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

  // -- Screen-share audio (2026-09-04) --
  //
  // A second independent opus stream for system/screen audio captured with
  // the share. The mic encoder only ever sees the microphone stream and the
  // video lane is video-only, so without this lane the "share audio" track
  // was silently dropped on the wabidb transport (P2P carried it via
  // WebRTC). Deliberately NOT gated by mic mute: sharing a video with sound
  // while muted is normal usage. The envelope carries source:'screen' so
  // receivers route it to a separate decoder (composite stream key) instead
  // of the sharer's voice chain.

  async startScreenAudioCapture(screenStream: MediaStream): Promise<void> {
    if (!this.isActive) return;
    await this.stopScreenAudioCapture(); // idempotent restart on re-share
    const audioOnly = new MediaStream(
      screenStream.getAudioTracks().filter((t) => t.readyState === 'live' && t.enabled)
    );
    if (audioOnly.getAudioTracks().length === 0) return; // share without audio
    // Header pages at seq 0/1 — the server's stream-qualified header cache
    // convention (same as startCapture).
    this.screenAudioSeq = 0;
    this.screenOpusRecorder = new OpusRecorder({
      encoderSampleRate: 48000,
      encoderChannels: 1,
      streamPages: true,
      numberOfChannels: 1,
      encoderPath: new URL('opus-recorder/dist/encoderWorker.min.js', import.meta.url).href,
    });
    this.screenOpusRecorder.ondataavailable = (data: ArrayBuffer) => {
      if (!this.isActive || !this.screenOpusRecorder) return;
      this.socket.emit('wabidb-media', {
        sessionId: this.sessionId,
        userId: this.userId,
        kind: 'audio',
        source: 'screen',
        seq: this.screenAudioSeq++,
        payload: arrayBufferToBase64(data),
      });
      this.counters.sentEnvelopes++;
      this.counters.sentBytes += data.byteLength;
    };
    await this.screenOpusRecorder.start(audioOnly);
    console.log(`[WabidbMediaRelay] Screen-audio capture started for ${this.sessionId}`);
  }

  async stopScreenAudioCapture(): Promise<void> {
    if (!this.screenOpusRecorder) return;
    const recorder = this.screenOpusRecorder;
    this.screenOpusRecorder = null;
    try {
      recorder.stop();
    } catch {
      /* already stopping */
    }
  }

  private handleIncomingMedia(fromUserId: string, opusPayload: string, feedActivity = true): void {
    // Decode base64 → Uint8Array. The decoder worker needs a typed array
    // (`new DataView(pages.buffer)`), not a raw ArrayBuffer.
    const bytes = base64ToUint8Array(opusPayload);
    this.jitterBuffer.push({ data: bytes, timestamp: Date.now(), fromUserId });

    if (this.jitterBuffer.length > 50) {
      this.counters.droppedJitterOverflow += this.jitterBuffer.length - 50;
      this.jitterBuffer.splice(0, this.jitterBuffer.length - 50);
    }
    // Speaking-ring feed: notify the host app which user this audio belongs
    // to. The relay owns playback but not UI state; the callback bridges it.
    // Screen-share audio passes feedActivity=false — it is not the sharer
    // talking.
    if (feedActivity) this.onRemoteAudioActivity?.(fromUserId);
  }

  private startPlaybackLoop(): void {
    if (this.playbackTimer != null) return;
    this.playbackTimer = window.setInterval(() => {
      this.drainJitterBuffer();
    }, 20);
  }

  private lastResumeAttemptMs = 0;
  private resumeNoticeShown = false;

  /**
   * Autoplay policies suspend the AudioContext without a gesture (or after
   * the tab backgrounded) — a suspended graph plays nothing even when decode
   * is healthy. Throttled resume attempt from the drain tick; the one-time
   * console warning tells the user a click unlocks audio. Round 6.
   */
  private maybeResumeAudioContext(): void {
    if (!this.audioContext || this.audioContext.state !== 'suspended') return;
    const now = Date.now();
    if (now - this.lastResumeAttemptMs < 2000) return;
    this.lastResumeAttemptMs = now;
    const attempt = this.ownsAudioContext
      ? this.audioContext.resume().then(() => this.audioContext?.state === 'running')
      : resumeCallAudioGraph();
    void attempt
      .then((running) => {
        if (!running && !this.resumeNoticeShown) {
          this.resumeNoticeShown = true;
          console.warn(
            '[WabidbMediaRelay] AudioContext suspended by the browser — interact with the page to enable call audio'
          );
        }
      })
      .catch(() => {
        /* resume races with teardown */
      });
  }

  private drainJitterBuffer(): void {
    if (!this.isActive || this.jitterBuffer.length === 0) return;
    this.maybeResumeAudioContext();

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

  private async decodeAndPlay(fromUserId: string, opusPayload: Uint8Array): Promise<void> {
    try {
      // BOS gating: pages from a stream whose header pages never reached us
      // cannot decode (the worker only allocates on a BOS page) — drop them
      // with a counter instead of letting the worker throw per frame. The
      // server replays cached headers on room join, so this normally only
      // trips during the replay race or after a missed rejoin.
      if (!this.streamSawBos.get(fromUserId)) {
        if (oggHasBosPage(opusPayload)) {
          this.streamSawBos.set(fromUserId, true);
        } else {
          this.counters.droppedHeaderless++;
          return;
        }
      }
      const pcmData = await this.decodeOpus(fromUserId, opusPayload);
      if (pcmData) {
        this.counters.decodeOk++;
        // Inbound proof (one-shot, after a few chunks so a single blip can't
        // retire the fallback mesh): the relay demonstrably carries voices.
        if (!this.firstDecodedFired && this.counters.decodeOk >= 5) {
          this.firstDecodedFired = true;
          try {
            this.onFirstDecodedAudio?.();
          } catch { /* transport-layer concern, never break playback */ }
        }
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

  private initializeUserDecoder(userId: string): void {
    const worker = new Worker(getDecoderWorkerUrl(), { type: 'classic' });
    const state = {
      worker,
      resolvers: [] as Array<(pcm: Float32Array | null) => void>
    };
    worker.onerror = (e: ErrorEvent) => {
      // WO-1 spirit: a dead decoder worker means every decode times out with
      // NO other trace — make the failure loud instead of silently deaf.
      console.error(`[WabidbMediaRelay] decoder worker error (${userId}):`, e.message ?? e);
    };
    worker.onmessage = (e: MessageEvent) => {
      if (e.data === null || e.data === undefined) {
        // Decoder flush signal in live mode; nothing to hand back.
        return;
      }
      const resolve = state.resolvers.shift();
      if (!resolve) return;
      const buffers: Float32Array[] = e.data;
      resolve(this.mergeFloat32(buffers));
    };
    // opus-recorder v8 decoder worker requires an `init` command with the
    // decoder config before any `decode` command will produce output.
    worker.postMessage({
      command: 'init',
      decoderSampleRate: 48000,
      decoderChannels: 1,
      outputBufferLength: 4096,
    });
    this.userDecoders.set(userId, state);
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

  private async decodeOpus(fromUserId: string, opusPayload: Uint8Array): Promise<Float32Array | null> {
    return new Promise((resolve) => {
      if (!this.userDecoders.has(fromUserId)) {
        this.initializeUserDecoder(fromUserId);
      }
      const state = this.userDecoders.get(fromUserId);
      if (!state) {
        resolve(null);
        return;
      }
      const settle = (pcm: Float32Array | null) => {
        window.clearTimeout(timeout);
        resolve(pcm);
      };
      const timeout = window.setTimeout(() => {
        const idx = state.resolvers.indexOf(settle);
        if (idx !== -1) {
          state.resolvers.splice(idx, 1);
          resolve(null);
        }
      }, 500);
      state.resolvers.push(settle);
      // opus-recorder v8 decoder worker expects `command: 'decode'` and the
      // opus pages under `pages`.
      state.worker.postMessage({ command: 'decode', pages: opusPayload });
    });
  }

  private async playbackViaAudioWorklet(fromUserId: string, pcmData: Float32Array): Promise<void> {
    if (!this.audioContext || playbackWorkletLoadFailed) return;
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
        playbackWorkletLoadFailed = true;
        console.error(
          '[WabidbMediaRelay] Playback worklet unavailable for this page load — incoming audio will be dropped. ' +
            'Usual cause: CSP script-src blocking the worklet module URL (look for a blocked data:/blob: script).',
          error
        );
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
    void this.stopScreenAudioCapture();
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
    for (const state of this.userDecoders.values()) {
      for (const resolve of state.resolvers) resolve(null);
      state.worker.terminate();
    }
    this.userDecoders.clear();
    this.streamSawBos.clear();
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
