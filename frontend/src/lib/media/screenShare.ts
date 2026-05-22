import { browser } from '$app/environment';
import { STORAGE_KEYS } from './mediaStorage';

export type ScreenShareQualityPreset = 'auto' | '1080p' | 'source-unbounded' | '720p' | '480p' | '144p-mobile';

export interface ScreenShareQualityProfile {
	label: string;
	constraints: MediaTrackConstraints;
	maxBitrate: number | null;
	maxFramerate: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

const SCREEN_SHARE_QUALITY_PROFILES: Record<ScreenShareQualityPreset, ScreenShareQualityProfile> = {
	auto: {
		label: 'Auto (Recommended)',
		constraints: {
			frameRate: { ideal: 24, max: 30 },
			width: { ideal: 1920, max: 2560 },
			height: { ideal: 1080, max: 1440 }
		},
		maxBitrate: 5_000_000,
		maxFramerate: 30
	},
	'1080p': {
		label: '1080p',
		constraints: {
			frameRate: { ideal: 24, max: 30 },
			width: { ideal: 1920, max: 1920 },
			height: { ideal: 1080, max: 1080 }
		},
		maxBitrate: 8_000_000,
		maxFramerate: 30
	},
	'source-unbounded': {
		label: 'Source (Unbounded Bitrate)',
		constraints: {
			frameRate: { ideal: 30, max: 60 },
			width: { ideal: 2560, max: 3840 },
			height: { ideal: 1440, max: 2160 }
		},
		maxBitrate: null,
		maxFramerate: 60
	},
	'720p': {
		label: '720p',
		constraints: {
			frameRate: { ideal: 12, max: 20 },
			width: { ideal: 1280, max: 1280 },
			height: { ideal: 720, max: 720 }
		},
		maxBitrate: 1_200_000,
		maxFramerate: 20
	},
	'480p': {
		label: '480p',
		constraints: {
			frameRate: { ideal: 10, max: 15 },
			width: { ideal: 854, max: 854 },
			height: { ideal: 480, max: 480 }
		},
		maxBitrate: 700_000,
		maxFramerate: 15
	},
	'144p-mobile': {
		label: '144p (Mobile/Low Data)',
		constraints: {
			frameRate: { ideal: 8, max: 12 },
			width: { ideal: 256, max: 256 },
			height: { ideal: 144, max: 144 }
		},
		maxBitrate: 180_000,
		maxFramerate: 12
	}
};

export function getStoredScreenShareQualityPreset(): ScreenShareQualityPreset {
	if (!browser) return 'auto';
	const storedRaw = localStorage.getItem(STORAGE_KEYS.screenShareQuality);
	const stored = storedRaw === '1080p-crisp' || storedRaw === '1080p-high-bitrate'
		? '1080p'
		: storedRaw === 'source-unlocked'
			? 'source-unbounded'
			: storedRaw;
	if (stored && stored in SCREEN_SHARE_QUALITY_PROFILES) {
		return stored as ScreenShareQualityPreset;
	}
	return 'auto';
}

export function setScreenShareQualityPreset(preset: ScreenShareQualityPreset): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEYS.screenShareQuality, preset);
}

export function getStoredScreenShareBitrateKbps(): number | null {
	if (!browser) return null;
	const raw = localStorage.getItem(STORAGE_KEYS.screenShareBitrateKbps);
	if (!raw) return null;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return null;
	if (parsed <= 0) return null;
	return clamp(Math.floor(parsed), 250, 200_000);
}

export function setScreenShareBitrateKbps(value: number | null): void {
	if (!browser) return;
	if (value == null || !Number.isFinite(value) || value <= 0) {
		localStorage.removeItem(STORAGE_KEYS.screenShareBitrateKbps);
		return;
	}
	localStorage.setItem(STORAGE_KEYS.screenShareBitrateKbps, String(clamp(Math.floor(value), 250, 200_000)));
}

export function getScreenShareBitrateOverrideBps(): number | null {
	const kbps = getStoredScreenShareBitrateKbps();
	if (kbps == null) return null;
	return kbps * 1000;
}

export function getScreenShareQualityProfile(): ScreenShareQualityProfile {
	const preset = getStoredScreenShareQualityPreset();
	return SCREEN_SHARE_QUALITY_PROFILES[preset];
}
