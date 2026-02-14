import { browser } from '$app/environment';
import { getServerUrl } from './serverUrl';

export type MediaQualityMode = 'web-baseline' | 'local-enhanced';

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
	qualityMode: MediaQualityMode;
	enableSrtGateway: boolean;
	audioMaxBitrate: number;
	videoMaxBitrate: number;
	screenShareMaxBitrate: number;
}

const STORAGE_KEYS = {
	qualityMode: 'wabi_media_quality_mode',
	srtGateway: 'wabi_enable_srt_gateway'
};

export function isTauriRuntime(): boolean {
	if (!browser) return false;
	return Boolean((window as Window & { __TAURI_CORE__?: unknown }).__TAURI_CORE__);
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
	const isTauri = isTauriRuntime();
	const qualityMode = resolveQualityMode(isTauri);
	const enableSrtGateway = browser && localStorage.getItem(STORAGE_KEYS.srtGateway) === 'true';

	if (qualityMode === 'local-enhanced') {
		return {
			isTauri,
			qualityMode,
			enableSrtGateway,
			audioMaxBitrate: 96000,
			videoMaxBitrate: 2_200_000,
			screenShareMaxBitrate: 2_600_000
		};
	}

	return {
		isTauri,
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

export function getStoredMediaQualityMode(): MediaQualityMode {
	return resolveQualityMode(isTauriRuntime());
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
