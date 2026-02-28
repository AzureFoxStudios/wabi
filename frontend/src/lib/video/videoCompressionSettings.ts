import { browser } from '$app/environment';
import type { VideoCompressionPresetId } from './videoCompressor';

const VIDEO_COMPRESSION_ENABLED_KEY = 'wabi.videoCompression.enabled';
const VIDEO_COMPRESSION_PRESET_KEY = 'wabi.videoCompression.defaultPreset';
const VIDEO_COMPRESSION_RUNTIME_PRESET_KEY_PREFIX = 'wabi.videoCompression.defaultPreset.';

export type VideoCompressionRuntime = 'desktop' | 'android' | 'ios' | 'web' | 'unknown';

export interface VideoCompressionPresetOption {
	id: VideoCompressionPresetId;
	label: string;
	description: string;
}

export interface VideoCompressionRuntimeProfile {
	runtime: VideoCompressionRuntime;
	label: string;
	enabled: boolean;
	promptBytes: number;
	timeoutMs: number;
	maxInputBytes: number | null;
	allowedPresets: VideoCompressionPresetId[];
	recommendedPreset: VideoCompressionPresetId;
}

const PRESET_OPTIONS: Record<VideoCompressionPresetId, VideoCompressionPresetOption> = {
	mobile_540p: {
		id: 'mobile_540p',
		label: 'Mobile 540p (thermal-safe)',
		description: 'Lower resolution/bitrate for better battery and thermals on phones/tablets.'
	},
	balanced_720p: {
		id: 'balanced_720p',
		label: 'Balanced 720p',
		description: 'Default quality with good size reduction.'
	},
	quality_1080p: {
		id: 'quality_1080p',
		label: 'Quality 1080p',
		description: 'Higher quality output with larger files.'
	}
};

const RUNTIME_PROFILES: Record<VideoCompressionRuntime, VideoCompressionRuntimeProfile> = {
	desktop: {
		runtime: 'desktop',
		label: 'Desktop',
		enabled: true,
		promptBytes: 45 * 1024 * 1024,
		timeoutMs: 3 * 60 * 1000,
		maxInputBytes: null,
		allowedPresets: ['balanced_720p', 'quality_1080p'],
		recommendedPreset: 'balanced_720p'
	},
	android: {
		runtime: 'android',
		label: 'Android',
		enabled: true,
		promptBytes: 30 * 1024 * 1024,
		timeoutMs: 2 * 60 * 1000,
		maxInputBytes: 220 * 1024 * 1024,
		allowedPresets: ['mobile_540p', 'balanced_720p'],
		recommendedPreset: 'mobile_540p'
	},
	ios: {
		runtime: 'ios',
		label: 'iOS',
		enabled: true,
		promptBytes: 30 * 1024 * 1024,
		timeoutMs: 2 * 60 * 1000,
		maxInputBytes: 220 * 1024 * 1024,
		allowedPresets: ['mobile_540p', 'balanced_720p'],
		recommendedPreset: 'mobile_540p'
	},
	web: {
		runtime: 'web',
		label: 'Web',
		enabled: false,
		promptBytes: 45 * 1024 * 1024,
		timeoutMs: 3 * 60 * 1000,
		maxInputBytes: null,
		allowedPresets: ['balanced_720p'],
		recommendedPreset: 'balanced_720p'
	},
	unknown: {
		runtime: 'unknown',
		label: 'Unknown',
		enabled: false,
		promptBytes: 45 * 1024 * 1024,
		timeoutMs: 3 * 60 * 1000,
		maxInputBytes: null,
		allowedPresets: ['balanced_720p'],
		recommendedPreset: 'balanced_720p'
	}
};

function isPreset(value: string | null): value is VideoCompressionPresetId {
	return value === 'mobile_540p' || value === 'balanced_720p' || value === 'quality_1080p';
}

function runtimePresetStorageKey(runtime: VideoCompressionRuntime): string {
	return `${VIDEO_COMPRESSION_RUNTIME_PRESET_KEY_PREFIX}${runtime}`;
}

export function getVideoCompressionRuntimeProfile(runtime: VideoCompressionRuntime): VideoCompressionRuntimeProfile {
	const profile = RUNTIME_PROFILES[runtime] || RUNTIME_PROFILES.unknown;
	return {
		...profile,
		allowedPresets: [...profile.allowedPresets]
	};
}

export function getVideoCompressionPresetOptions(runtime: VideoCompressionRuntime): VideoCompressionPresetOption[] {
	const profile = getVideoCompressionRuntimeProfile(runtime);
	return profile.allowedPresets.map((presetId) => PRESET_OPTIONS[presetId]);
}

export function getVideoCompressionPresetOption(preset: VideoCompressionPresetId): VideoCompressionPresetOption {
	return PRESET_OPTIONS[preset];
}

export function isVideoCompressionPresetAllowed(
	preset: VideoCompressionPresetId,
	runtime: VideoCompressionRuntime
): boolean {
	const profile = getVideoCompressionRuntimeProfile(runtime);
	return profile.allowedPresets.includes(preset);
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

export function getDefaultVideoCompressionPreset(
	runtime: VideoCompressionRuntime = 'desktop'
): VideoCompressionPresetId {
	const profile = getVideoCompressionRuntimeProfile(runtime);
	if (!browser) return profile.recommendedPreset;
	try {
		const runtimeRaw = localStorage.getItem(runtimePresetStorageKey(runtime));
		if (isPreset(runtimeRaw) && isVideoCompressionPresetAllowed(runtimeRaw, runtime)) {
			return runtimeRaw;
		}
		const legacyRaw = localStorage.getItem(VIDEO_COMPRESSION_PRESET_KEY);
		if (isPreset(legacyRaw) && isVideoCompressionPresetAllowed(legacyRaw, runtime)) {
			return legacyRaw;
		}
		return profile.recommendedPreset;
	} catch {
		return profile.recommendedPreset;
	}
}

export function setDefaultVideoCompressionPreset(
	preset: VideoCompressionPresetId,
	runtime: VideoCompressionRuntime = 'desktop'
): void {
	if (!browser) return;
	const profile = getVideoCompressionRuntimeProfile(runtime);
	const safePreset = isVideoCompressionPresetAllowed(preset, runtime)
		? preset
		: profile.recommendedPreset;
	try {
		localStorage.setItem(runtimePresetStorageKey(runtime), safePreset);
		if (runtime === 'desktop') {
			localStorage.setItem(VIDEO_COMPRESSION_PRESET_KEY, safePreset);
		}
	} catch {
		// best effort
	}
}
