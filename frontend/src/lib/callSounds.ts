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

function playTone(ctx: AudioContext, frequency: number, durationMs: number, type: OscillatorType, gainValue: number, startOffsetSeconds: number = 0): void {
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
	gain.connect(ctx.destination);

	oscillator.start(startTime);
	oscillator.stop(endTime);
}

export function playCallActionSound(action: CallActionSound): void {
	const ctx = getAudioContext();
	if (!ctx) return;

	void ctx.resume().catch(() => undefined);

	switch (action) {
		case 'join':
			playTone(ctx, 720, 90, 'sine', 0.06, 0);
			playTone(ctx, 980, 110, 'sine', 0.06, 0.08);
			break;
		case 'leave':
			playTone(ctx, 700, 90, 'sine', 0.06, 0);
			playTone(ctx, 420, 130, 'sine', 0.06, 0.08);
			break;
		case 'mute':
			playTone(ctx, 420, 120, 'triangle', 0.06);
			break;
		case 'unmute':
			playTone(ctx, 620, 120, 'triangle', 0.06);
			break;
		case 'deafen':
			playTone(ctx, 300, 100, 'square', 0.045, 0);
			playTone(ctx, 230, 140, 'square', 0.04, 0.08);
			break;
		case 'undeafen':
			playTone(ctx, 340, 90, 'square', 0.045, 0);
			playTone(ctx, 520, 120, 'square', 0.04, 0.07);
			break;
	}
}
