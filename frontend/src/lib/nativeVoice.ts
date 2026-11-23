/**
 * Bridge to the desktop shell's native voice engine (`crates/wabi-voice`,
 * `src-tauri/src/voice.rs`). Linux desktop only.
 *
 * The page keeps call admission, signalling and the relay socket. In native
 * mode the engine captures and processes the microphone (echo cancellation,
 * noise suppression, gain control, which WebKitGTK does not have) and hands
 * back relay pages to send; received relay pages go to the engine to be
 * decoded, mixed and played. Nothing here runs unless the engine is switched
 * on, so every other platform keeps the web audio path untouched.
 *
 * Not carried over from the web path yet: per-user spatial position, the
 * call-recording tap, microphone and speaker choice from settings (the engine
 * uses the system defaults, or WABI_VOICE_SOURCE / WABI_VOICE_SINK).
 */
import { Channel, invoke } from '@tauri-apps/api/core';

/** Set to '1' to use the native engine, '0' to refuse it even when the shell asks. */
export const NATIVE_VOICE_STORAGE_KEY = 'wabi_native_voice';

const POLL_MS = 250;
/** Samples of one sender's microphone that must play before it counts as audible (500 ms). */
const READY_SAMPLES = 24000;
/** A ready sender with no playback progress for this long is no longer audible. */
const STALL_MS = 2000;
const SAMPLES_PER_CHUNK = 960;

type Capabilities = { available: boolean; requested: boolean; reason?: string | null };
type StreamStatus = {
	key: string; decodeOk: number; decodeFail: number; audibleChunks: number;
	playedSamples: number; droppedHeaderless: number; droppedOverflowSamples: number;
};
type Status = { capturing: boolean; playing: boolean; pagesSent: number; captureLevel: number; streams: StreamStatus[]; active: string[] };
type Page = { seq: number; payload: string };

let enabled: Promise<boolean> | null = null;

/** Whether calls on this page use the native engine. Decided once per page load. */
export function nativeVoiceEnabled(): Promise<boolean> {
	enabled ??= (async () => {
		// Checked directly so this module stays importable where `$app` is not.
		if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return false;
		let choice: string | null = null;
		try { choice = localStorage.getItem(NATIVE_VOICE_STORAGE_KEY); } catch { /* storage blocked */ }
		if (choice === '0') return false;
		try {
			const capabilities = await invoke<Capabilities>('voice_capabilities');
			return capabilities.available && (capabilities.requested || choice === '1');
		} catch {
			return false; // an older shell without the engine
		}
	})();
	return enabled;
}

/** Tests only. */
export function resetNativeVoiceForTests(): void {
	enabled = null;
	playbacks.clear();
	subscribers.clear();
	wantedStream = 0;
	engineStream = 0;
	captureQueue = Promise.resolve();
	outputMuted = false;
	sessionVolumes.clear();
	stopPolling();
	playbackStarted = null;
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

// -- Polling: counters, speaking activity, and the engine's sign of life ------
//
// The shell stops the microphone when polls stop arriving, so a hung or
// reloaded page cannot leave it open.

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastStatus: Status | null = null;

function ensurePolling(): void {
	if (pollTimer) return;
	pollTimer = setInterval(() => { void poll(); }, POLL_MS);
}

function stopPolling(): void {
	if (pollTimer) clearInterval(pollTimer);
	pollTimer = null;
}

async function poll(): Promise<void> {
	if (!playbacks.size && !subscribers.size) { stopPolling(); return; }
	let status: Status;
	try { status = await invoke<Status>('voice_poll'); } catch { return; }
	lastStatus = status;
	const now = Date.now();
	for (const playback of playbacks) playback.applyStatus(status, now);
}

/** Latest engine status, for diagnostics. */
export function nativeVoiceStatus(): Status | null {
	return lastStatus;
}

// -- Output state shared by every call ----------------------------------------

let outputMuted = false;
const sessionVolumes = new Map<string, number>();
let playbackStarted: Promise<void> | null = null;

function groupPrefix(audioSessionId: string): string {
	return `${audioSessionId}\u001f`;
}

/** Deafen. Mirrors `setGraphOutputMuted`; safe to call when the engine is off. */
export function setNativeOutputMuted(muted: boolean): void {
	outputMuted = muted;
	if (playbackStarted) void invoke('voice_set_deafened', { deafened: muted }).catch(() => undefined);
}

/** Per-call volume, 0 to 100. Mirrors `setSessionVolume`. */
export function setNativeSessionVolume(audioSessionId: string, volume: number): void {
	const clamped = Math.max(0, Math.min(100, volume));
	sessionVolumes.set(audioSessionId, clamped);
	if (playbackStarted) {
		void invoke('voice_set_group_volume', { prefix: groupPrefix(audioSessionId), volume: clamped / 100 }).catch(() => undefined);
	}
}

/** Closes the engine's streams once no call uses it, so an idle app holds no
 * playback stream open. */
function releaseEngineIfIdle(): void {
	if (playbacks.size || subscribers.size || !playbackStarted) return;
	playbackStarted = null;
	captureQueue = captureQueue.then(async () => {
		if (playbacks.size || subscribers.size) return; // a call started meanwhile
		engineStream = 0;
		await invoke('voice_shutdown');
	}).catch(() => undefined);
}

function ensurePlayback(): Promise<void> {
	playbackStarted ??= invoke<void>('voice_playback_start', { device: null }).then(async () => {
		await invoke('voice_set_deafened', { deafened: outputMuted });
		for (const [session, volume] of sessionVolumes) {
			await invoke('voice_set_group_volume', { prefix: groupPrefix(session), volume: volume / 100 });
		}
	});
	playbackStarted.catch(() => { playbackStarted = null; });
	return playbackStarted;
}

// -- Receiving ----------------------------------------------------------------

export interface NativeRelayPlaybackCallbacks {
	onRemoteAudioActivity?: (userId: string) => void;
	onRemoteAudioReady?: (userId: string) => void;
	onRemoteAudioUnavailable?: (userId: string) => void;
	onError?: (error: Error) => void;
	/** False while the relay's room is not usable; readiness is not granted then. */
	isRoomReady: () => boolean;
}

export interface NativePlaybackCounters {
	decodeOk: number; decodeFail: number; audibleChunks: number; playedChunks: number;
	droppedHeaderless: number; droppedJitterOverflow: number;
}

const playbacks = new Set<NativeRelayPlayback>();

/** One relay's received audio, decoded and played by the engine. */
export class NativeRelayPlayback {
	private readonly prefix: string;
	private readonly streams = new Map<string, { userId: string; screen: boolean; played: number; readyBase: number }>();
	private readonly readyUsers = new Set<string>();
	private readonly lastProgressAt = new Map<string, number>();
	private pushFailures = 0;
	private stopped = false;
	private latest: NativePlaybackCounters = { decodeOk: 0, decodeFail: 0, audibleChunks: 0, playedChunks: 0, droppedHeaderless: 0, droppedJitterOverflow: 0 };

	constructor(audioSessionId: string, private readonly callbacks: NativeRelayPlaybackCallbacks) {
		this.prefix = groupPrefix(audioSessionId);
		playbacks.add(this);
		ensurePolling();
		ensurePlayback().catch(error => callbacks.onError?.(error instanceof Error ? error : new Error(String(error))));
	}

	/** `payload` is the relay envelope's base64 field, unchanged. */
	push(key: string, payload: string, userId: string, screen: boolean): void {
		if (this.stopped) return;
		if (!this.streams.has(key)) this.streams.set(key, { userId, screen, played: 0, readyBase: 0 });
		invoke('voice_push', { stream: this.prefix + key, payload }).catch(error => {
			this.pushFailures++;
			if (this.pushFailures === 1) this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
		});
	}

	counters(): NativePlaybackCounters {
		return { ...this.latest, decodeFail: this.latest.decodeFail + this.pushFailures };
	}

	/** The room was lost: nobody is audible until audio plays again. */
	markAllUnavailable(): void {
		for (const user of [...this.readyUsers]) this.markUnavailable(user);
		for (const stream of this.streams.values()) stream.readyBase = stream.played;
	}

	private markUnavailable(user: string): void {
		if (!this.readyUsers.delete(user)) return;
		this.lastProgressAt.delete(user);
		this.callbacks.onRemoteAudioUnavailable?.(user);
	}

	applyStatus(status: Status, now: number): void {
		if (this.stopped) return;
		const totals: NativePlaybackCounters = { decodeOk: 0, decodeFail: 0, audibleChunks: 0, playedChunks: 0, droppedHeaderless: 0, droppedJitterOverflow: 0 };
		const roomReady = this.callbacks.isRoomReady();
		for (const stream of status.streams) {
			if (!stream.key.startsWith(this.prefix)) continue;
			totals.decodeOk += stream.decodeOk;
			totals.decodeFail += stream.decodeFail;
			totals.audibleChunks += stream.audibleChunks;
			totals.playedChunks += Math.floor(stream.playedSamples / SAMPLES_PER_CHUNK);
			totals.droppedHeaderless += stream.droppedHeaderless;
			totals.droppedJitterOverflow += Math.floor(stream.droppedOverflowSamples / SAMPLES_PER_CHUNK);
			const known = this.streams.get(stream.key.slice(this.prefix.length));
			if (!known || known.screen) continue;
			const progressed = stream.playedSamples > known.played;
			if (stream.playedSamples < known.played) known.readyBase = 0; // the engine restarted this stream
			known.played = stream.playedSamples;
			if (!progressed || !roomReady) continue;
			this.lastProgressAt.set(known.userId, now);
			if (!this.readyUsers.has(known.userId) && known.played - known.readyBase >= READY_SAMPLES) {
				this.readyUsers.add(known.userId);
				this.callbacks.onRemoteAudioReady?.(known.userId);
			}
		}
		this.latest = totals;
		for (const key of status.active) {
			if (!key.startsWith(this.prefix)) continue;
			const known = this.streams.get(key.slice(this.prefix.length));
			if (known && !known.screen) this.callbacks.onRemoteAudioActivity?.(known.userId);
		}
		for (const user of [...this.readyUsers]) {
			if (!roomReady || now - (this.lastProgressAt.get(user) ?? 0) > STALL_MS) {
				this.markUnavailable(user);
				for (const stream of this.streams.values()) if (stream.userId === user) stream.readyBase = stream.played;
			}
		}
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		playbacks.delete(this);
		for (const user of [...this.readyUsers]) this.markUnavailable(user);
		this.streams.clear();
		void invoke('voice_remove_group', { prefix: this.prefix }).catch(() => undefined);
		releaseEngineIfIdle();
	}
}

// -- Sending --------------------------------------------------------------------
//
// There is one microphone, so there is one engine capture shared by every
// relay that transmits. A relay that starts transmitting restarts the capture:
// each relay's listeners need the stream's header pages (envelopes 0 and 1),
// and only a new stream has them.

type Emit = (page: Uint8Array, seq: number) => void;
const subscribers = new Map<object, { emit: Emit; track: MediaStreamTrack }>();
/** Bumped whenever a new stream (fresh headers) is needed. */
let wantedStream = 0;
/** The stream the engine is capturing, or 0 when its microphone is closed. */
let engineStream = 0;
/** Start and stop reach the shell one at a time and in order, so a stop can
 * never be overtaken by the start it was meant to cancel. */
let captureQueue: Promise<void> = Promise.resolve();
let captureWatch: ReturnType<typeof setInterval> | null = null;

function microphoneOpen(): boolean {
	// A disabled or ended track is the page's mute: the engine must not capture.
	for (const { track } of subscribers.values()) if (track.readyState === 'live' && track.enabled) return true;
	return false;
}

/** Brings the engine's microphone in line with what the page wants now. */
function reconcileCapture(): Promise<void> {
	captureQueue = captureQueue.then(async () => {
		// Decided here, after everything queued earlier has finished.
		const target = microphoneOpen() ? wantedStream : 0;
		if (target === engineStream) return;
		if (target === 0) {
			engineStream = 0;
			await invoke('voice_capture_stop');
			return;
		}
		const channel = new Channel<Page>();
		channel.onmessage = page => {
			if (engineStream !== target) return; // a retired stream's page still in flight
			let bytes: Uint8Array | null = null;
			for (const { emit, track } of subscribers.values()) {
				if (track.readyState !== 'live' || !track.enabled) continue;
				bytes ??= base64ToBytes(page.payload);
				emit(bytes, page.seq);
			}
		};
		engineStream = target;
		try {
			await invoke('voice_capture_start', { device: null, onPage: channel });
		} catch (error) {
			engineStream = 0;
			throw error;
		}
	});
	const settled = captureQueue;
	captureQueue = captureQueue.catch(() => undefined);
	return settled;
}

function watchCapture(): void {
	if (captureWatch) return;
	captureWatch = setInterval(() => {
		if (!subscribers.size) {
			clearInterval(captureWatch!);
			captureWatch = null;
		}
		// Mute and unmute change only the track's `enabled` flag, with no event.
		if ((microphoneOpen() ? wantedStream : 0) !== engineStream) void reconcileCapture().catch(() => undefined);
	}, POLL_MS);
}

/** The engine's microphone as one relay's capture. Same contract as `RelayAudioCapture`. */
export class NativeRelayCapture {
	private current: MediaStreamTrack | null = null;

	/** `track` is the page's microphone track; only its live/enabled state is used. */
	async start(_context: AudioContext, track: MediaStreamTrack, emit: Emit): Promise<void> {
		if (this.current === track && subscribers.has(this)) return;
		this.stop();
		if (track.kind !== 'audio' || track.readyState !== 'live') return;
		this.current = track;
		subscribers.set(this, { emit, track });
		ensurePolling();
		watchCapture();
		wantedStream++; // this relay's listeners need the header pages
		await reconcileCapture();
	}

	stop(): void {
		this.current = null;
		if (!subscribers.delete(this)) return;
		void reconcileCapture().catch(() => undefined);
		releaseEngineIfIdle();
	}
}
