import { browser } from '$app/environment';
import type { VideoCompressionPresetId } from './videoCompressor';

const VIDEO_COMPRESSION_ENABLED_KEY = 'wabi.videoCompression.enabled';
const VIDEO_COMPRESSION_PRESET_KEY = 'wabi.videoCompression.defaultPreset';

const DEFAULT_PRESET: VideoCompressionPresetId = 'balanced_720p';

function isPreset(value: string | null): value is VideoCompressionPresetId {
	return value === 'balanced_720p' || value === 'quality_1080p';
}

export function isVideoCompressionEnabled(): boolean {
	if (!browser) return true;
	try {
		const raw = localStorage.getItem(VIDEO_COMPRESSION_ENABLED_KEY);
		if (raw === null) return true;
		return raw === 'true';
	} catch {
		return true;
	}
}

export function setVideoCompressionEnabled(enabled: boolean): void {
	if (!browser) return;
	try {
		localStorage.setItem(VIDEO_COMPRESSION_ENABLED_KEY, enabled ? 'true' : 'false');
	} catch {
		// best effort
	}
}

export function getDefaultVideoCompressionPreset(): VideoCompressionPresetId {
	if (!browser) return DEFAULT_PRESET;
	try {
		const raw = localStorage.getItem(VIDEO_COMPRESSION_PRESET_KEY);
		if (isPreset(raw)) return raw;
		return DEFAULT_PRESET;
	} catch {
		return DEFAULT_PRESET;
	}
}

export function setDefaultVideoCompressionPreset(preset: VideoCompressionPresetId): void {
	if (!browser) return;
	try {
		localStorage.setItem(VIDEO_COMPRESSION_PRESET_KEY, preset);
	} catch {
		// best effort
	}
}
