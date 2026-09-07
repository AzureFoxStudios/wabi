/**
 * wabiDB audio media relay — capture/playback pipeline via wabiDB call state.
 *
 * Capture: borrowed processed microphone/display track → Opus → Socket.IO
 * Receive: Socket.IO → streaming decoder → bounded PCM → AudioWorklet
 *
 * IMPORTANT: payloads are base64 STRINGS, not binary. socketioxide's
 * `Data<serde_json::Value>` extractor silently drops binary attachments
 * (handler never fires); strings relay fine. See the audio integrity plan.
 */

import { RelayAudioCapture } from './relayAudioCapture';
// Decoder worker + its sibling wasm, resolved through the bundler so the
// build actually ships them (see opus-assets.d.ts for the full story).
import decoderWorkerSource from 'opus-recorder/dist/decoderWorker.min.js?raw';
import decoderWasmUrl from 'opus-recorder/dist/decoderWorker.min.wasm?url';
import { parseWabidbMediaEnvelope, type WabidbVideoLane } from './wabidbVideoLane';
import { attachSessionSource, ensureCallAudioGraph, resumeCallAudioGraph } from './callAudioGraph';

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
		// Blob workers have no useful relative base URL (also true in Tauri's
		// custom-protocol webview). Resolve the emitted wasm asset in the page.
		const wasmUrl = typeof location === 'undefined' ? decoderWasmUrl : new URL(decoderWasmUrl, location.href).href;
		const prelude =
			'var Module={locateFile:function(path,prefix){' +
			`return path.endsWith('.wasm') ? ${JSON.stringify(wasmUrl)} : prefix + path;` +
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
const contextsWithPlaybackModule = new WeakMap<AudioContext, Promise<void>>();
function loadPlaybackModule(context: AudioContext): Promise<void> {
  let load = contextsWithPlaybackModule.get(context);
  if (!load) {
    load = context.audioWorklet.addModule(new URL('./audio-worklet-playback.js', import.meta.url));
    contextsWithPlaybackModule.set(context, load);
  }
  // Cache rejection per context too: no retry storm on each received page.
  return load;
}

// Socket.IO via socketioxide `Data<serde_json::Value>` silently DROPS binary
// attachments (they become `{"_placeholder":true,"num":0}` placeholders and the
// handler is never called). The proven storefwd path ships audio as a base64
// string (`audioBase64`) which survives the JSON extractor. Do the same here.
function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
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
  /** Oldest decoded blocks discarded to bound playback backlog. */
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
   * Once per user after 500ms of microphone PCM is consumed by a running
   * playback worklet. Screen audio and other users cannot prime this gate.
   * Not proof of physical audibility or bidirectional reachability. The host
   * must validate current session/transport ownership. This selects a
   * receive path; it must NOT close a bidirectional fallback connection.
   */
  onRemoteAudioReady?: (userId: string) => void;
  onRemoteAudioUnavailable?: (userId: string) => void;
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

interface DecoderState {
  worker: Worker;
  pcm: Float32Array[];
  pendingSamples: number;
  draining: boolean;
  userId: string;
  screen: boolean;
}

export class WabidbMediaRelay {
  private sessionId: string;
  /** Chain id in the shared call audio graph (Phase 2 per-call volume). */
  private audioSessionId: string;
  private userId: string;
  private socket: any;
  private onError?: (err: Error) => void;
  private onRemoteAudioActivity?: (fromUserId: string) => void;
  private onRemoteAudioReady?: (userId: string) => void;
  private onRemoteAudioUnavailable?: (userId: string) => void;
  private renderedMicSamples = new Map<string, number>();
  private readyUsers = new Set<string>();
  private lastRenderedAt = new Map<string, number>();
  private localStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private roomReady = false;
  private onSocketDisconnect = () => { void this.setRoomReady(false); };
  private micCapture = new RelayAudioCapture();
  private screenCapture = new RelayAudioCapture();
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
  /**
   * One decoder worker per REMOTE sender (2026-09-03): Ogg streams are
   * per-sender — the old single shared decoder interleaved every talker's
   * pages into one stream state, corrupting all of them, and its shared
   * resolver queue misaligned whenever the 500ms timeout dropped an entry.
   */
  private userDecoders = new Map<string, DecoderState>();
  private onIncomingMediaHandler: ((msg: any) => void) | null = null;
  private isActive = false;
  private captureEnabled = true;
  private playbackTimer: number | null = null;
  private videoLane: WabidbVideoLane | null = null;
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

  isRoomReady(): boolean {
    return this.isActive && this.roomReady && this.socket.connected === true && this.audioContext?.state !== 'closed';
  }

  constructor(cfg: WabidbMediaRelayConfig) {
    this.sessionId = resolveWabidbSessionKey(cfg.kind, cfg.sessionId, cfg.userId, cfg.peerStableUserId);
    this.audioSessionId = cfg.audioSessionId ?? this.sessionId;
    this.userId = cfg.userId;
    this.socket = cfg.socket;
    this.onError = cfg.onError;
    this.onRemoteAudioActivity = cfg.onRemoteAudioActivity;
    this.onRemoteAudioReady = cfg.onRemoteAudioReady;
    this.onRemoteAudioUnavailable = cfg.onRemoteAudioUnavailable;
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
        // Autoplay can leave resume pending until the next gesture. Do not
        // block receive setup or the host's cancellation/gesture wiring on it.
        void this.audioContext.resume().catch(() => undefined);
      }
      await loadPlaybackModule(this.audioContext);
      if (!this.isActive) throw new Error('Relay start cancelled');

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
        const streamKey = JSON.stringify([env.userId, msg.senderSocket ?? '', isScreenAudio]);
        if (env.seq === 0) this.lastSeqByUser.delete(streamKey);
        if (env.seq > 0) { // 0 = legacy sender without seq — gaps unmeasurable
          const last = this.lastSeqByUser.get(streamKey);
          if (last != null && env.seq > last + 1) {
            this.counters.lostPackets += env.seq - last - 1;
          }
          if (last == null || env.seq > last) this.lastSeqByUser.set(streamKey, env.seq);
        }
        this.handleIncomingMedia(streamKey, env.payload, env.userId, isScreenAudio);
      };
      this.socket.on('wabidb-media', this.onIncomingMediaHandler);
      this.socket.on('disconnect', this.onSocketDisconnect);

      this.startPlaybackLoop();
      if (this.captureEnabled) await this.startCapture();

      if (!this.isActive) throw new Error('Relay start cancelled');
      console.log(`[WabidbMediaRelay] Started for session ${this.sessionId}`);
    } catch (error) {
      this.stop();
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
    this.captureEnabled = enabled;
    if (!this.isActive) return;
    if (enabled) {
      await this.startCapture();
    } else {
      this.micCapture.stop();
    }
  }

  /** Drop emission immediately on a socket flap; restart with fresh BOS
   * headers only after this connection has rejoined its authorized room. */
  async setRoomReady(ready: boolean): Promise<void> {
    this.roomReady = ready && this.isActive;
    if (!this.roomReady) {
      for (const user of this.readyUsers) this.markAudioUnavailable(user);
      this.micCapture.stop();
      this.screenCapture.stop();
      return;
    }
    await Promise.all([
      this.startCapture(),
      this.screenStream ? this.startScreenAudioCapture(this.screenStream) : Promise.resolve()
    ]);
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
    const track = this.localStream?.getAudioTracks().find(t => t.readyState === 'live');
    if (!this.isActive || !this.roomReady || !this.captureEnabled || !this.audioContext || !track) {
      this.micCapture.stop();
      return;
    }
    await this.micCapture.start(this.audioContext, track, (data, seq) => {
      if (this.captureEnabled) this.emitAudio(data, seq);
    });
  }

  private emitAudio(data: Uint8Array, seq: number, source?: 'screen'): void {
    if (!this.isActive || !this.roomReady || this.socket.connected === false) return;
    this.socket.emit('wabidb-media', {
      sessionId: this.sessionId, userId: this.userId, kind: 'audio',
      ...(source ? { source } : {}), seq, payload: arrayBufferToBase64(data)
    });
    this.counters.sentEnvelopes++;
    this.counters.sentBytes += data.byteLength;
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
    this.screenStream = screenStream;
    const track = screenStream.getAudioTracks().find(t => t.readyState === 'live' && t.enabled);
    if (!this.isActive || !this.roomReady || !this.audioContext || !track) {
      this.screenCapture.stop();
      return;
    }
    await this.screenCapture.start(this.audioContext, track, (data, seq) => this.emitAudio(data, seq, 'screen'));
  }

  async stopScreenAudioCapture(): Promise<void> {
    this.screenStream = null;
    this.screenCapture.stop();
  }

  private handleIncomingMedia(key: string, payload: string, userId: string, screen: boolean): void {
    if (!this.isActive) return;
    try {
      const pages = base64ToUint8Array(payload);
      let state = this.userDecoders.get(key);
      if (oggHasBosPage(pages)) {
        // Every encoder restart creates a new stream. Ignore late messages
        // from the retired worker and discard PCM from the previous stream.
        state?.worker.terminate();
        this.renderedMicSamples.delete(key);
        this.userPlaybackChains.get(key)?.worklet.port.postMessage({ type: 'reset' });
        state = this.initializeUserDecoder(key, userId, screen);
      }
      if (!state) { this.counters.droppedHeaderless++; return; }
      state.worker.postMessage({ command: 'decode', pages });
    } catch (error) {
      this.counters.decodeFail++;
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private startPlaybackLoop(): void {
    if (this.playbackTimer != null) return;
    this.playbackTimer = window.setInterval(() => {
      this.maybeResumeAudioContext();
      this.checkPlaybackHealth();
    }, 20);
  }

  private checkPlaybackHealth(): void {
    for (const user of this.readyUsers) {
      if (!this.isRoomReady() || this.audioContext?.state !== 'running' || Date.now() - (this.lastRenderedAt.get(user) ?? 0) > 2000) {
        this.markAudioUnavailable(user);
      }
    }
  }

  private markAudioUnavailable(user: string): void {
    if (!this.readyUsers.delete(user)) return;
    this.lastRenderedAt.delete(user);
    for (const [key, decoder] of this.userDecoders) {
      if (decoder.userId === user) this.renderedMicSamples.delete(key);
    }
    this.onRemoteAudioUnavailable?.(normalizeStableUserId(user));
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

  private initializeUserDecoder(key: string, userId: string, screen: boolean): DecoderState {
    const worker = new Worker(getDecoderWorkerUrl(), { type: 'classic' });
    const state: DecoderState = { worker, pcm: [], pendingSamples: 0, draining: false, userId, screen };
    this.userDecoders.set(key, state);
    worker.onerror = (e: ErrorEvent) => {
      if (this.userDecoders.get(key) !== state) return;
      this.counters.decodeFail++;
      worker.terminate();
      this.userDecoders.delete(key);
      this.markAudioUnavailable(userId);
      this.onError?.(new Error(`Relay decoder failed: ${e.message}`));
    };
    worker.onmessage = (e: MessageEvent) => {
      if (!this.isActive || this.userDecoders.get(key) !== state || e.data == null) return;
      // The worker is a STREAM, not RPC: header pages produce no message,
      // audio pages can produce many. Every output goes to the PCM queue.
      if (!Array.isArray(e.data) || !e.data.length || !e.data.every(b => b instanceof Float32Array)) return;
      const buffers: Float32Array[] = e.data;
      const pcm = new Float32Array(buffers[0].length);
      for (const channel of buffers) {
        for (let i = 0; i < pcm.length; i++) pcm[i] += (channel[i] ?? 0) / buffers.length;
      }
      this.counters.decodeOk++;
      if (!screen && pcm.some(sample => Math.abs(sample) > 0.01)) this.onRemoteAudioActivity?.(userId);
      state.pcm.push(pcm);
      state.pendingSamples += pcm.length;
      const limit = (this.audioContext?.sampleRate ?? 48000) / 2;
      while (state.pendingSamples > limit && state.pcm.length > 1) {
        state.pendingSamples -= state.pcm.shift()!.length;
        this.counters.droppedJitterOverflow++;
      }
      void this.drainDecodedAudio(key, state);
    };
    // opus-recorder v8 decoder worker requires an `init` command with the
    // decoder config before any `decode` command will produce output.
    worker.postMessage({
      command: 'init',
      decoderSampleRate: 48000,
      outputBufferSampleRate: this.audioContext?.sampleRate ?? 48000,
      bufferLength: 960,
    });
    return state;
  }

  private async drainDecodedAudio(key: string, state: DecoderState): Promise<void> {
    if (state.draining) return;
    state.draining = true;
    try {
      while (this.isActive && this.userDecoders.get(key) === state && state.pcm.length) {
        const pcm = state.pcm.shift()!;
        state.pendingSamples -= pcm.length;
        await this.playbackViaAudioWorklet(key, pcm, state);
      }
    } catch (error) {
      this.counters.decodeFail++;
      state.pcm = [];
      state.pendingSamples = 0;
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally { state.draining = false; }
  }

  private async playbackViaAudioWorklet(fromUserId: string, pcmData: Float32Array, decoder: DecoderState): Promise<void> {
    if (!this.audioContext || !this.isActive) return;
    let chain = this.userPlaybackChains.get(fromUserId);
    if (!chain) {
      try {
        // addModule is per-context; skip re-registration when the shared
        // graph context already has the module (multiple relays).
        const context = this.audioContext;
        await loadPlaybackModule(context);
        if (!this.isActive || this.audioContext !== context || this.userDecoders.get(fromUserId) !== decoder) return;
        const worklet = new AudioWorkletNode(this.audioContext, 'wabidb-audio-playback');
        worklet.port.onmessage = ({ data }) => {
          if (!this.isActive || this.userPlaybackChains.get(fromUserId)?.worklet !== worklet) return;
          if (data?.type !== 'rendered' || !Number.isFinite(data.samples) || !(data.samples > 0)) return;
          this.counters.playedChunks++;
          if (!decoder.screen && context.state === 'running' && this.isRoomReady()) this.lastRenderedAt.set(decoder.userId, Date.now());
          if (!decoder.screen && !this.readyUsers.has(decoder.userId) && context.state === 'running' && this.isRoomReady()) {
            const samples = (this.renderedMicSamples.get(fromUserId) ?? 0) + data.samples;
            this.renderedMicSamples.set(fromUserId, samples);
            if (samples >= context.sampleRate / 2) {
              this.readyUsers.add(decoder.userId);
              this.onRemoteAudioReady?.(normalizeStableUserId(decoder.userId));
            }
          }
        };
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
        const pending = !decoder.screen ? this.pendingPositions.get(decoder.userId) : undefined;
        if (pending) {
          chain.position = { ...pending };
          this.applyChainPosition(chain);
        }
      } catch (error) {
        console.error(
          '[WabidbMediaRelay] Playback worklet unavailable for this page load — incoming audio will be dropped. ' +
            'Usual cause: CSP script-src blocking the worklet module URL (look for a blocked data:/blob: script).',
          error
        );
        throw error;
      }
    }
    if (this.isActive && this.userDecoders.get(fromUserId) === decoder) chain.worklet.port.postMessage({ pcm: pcmData });
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
    this.pendingPositions.set(fromUserId, { ...position });
    for (const [key, decoder] of this.userDecoders) {
      if (decoder.userId !== fromUserId || decoder.screen) continue;
      const chain = this.userPlaybackChains.get(key);
      if (chain) { chain.position = position; this.applyChainPosition(chain); }
    }
  }

  stop(): void {
    this.isActive = false;
    for (const user of this.readyUsers) this.markAudioUnavailable(user);
    this.renderedMicSamples.clear();
    this.lastRenderedAt.clear();
    this.localStream = null;
    this.screenStream = null;
    this.roomReady = false;
    this.socket.off('disconnect', this.onSocketDisconnect);
    if (this.playbackTimer != null) {
      window.clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
    this.micCapture.stop();
    this.screenCapture.stop();
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
    // Session gain/volume belongs to the host session manager. Destroying
    // it here would also disconnect a still-live fallback or replacement.
    for (const state of this.userDecoders.values()) {
      state.worker.terminate();
    }
    this.userDecoders.clear();
    this.lastSeqByUser.clear();
    if (this.videoLane) {
      // The host owns the shared video lane, not an individual relay.
      this.videoLane = null;
    }
    if (this.onIncomingMediaHandler) {
      this.socket.off('wabidb-media', this.onIncomingMediaHandler);
      this.onIncomingMediaHandler = null;
    }
    console.log(`[WabidbMediaRelay] Stopped for session ${this.sessionId}`);
  }
}
