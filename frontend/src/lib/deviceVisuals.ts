export type DeviceVisual = 'headset' | 'microphone' | 'speaker' | 'camera';

/** A hint for scanning device lists. The real label remains the source of truth. */
export function deviceVisual(kind: MediaDeviceKind, label: string): DeviceVisual {
	if (kind === 'videoinput') return 'camera';
	if (/headset|headphone|earbud|airpod|buds\b/i.test(label)) return 'headset';
	if (kind === 'audiooutput') return 'speaker';
	return 'microphone';
}

export function deviceVisualSymbol(visual: DeviceVisual): string {
	return { headset: '🎧', microphone: '🎙', speaker: '🔊', camera: '📷' }[visual];
}
