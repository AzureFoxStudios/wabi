import { browser } from '$app/environment';

type CallActionSound =
	| 'join'
	| 'leave'
	| 'mute'
	| 'unmute'
	| 'deafen'
	| 'undeafen';

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
	if (!browser) return null;
	if (audioContext) return audioContext;
	try {
		audioContext = new (window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)();
		return audioContext;
	} catch (error) {
		console.warn('[CallSounds] WebAudio unavailable:', error);
		return null;
	}
}

function playTone(
	ctx: AudioContext,
	frequency: number,
	durationMs: number,
	type: OscillatorType,
	gainValue: number,
	startOffsetSeconds: number = 0,
	destination: AudioNode | null = null
): void {
	const startTime = ctx.currentTime + startOffsetSeconds;
	const endTime = startTime + durationMs / 1000;

	const oscillator = ctx.createOscillator();
	const gain = ctx.createGain();

	oscillator.type = type;
	oscillator.frequency.setValueAtTime(frequency, startTime);
	gain.gain.setValueAtTime(0.0001, startTime);
	gain.gain.exponentialRampToValueAtTime(gainValue, startTime + 0.01);
	gain.gain.exponentialRampToValueAtTime(0.0001, endTime);

	oscillator.connect(gain);
	gain.connect(destination ?? ctx.destination);

	oscillator.start(startTime);
	oscillator.stop(endTime);
}

/**
 * Per-call attribution (Phase 2): with N concurrent calls the global
 * join/leave bleeps are indistinguishable. Each session gets a small pitch
 * offset (semitones up the scale), optional stereo pan, and a volume that
 * follows the session's own volume — so a join in the silenced call is
 * silent and a join in the focused call is front and center.
 */
export interface CallSoundOptions {
	/** Stable index of the session among connected calls (0 = focused/first). */
	sessionIndex?: number;
	/** 0..1 multiplier, usually the session volume / 100. */
	volumeScale?: number;
	/** -1..1 stereo pan for the session. */
	pan?: number;
}

export function playCallActionSound(action: CallActionSound, options?: CallSoundOptions): void {
	const ctx = getAudioContext();
	if (!ctx) return;

	void ctx.resume().catch(() => undefined);

	const semitoneShift = Math.max(-7, Math.min(7, (options?.sessionIndex ?? 0) * 1));
	const pitch = Math.pow(2, semitoneShift / 12);
	const volumeScale = Math.max(0, Math.min(1, options?.volumeScale ?? 1));

	// Route through a per-call pan node when attribution is requested.
	let destination: AudioNode | null = null;
	if (options?.pan !== undefined && typeof ctx.createStereoPanner === 'function') {
		const panner = ctx.createStereoPanner();
		panner.pan.value = Math.max(-1, Math.min(1, options.pan));
		panner.connect(ctx.destination);
		destination = panner;
	}

	const tone = (frequency: number, durationMs: number, type: OscillatorType, baseGain: number, offset = 0): void => {
		if (volumeScale <= 0) return;
		playTone(ctx, frequency * pitch, durationMs, type, baseGain * volumeScale, offset, destination);
	};

	switch (action) {
		case 'join':
			tone(720, 90, 'sine', 0.06, 0);
			tone(980, 110, 'sine', 0.06, 0.08);
			break;
		case 'leave':
			tone(700, 90, 'sine', 0.06, 0);
			tone(420, 130, 'sine', 0.06, 0.08);
			break;
		case 'mute':
			tone(420, 120, 'triangle', 0.06);
			break;
		case 'unmute':
			tone(620, 120, 'triangle', 0.06);
			break;
		case 'deafen':
			tone(300, 100, 'square', 0.045, 0);
			tone(230, 140, 'square', 0.04, 0.08);
			break;
		case 'undeafen':
			tone(340, 90, 'square', 0.045, 0);
			tone(520, 120, 'square', 0.04, 0.07);
			break;
	}
}
