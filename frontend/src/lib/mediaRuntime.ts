import { browser } from '$app/environment';
import { getServerUrl } from './serverUrl';
import { isDesktopTauri, isMobileTauri, isTauriRuntime as detectTauriRuntime } from './tauri-platform';

export type MediaQualityMode = 'web-baseline' | 'local-enhanced';
export type AudioProcessingMode = 'auto' | 'dsp' | 'rnn' | 'studio';
export type ScreenShareQualityPreset = 'auto' | '1080p' | 'source-unbounded' | '720p' | '480p' | '144p-mobile';
export type CallTransportMode = 'auto' | 'p2p-only' | 'sfu-preferred';
export type EffectiveCallTransport = 'p2p' | 'sfu';
export type SpatialAudioMode = 'auto' | 'pan_distance' | 'full_3d' | 'off';

export interface ScreenShareQualityProfile {
	label: string;
	constraints: MediaTrackConstraints;
	maxBitrate: number | null;
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
			mediaPlaneReady?: boolean;
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

export interface CallTransportPlan {
	mode: CallTransportMode;
	effective: EffectiveCallTransport;
	fallbackApplied: boolean;
	reason: string | null;
	gatewayHealthy: boolean;
	checkedAt: number;
}

export interface SpatialAudioSettings {
	enabled: boolean;
	mode: SpatialAudioMode;
	masterStrength: number;
	distanceScale: number;
	warningMuted: boolean;
	quickToggleVisible: boolean;
}

const STORAGE_KEYS = {
	qualityMode: 'wabi_media_quality_mode',
	qualityModeAutoMigrated: 'wabi_media_quality_mode_auto_migrated',
	audioProcessingMode: 'wabi_audio_processing_mode',
	srtGateway: 'wabi_enable_srt_gateway',
	screenShareQuality: 'wabi_screen_share_quality_preset',
	screenShareBitrateKbps: 'wabi_screen_share_bitrate_kbps',
	callTransportMode: 'wabi_call_transport_mode',
	spatialEnabled: 'wabi_spatial_enabled',
	spatialMode: 'wabi_spatial_mode',
	spatialStrength: 'wabi_spatial_strength',
	spatialDistanceScale: 'wabi_spatial_distance_scale',
	spatialWarningMuted: 'wabi_spatial_warning_muted',
	spatialQuickToggleVisible: 'wabi_spatial_quick_toggle_visible',
	preferredMicDeviceId: 'wabi_preferred_mic_device_id',
	preferredCameraDeviceId: 'wabi_preferred_camera_device_id'
};

export function getPreferredMicDeviceId(): string | null {
	if (!browser) return null;
	return localStorage.getItem(STORAGE_KEYS.preferredMicDeviceId);
}

export function setPreferredMicDeviceId(deviceId: string | null): void {
	if (!browser) return;
	if (deviceId) localStorage.setItem(STORAGE_KEYS.preferredMicDeviceId, deviceId);
	else localStorage.removeItem(STORAGE_KEYS.preferredMicDeviceId);
}

export function getPreferredCameraDeviceId(): string | null {
	if (!browser) return null;
	return localStorage.getItem(STORAGE_KEYS.preferredCameraDeviceId);
}

export function setPreferredCameraDeviceId(deviceId: string | null): void {
	if (!browser) return;
	if (deviceId) localStorage.setItem(STORAGE_KEYS.preferredCameraDeviceId, deviceId);
	else localStorage.removeItem(STORAGE_KEYS.preferredCameraDeviceId);
}

let lastRuntimeSnapshot: ServerMediaRuntimeResponse | null = null;

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

export function isTauriRuntime(): boolean {
	return detectTauriRuntime();
}

function resolveQualityMode(isTauri: boolean): MediaQualityMode {
	if (!browser) {
		return 'web-baseline';
	}

	const stored = localStorage.getItem(STORAGE_KEYS.qualityMode);
	if (stored === 'web-baseline' || stored === 'local-enhanced') {
		// One-time recovery path: older builds could mis-detect Tauri and persist web-baseline.
		// If this client is now Tauri, auto-upgrade once; user can still switch back manually.
		if (
			isTauri &&
			stored === 'web-baseline' &&
			localStorage.getItem(STORAGE_KEYS.qualityModeAutoMigrated) !== 'true'
		) {
			localStorage.setItem(STORAGE_KEYS.qualityMode, 'local-enhanced');
			localStorage.setItem(STORAGE_KEYS.qualityModeAutoMigrated, 'true');
			return 'local-enhanced';
		}
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
			videoMaxBitrate: 8_000_000,
			screenShareMaxBitrate: 20_000_000
		};
	}

	return {
		isTauri,
		isMobileTauri: mobileTauri,
		isDesktopTauri: desktopTauri,
		qualityMode,
		enableSrtGateway,
		audioMaxBitrate: 64000,
		videoMaxBitrate: 3_000_000,
		screenShareMaxBitrate: 8_000_000
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

export function getStoredAudioProcessingMode(): AudioProcessingMode {
	if (!browser) return 'auto';
	const stored = localStorage.getItem(STORAGE_KEYS.audioProcessingMode);
	// Backward compatibility for older persisted values.
	if (stored === 'noise-suppression') {
		return 'auto';
	}
	if (stored === 'studio-quality') {
		return 'studio';
	}
	if (stored === 'auto' || stored === 'dsp' || stored === 'rnn' || stored === 'studio') {
		return stored;
	}
	return 'auto';
}

export function setAudioProcessingMode(mode: AudioProcessingMode): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEYS.audioProcessingMode, mode);
}

export function getAudioCaptureConstraints(mode: AudioProcessingMode = getStoredAudioProcessingMode()): MediaTrackConstraints {
	if (mode === 'studio') {
		return {
			// Raw/studio input path: keep browser processing off.
			echoCancellation: false,
			noiseSuppression: false,
			autoGainControl: false,
			sampleRate: 48000,
			channelCount: 1
		};
	}

	if (mode === 'dsp') {
		return {
			// Keep AEC to avoid feedback loops, but disable browser denoise/AGC.
			echoCancellation: true,
			noiseSuppression: false,
			autoGainControl: false,
			sampleRate: 48000,
			channelCount: 1
		};
	}

	return {
		// Auto + RNN mode rely on browser/OS suppression where available.
		echoCancellation: true,
		noiseSuppression: true,
		autoGainControl: true,
		sampleRate: 48000,
		channelCount: 1
	};
}

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

export function getStoredCallTransportMode(): CallTransportMode {
	if (!browser) return 'auto';
	const stored = localStorage.getItem(STORAGE_KEYS.callTransportMode);
	if (stored === 'auto' || stored === 'p2p-only' || stored === 'sfu-preferred') {
		return stored;
	}
	return 'auto';
}

export function setCallTransportMode(mode: CallTransportMode): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEYS.callTransportMode, mode);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function getStoredSpatialAudioSettings(): SpatialAudioSettings {
	if (!browser) {
		return {
			enabled: false,
			mode: 'auto',
			masterStrength: 0.85,
			distanceScale: 1,
			warningMuted: false,
			quickToggleVisible: true
		};
	}

	const enabled = localStorage.getItem(STORAGE_KEYS.spatialEnabled) === 'true';
	const modeStored = localStorage.getItem(STORAGE_KEYS.spatialMode);
	const mode: SpatialAudioMode = modeStored === 'auto' || modeStored === 'pan_distance' || modeStored === 'full_3d' || modeStored === 'off'
		? modeStored
		: 'auto';
	const masterStrength = clamp(parseFloat(localStorage.getItem(STORAGE_KEYS.spatialStrength) || '0.85') || 0.85, 0, 1);
	const distanceScale = clamp(parseFloat(localStorage.getItem(STORAGE_KEYS.spatialDistanceScale) || '1') || 1, 0.4, 4);
	const warningMuted = localStorage.getItem(STORAGE_KEYS.spatialWarningMuted) === 'true';
	const quickToggleVisible = localStorage.getItem(STORAGE_KEYS.spatialQuickToggleVisible) !== 'false';

	return {
		enabled,
		mode,
		masterStrength,
		distanceScale,
		warningMuted,
		quickToggleVisible
	};
}

export function setSpatialAudioEnabled(enabled: boolean): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEYS.spatialEnabled, String(enabled));
}

export function setSpatialAudioMode(mode: SpatialAudioMode): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEYS.spatialMode, mode);
}

export function setSpatialAudioMasterStrength(value: number): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEYS.spatialStrength, String(clamp(value, 0, 1)));
}

export function setSpatialAudioDistanceScale(value: number): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEYS.spatialDistanceScale, String(clamp(value, 0.4, 4)));
}

export function setSpatialAudioWarningMuted(muted: boolean): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEYS.spatialWarningMuted, String(muted));
}

export function setSpatialAudioQuickToggleVisible(visible: boolean): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEYS.spatialQuickToggleVisible, String(visible));
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

		lastRuntimeSnapshot = data;
		return data;
	} catch (error) {
		console.warn('[MediaRuntime] Could not sync server media runtime settings:', error);
		lastRuntimeSnapshot = null;
		return null;
	}
}

function isGatewayHealthy(runtime: ServerMediaRuntimeResponse | null): boolean {
	const media = runtime?.media;
	const gateway = media?.gateway;
	if (!gateway) return false;
	if (media?.srtGatewayEnabled === false) return false;
	return Boolean(gateway.configured && gateway.healthy && gateway.mediaPlaneReady);
}

function getGatewayFallbackReason(runtime: ServerMediaRuntimeResponse | null, srtToggleEnabled: boolean): string {
	if (!srtToggleEnabled) return 'srt_gateway_disabled';
	const media = runtime?.media;
	const gateway = media?.gateway;
	if (!gateway) return 'gateway_runtime_unknown';
	if (!gateway.configured) return 'gateway_unconfigured';
	if (!gateway.healthy) return 'gateway_unhealthy';
	if (gateway.mediaPlaneReady !== true) return 'gateway_media_plane_not_ready';
	return 'gateway_unhealthy_or_unconfigured';
}

export async function resolveCallTransportPlan(): Promise<CallTransportPlan> {
	const mode = getStoredCallTransportMode();
	const runtime = (await syncMediaRuntimeFromServer()) || lastRuntimeSnapshot;
	const gatewayHealthy = isGatewayHealthy(runtime || null);
	const srtToggleEnabled = isSrtGatewayEnabled();
	const checkedAt = Date.now();

	if (mode === 'p2p-only') {
		return {
			mode,
			effective: 'p2p',
			fallbackApplied: false,
			reason: null,
			gatewayHealthy,
			checkedAt
		};
	}

	if (mode === 'sfu-preferred') {
		if (gatewayHealthy && srtToggleEnabled) {
			return {
				mode,
				effective: 'sfu',
				fallbackApplied: false,
				reason: null,
				gatewayHealthy,
				checkedAt
			};
		}

		return {
			mode,
			effective: 'p2p',
			fallbackApplied: true,
			reason: getGatewayFallbackReason(runtime || null, srtToggleEnabled),
			gatewayHealthy,
			checkedAt
		};
	}

	// auto
	if (gatewayHealthy && srtToggleEnabled) {
		return {
			mode,
			effective: 'sfu',
			fallbackApplied: false,
			reason: null,
			gatewayHealthy,
			checkedAt
		};
	}

	return {
		mode,
		effective: 'p2p',
		fallbackApplied: false,
		reason: null,
		gatewayHealthy,
		checkedAt
	};
}
