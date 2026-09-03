/**
 * Phase 2 calling overhaul — ONE shared audio graph for all call audio
 * (2026-08-25).
 *
 * Today every wabidb relay plays through its own AudioContext/AudioWorklet
 * straight to the speakers, so per-call volume is impossible and spatial
 * audio can never see relay audio. This module owns the single graph:
 *
 *   session input (GainNode, per-call volume)
 *     → StereoPanner (per-call pan; spatial engine swaps in PannerNode later)
 *     → master (GainNode)
 *     → destination
 *
 * Media producers (wabidb relay worklets, p2p MediaStreamSources) attach to
 * their session's input node. All functions are browser-only and no-op
 * outside the browser, so unit tests can import this module freely.
 */

// Browser guard without $app/environment — this module is imported (via the
// relay) from bun:test, which cannot resolve SvelteKit virtual modules.
const isBrowserAudioAvailable = (): boolean =>
	typeof window !== 'undefined' &&
	typeof (window as typeof window & { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext !== 'undefined';

interface SessionChain {
	input: GainNode;
	panner: StereoPannerNode | null;
	volume: number;
	pan: number;
}

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const chains = new Map<string, SessionChain>();

export interface CallAudioGraphHandle {
	ctx: AudioContext;
	master: GainNode;
}

/** Lazily create the shared context + master. Null outside the browser. */
export function ensureCallAudioGraph(): CallAudioGraphHandle | null {
	if (!isBrowserAudioAvailable()) return null;
	if (ctx && master) return { ctx, master };
	try {
		ctx =
			ctx ??
			new (window.AudioContext ||
				(window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!)({
				// The wabidb relay's opus decoder emits 48kHz PCM; the old
				// per-relay contexts were 48k — the shared one must match or
				// every relay's playback pitch-shifts.
				sampleRate: 48000
			});
		master = master ?? ctx.createGain();
		master.gain.value = 1;
		master.connect(ctx.destination);
		// Autoplay policies suspend contexts created without a user gesture
		// (or after backgrounding). Without state tracking the graph stays
		// suspended forever and relayed calls are silently deaf — so make
		// every transition visible (Round 6, 2026-09-03).
		ctx.onstatechange = () => {
			console.info(`[CallAudioGraph] AudioContext state: ${ctx?.state}`);
		};
		return { ctx, master };
	} catch (error) {
		console.warn('[CallAudioGraph] WebAudio unavailable:', error);
		return null;
	}
}

/**
 * Resume the shared context when it is suspended (autoplay policy). Safe
 * no-op when running or absent; resolves false when the browser refused the
 * resume (needs a user gesture) so callers can surface "click to enable
 * audio" once instead of guessing.
 */
export async function resumeCallAudioGraph(): Promise<boolean> {
	if (!ctx || ctx.state !== 'suspended') return true;
	try {
		await ctx.resume();
		// Widen through a local: TS keeps the earlier `state === 'suspended'`
		// narrowing across the await, which would flag the direct comparison.
		const state: string = ctx.state;
		return state === 'running';
	} catch (error) {
		console.warn('[CallAudioGraph] resume rejected (needs a user gesture):', error);
		return false;
	}
}

/**
 * Deafen's output gate for the relay transport (Round 6): every session
 * chain feeds `master`, so one gain ramp silences all relayed playback
 * without touching capture (deafen must not gate the mic — Discord
 * semantics; toggleDeafen handles the force-mute coupling instead).
 */
export function setGraphOutputMuted(muted: boolean): void {
	if (!ctx || !master) return;
	const target = muted ? 0 : 1;
	try {
		master.gain.setTargetAtTime(target, ctx.currentTime, 0.03);
	} catch {
		master.gain.value = target;
	}
}

/**
 * Recording tap: a MediaStreamDestination fed by the shared master bus. The
 * call recorder mixes this stream whenever remote audio rides the wabidb
 * relay (no per-peer MediaStreams exist there to record) — 2026-08-27.
 * Created lazily, never disconnected (a silent tap costs nothing).
 */
let recordTap: MediaStreamAudioDestinationNode | null = null;

export function getCallAudioGraphRecordStream(): MediaStream | null {
	const handle = ensureCallAudioGraph();
	if (!handle) return null;
	if (!recordTap) {
		try {
			recordTap = handle.ctx.createMediaStreamDestination();
			handle.master.connect(recordTap);
		} catch (error) {
			console.warn('[CallAudioGraph] record tap unavailable:', error);
			return null;
		}
	}
	return recordTap.stream;
}

function ensureChain(sessionId: string): SessionChain | null {
	const handle = ensureCallAudioGraph();
	if (!handle) return null;
	let chain = chains.get(sessionId);
	if (chain) return chain;
	const input = handle.ctx.createGain();
	input.gain.value = 1;
	let panner: StereoPannerNode | null = null;
	if (typeof handle.ctx.createStereoPanner === 'function') {
		panner = handle.ctx.createStereoPanner();
		panner.pan.value = 0;
		input.connect(panner);
		panner.connect(handle.master);
	} else {
		input.connect(handle.master);
	}
	chain = { input, panner, volume: 100, pan: 0 };
	chains.set(sessionId, chain);
	return chain;
}

/**
 * Attach a media producer (relay worklet node, MediaStreamAudioSourceNode)
 * to a session's input. The node is re-parented onto the shared graph.
 */
export function attachSessionSource(sessionId: string, node: AudioNode): boolean {
	const chain = ensureChain(sessionId);
	if (!chain) return false;
	try {
		node.connect(chain.input);
		return true;
	} catch (error) {
		console.warn(`[CallAudioGraph] attach failed for ${sessionId}:`, error);
		return false;
	}
}

/** 0..100 session volume → gain. */
export function setSessionVolume(sessionId: string, volume: number): void {
	const chain = chains.get(sessionId);
	if (!chain) return;
	const clamped = Math.max(0, Math.min(100, volume));
	chain.volume = clamped;
	const gain = clamped / 100;
	try {
		chain.input.gain.setTargetAtTime(gain, ctx?.currentTime ?? 0, 0.03);
	} catch {
		chain.input.gain.value = gain;
	}
}

/** -1..1 stereo pan for the whole session (per-call sound stage). */
export function setSessionPan(sessionId: string, pan: number): void {
	const chain = chains.get(sessionId);
	if (!chain?.panner) return;
	const clamped = Math.max(-1, Math.min(1, pan));
	chain.pan = clamped;
	try {
		chain.panner.pan.setTargetAtTime(clamped, ctx?.currentTime ?? 0, 0.03);
	} catch {
		chain.panner.pan.value = clamped;
	}
}

/** Detach and dispose a session chain (leave/end of that call). */
export function detachSession(sessionId: string): void {
	const chain = chains.get(sessionId);
	if (!chain) return;
	try {
		chain.input.disconnect();
		chain.panner?.disconnect();
	} catch {
		/* already detached */
	}
	chains.delete(sessionId);
}

export function detachAllSessions(): void {
	for (const id of [...chains.keys()]) detachSession(id);
}

export function callAudioGraphSessionCount(): number {
	return chains.size;
}
