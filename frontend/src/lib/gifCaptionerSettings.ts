import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';

export type GifCaptionStylePreset = 'plain' | 'accent' | 'card';

export interface GifCaptionerSettings {
	enabled: boolean;
	dedicatedCaptionFieldEnabled: boolean;
	captionStyle: GifCaptionStylePreset;
}

const GIF_CAPTIONER_SETTINGS_KEY = 'wabi.gifCaptioner.settings';

const DEFAULT_GIF_CAPTIONER_SETTINGS: GifCaptionerSettings = {
	enabled: true,
	dedicatedCaptionFieldEnabled: false,
	captionStyle: 'plain'
};

function sanitizeCaptionStyle(value: unknown): GifCaptionStylePreset {
	if (value === 'accent') return 'accent';
	if (value === 'card') return 'card';
	return 'plain';
}

function sanitizeGifCaptionerSettings(
	input: Partial<GifCaptionerSettings> | null | undefined
): GifCaptionerSettings {
	return {
		enabled: input?.enabled !== false,
		dedicatedCaptionFieldEnabled: input?.dedicatedCaptionFieldEnabled === true,
		captionStyle: sanitizeCaptionStyle(input?.captionStyle)
	};
}

function safeReadGifCaptionerSettings(): GifCaptionerSettings {
	if (!browser) return { ...DEFAULT_GIF_CAPTIONER_SETTINGS };
	try {
		const raw = localStorage.getItem(GIF_CAPTIONER_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_GIF_CAPTIONER_SETTINGS };
		const parsed = JSON.parse(raw) as Partial<GifCaptionerSettings>;
		return sanitizeGifCaptionerSettings(parsed);
	} catch {
		return { ...DEFAULT_GIF_CAPTIONER_SETTINGS };
	}
}

function safeWriteGifCaptionerSettings(value: GifCaptionerSettings): void {
	if (!browser) return;
	try {
		localStorage.setItem(GIF_CAPTIONER_SETTINGS_KEY, JSON.stringify(value));
	} catch {
		// best-effort persistence
	}
}

export const gifCaptionerSettingsStore = writable<GifCaptionerSettings>(
	safeReadGifCaptionerSettings()
);

if (browser) {
	gifCaptionerSettingsStore.subscribe((settings) => {
		safeWriteGifCaptionerSettings(sanitizeGifCaptionerSettings(settings));
	});
}

export function getGifCaptionerSettings(): GifCaptionerSettings {
	return get(gifCaptionerSettingsStore);
}

export function setGifCaptionerEnabled(enabled: boolean): void {
	gifCaptionerSettingsStore.update((current) =>
		sanitizeGifCaptionerSettings({
			...current,
			enabled
		})
	);
}

export function setGifCaptionerDedicatedCaptionFieldEnabled(enabled: boolean): void {
	gifCaptionerSettingsStore.update((current) =>
		sanitizeGifCaptionerSettings({
			...current,
			dedicatedCaptionFieldEnabled: enabled
		})
	);
}

export function setGifCaptionerCaptionStyle(style: GifCaptionStylePreset): void {
	gifCaptionerSettingsStore.update((current) =>
		sanitizeGifCaptionerSettings({
			...current,
			captionStyle: style
		})
	);
}
