import { browser } from '$app/environment';
import { getServerUrl } from './serverUrl';
import { isDesktopTauri, isMobileTauri, isTauriRuntime as detectTauriRuntime } from './tauri-platform';

export type MediaQualityMode = 'web-baseline' | 'local-enhanced';
export type ScreenShareQualityPreset = 'auto' | '1080p' | '720p' | '480p' | '144p-mobile';

export interface ScreenShareQualityProfile {
	label: string;
	constraints: MediaTrackConstraints;
	maxBitrate: number;
	maxFramerate: number;
}

export interface ServerMediaRuntimeResponse {
	media?: {
		localEnhancedEnabled?: boolean;
		srtGatewayEnabled?: boolean;
		opus?: {
			audioBitrateWeb?: number;
			audioBitrateLocal?: number;
		};
		gateway?: {
			heartbeatTimeoutMs?: number;
			configured?: boolean;
			healthy?: boolean;
			lastSeenAt?: number | null;
			activeStreams?: number;
			version?: string | null;
			region?: string | null;
		};
	};
}

export interface MediaRuntimeConfig {
	isTauri: boolean;
	isMobileTauri: boolean;
	isDesktopTauri: boolean;
	qualityMode: MediaQualityMode;
	enableSrtGateway: boolean;
	audioMaxBitrate: number;
	videoMaxBitrate: number;
	screenShareMaxBitrate: number;
}

const STORAGE_KEYS = {
	qualityMode: 'wabi_media_quality_mode',
	srtGateway: 'wabi_enable_srt_gateway',
	screenShareQuality: 'wabi_screen_share_quality_preset'
};

const SCREEN_SHARE_QUALITY_PROFILES: Record<ScreenShareQualityPreset, ScreenShareQualityProfile> = {
	auto: {
		label: 'Auto (Recommended)',
		constraints: {
			frameRate: { ideal: 12, max: 20 },
			width: { ideal: 1920, max: 2560 },
			height: { ideal: 1080, max: 1440 }
		},
		maxBitrate: 1_600_000,
		maxFramerate: 18
	},
	'1080p': {
		label: '1080p',
		constraints: {
			frameRate: { ideal: 15, max: 24 },
			width: { ideal: 1920, max: 1920 },
			height: { ideal: 1080, max: 1080 }
		},
		maxBitrate: 2_200_000,
		maxFramerate: 24
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

export function isTauriRuntime(): boolean {
	return detectTauriRuntime();
}

function resolveQualityMode(isTauri: boolean): MediaQualityMode {
	if (!browser) {
		return 'web-baseline';
	}

	const stored = localStorage.getItem(STORAGE_KEYS.qualityMode);
	if (stored === 'web-baseline' || stored === 'local-enhanced') {
		return stored;
	}

	return isTauri ? 'local-enhanced' : 'web-baseline';
}

export function getMediaRuntimeConfig(): MediaRuntimeConfig {
	const isTauri = detectTauriRuntime();
	const mobileTauri = isMobileTauri();
	const desktopTauri = isDesktopTauri();
	const qualityMode = resolveQualityMode(isTauri);
	const enableSrtGateway = browser && localStorage.getItem(STORAGE_KEYS.srtGateway) === 'true';

	if (qualityMode === 'local-enhanced') {
		return {
			isTauri,
			isMobileTauri: mobileTauri,
			isDesktopTauri: desktopTauri,
			qualityMode,
			enableSrtGateway,
			audioMaxBitrate: 96000,
			videoMaxBitrate: 2_200_000,
			screenShareMaxBitrate: 2_600_000
		};
	}

	return {
		isTauri,
		isMobileTauri: mobileTauri,
		isDesktopTauri: desktopTauri,
		qualityMode,
		enableSrtGateway,
		audioMaxBitrate: 64000,
		videoMaxBitrate: 1_200_000,
		screenShareMaxBitrate: 1_600_000
	};
}

export function setMediaQualityMode(mode: MediaQualityMode): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEYS.qualityMode, mode);
}

export function setSrtGatewayEnabled(enabled: boolean): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEYS.srtGateway, String(enabled));
}

export function getStoredScreenShareQualityPreset(): ScreenShareQualityPreset {
	if (!browser) return 'auto';
	const stored = localStorage.getItem(STORAGE_KEYS.screenShareQuality);
	if (stored && stored in SCREEN_SHARE_QUALITY_PROFILES) {
		return stored as ScreenShareQualityPreset;
	}
	return 'auto';
}

export function setScreenShareQualityPreset(preset: ScreenShareQualityPreset): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEYS.screenShareQuality, preset);
}

export function getScreenShareQualityProfile(): ScreenShareQualityProfile {
	const preset = getStoredScreenShareQualityPreset();
	return SCREEN_SHARE_QUALITY_PROFILES[preset];
}

export function getStoredMediaQualityMode(): MediaQualityMode {
	return resolveQualityMode(detectTauriRuntime());
}

export function isSrtGatewayEnabled(): boolean {
	if (!browser) return false;
	return localStorage.getItem(STORAGE_KEYS.srtGateway) === 'true';
}

export async function syncMediaRuntimeFromServer(): Promise<ServerMediaRuntimeResponse | null> {
	if (!browser) return null;

	try {
		const response = await fetch(`${getServerUrl()}/api/media/runtime`, {
			method: 'GET',
			headers: { 'Content-Type': 'application/json' }
		});

		if (!response.ok) return null;
		const data = (await response.json()) as ServerMediaRuntimeResponse;

		const localEnhancedEnabled = data.media?.localEnhancedEnabled;
		if (localEnhancedEnabled === false && getStoredMediaQualityMode() === 'local-enhanced') {
			setMediaQualityMode('web-baseline');
		}

		if (typeof data.media?.srtGatewayEnabled === 'boolean' && data.media.srtGatewayEnabled === false) {
			setSrtGatewayEnabled(false);
		}

		return data;
	} catch (error) {
		console.warn('[MediaRuntime] Could not sync server media runtime settings:', error);
		return null;
	}
}
