import type { CustomSynthWaveform } from '$lib/notifications';

export type CallRingtoneMode = 'classic-bell' | 'soft-chime' | 'pulse' | 'custom-synth' | 'custom-audio';

export const CALL_RINGTONE_OPTIONS: Array<{ value: CallRingtoneMode; label: string }> = [
	{ value: 'classic-bell', label: 'Classic Bell' },
	{ value: 'soft-chime', label: 'Soft Chime' },
	{ value: 'pulse', label: 'Pulse' },
	{ value: 'custom-synth', label: 'Custom Synth' },
	{ value: 'custom-audio', label: 'Custom Audio' }
];

export const CUSTOM_SYNTH_WAVEFORM_OPTIONS: Array<{ value: CustomSynthWaveform; label: string }> = [
	{ value: 'sine', label: 'Sine' },
	{ value: 'triangle', label: 'Triangle' },
	{ value: 'square', label: 'Square' },
	{ value: 'sawtooth', label: 'Sawtooth' }
];
