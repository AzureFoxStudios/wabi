import { browser } from '$app/environment';
import { getServerUrl } from './serverUrl';
import { isDesktopTauri, isMobileTauri, isTauriRuntime as detectTauriRuntime } from './tauri-platform';
import type {
	BoosterRelayMode,
	ServerMediaRuntimeResponse,
	SfuProvider
} from '../../../shared/mediaContracts';
export type {
	BoosterRelayMode,
	ServerMediaRuntimeResponse,
	SfuProvider
} from '../../../shared/mediaContracts';

export type { ScreenShareQualityPreset, ScreenShareQualityProfile } from './media/screenShare';
export type { SpatialAudioMode, SpatialAudioSettings } from './media/spatialAudio';
export {
	getPreferredMicDeviceId, setPreferredMicDeviceId,
	getPreferredCameraDeviceId, setPreferredCameraDeviceId
} from './media/mediaStorage';
export {
	getStoredScreenShareQualityPreset, setScreenShareQualityPreset,
	getStoredScreenShareBitrateKbps, setScreenShareBitrateKbps,
	getScreenShareBitrateOverrideBps, getScreenShareQualityProfile
} from './media/screenShare';
export {
	getStoredSpatialAudioSettings, setSpatialAudioEnabled, setSpatialAudioMode,
	setSpatialAudioMasterStrength, setSpatialAudioDistanceScale,
	setSpatialAudioWarningMuted, setSpatialAudioQuickToggleVisible
} from './media/spatialAudio';

import { getStoredScreenShareQualityPreset, getStoredScreenShareBitrateKbps } from './media/screenShare';
import { getStoredSpatialAudioSettings } from './media/spatialAudio';

export type MediaQualityMode = 'web-baseline' | 'local-enhanced';
export type AudioProcessingMode = 'auto' | 'dsp' | 'rnn' | 'studio';
export type CallTransportMode = 'auto' | 'p2p-only' | 'sfu-preferred' | 'stdb' | 'storefwd';
export type CallMuteBehavior = 'mute-local-input' | 'outbound-only';
export type CallRecordingStemMode = 'mixed-only' | 'mixed-plus-mic' | 'mixed-plus-all-audio';
export type EffectiveCallTransport = 'p2p' | 'sfu' | 'stdb' | 'storefwd';

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
	sfuProvider: SfuProvider;
	checkedAt: number;
}

export interface EffectiveMediaSettingsSnapshot {
	qualityMode: MediaQualityMode;
	audioProcessingMode: AudioProcessingMode;
	callTransportMode: CallTransportMode;
	callMuteBehavior: CallMuteBehavior;
	callRecordingStemMode: CallRecordingStemMode;
	srtGatewayEnabled: boolean;
	screenShareQualityPreset: import('./media/screenShare').ScreenShareQualityPreset;
	screenShareBitrateKbps: number;
	spatialAudio: import('./media/spatialAudio').SpatialAudioSettings;
	runtime: ServerMediaRuntimeResponse | null;
}

export function getBoosterRelayRequestedMode(runtime: ServerMediaRuntimeResponse | null): BoosterRelayMode {
	const mode = runtime?.media?.boosterRelay?.requestedMode;
	if (mode === 'turn-only' || mode === 'turn-sfu' || mode === 'turn-sfu-gateway') return mode;
	return 'off';
}

export function getBoosterRelayEffectiveMode(runtime: ServerMediaRuntimeResponse | null): BoosterRelayMode {
	const mode = runtime?.media?.boosterRelay?.effectiveMode;
	if (mode === 'turn-only' || mode === 'turn-sfu' || mode === 'turn-sfu-gateway') return mode;
	return 'off';
}

import { STORAGE_KEYS } from './media/mediaStorage';

let lastRuntimeSnapshot: ServerMediaRuntimeResponse | null = null;

export function isTauriRuntime(): boolean {
	return detectTauriRuntime();
}

function resolveQualityMode(isTauri: boolean): MediaQualityMode {
	if (!browser) return 'web-baseline';

	const stored = localStorage.getItem(STORAGE_KEYS.qualityMode);
	if (stored === 'web-baseline' || stored === 'local-enhanced') {
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
			isTauri, isMobileTauri: mobileTauri, isDesktopTauri: desktopTauri,
			qualityMode, enableSrtGateway,
			audioMaxBitrate: 96000, videoMaxBitrate: 8_000_000, screenShareMaxBitrate: 20_000_000
		};
	}

	return {
		isTauri, isMobileTauri: mobileTauri, isDesktopTauri: desktopTauri,
		qualityMode, enableSrtGateway,
		audioMaxBitrate: 64000, videoMaxBitrate: 3_000_000, screenShareMaxBitrate: 8_000_000
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
	if (stored === 'noise-suppression') return 'auto';
	if (stored === 'studio-quality') return 'studio';
	if (stored === 'auto' || stored === 'dsp' || stored === 'rnn' || stored === 'studio') return stored;
	return 'auto';
}

export function setAudioProcessingMode(mode: AudioProcessingMode): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEYS.audioProcessingMode, mode);
}

export function getAudioCaptureConstraints(mode: AudioProcessingMode = getStoredAudioProcessingMode()): MediaTrackConstraints {
	if (mode === 'studio') {
		return { echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000, channelCount: 1 };
	}
	if (mode === 'dsp') {
		return { echoCancellation: true, noiseSuppression: false, autoGainControl: false, sampleRate: 48000, channelCount: 1 };
	}
	return { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000, channelCount: 1 };
}

export function getStoredCallTransportMode(): CallTransportMode {
	if (!browser) return 'auto';
	const stored = localStorage.getItem(STORAGE_KEYS.callTransportMode);
	if (stored === 'p2p-only' || stored === 'sfu-preferred' || stored === 'stdb') return stored;
	return 'auto';
}

export function setCallTransportMode(mode: CallTransportMode): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEYS.callTransportMode, mode);
}

export function getStoredCallMuteBehavior(): CallMuteBehavior {
	if (!browser) return 'mute-local-input';
	const stored = localStorage.getItem(STORAGE_KEYS.callMuteBehavior);
	if (stored === 'mute-local-input' || stored === 'outbound-only') return stored;
	return 'mute-local-input';
}

export function setCallMuteBehavior(mode: CallMuteBehavior): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEYS.callMuteBehavior, mode);
}

export function doesCallMuteAffectLocalRecording(): boolean {
	return getStoredCallMuteBehavior() === 'mute-local-input';
}

export function getStoredCallRecordingStemMode(): CallRecordingStemMode {
	if (!browser) return 'mixed-only';
	const stored = localStorage.getItem(STORAGE_KEYS.callRecordingStemMode);
	if (stored === 'mixed-only' || stored === 'mixed-plus-mic' || stored === 'mixed-plus-all-audio') return stored;
	return 'mixed-only';
}

export function setCallRecordingStemMode(mode: CallRecordingStemMode): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEYS.callRecordingStemMode, mode);
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

export async function loadEffectiveMediaSettingsSnapshot(): Promise<EffectiveMediaSettingsSnapshot> {
	const runtime = await syncMediaRuntimeFromServer();
	return {
		qualityMode: getStoredMediaQualityMode(),
		audioProcessingMode: getStoredAudioProcessingMode(),
		callTransportMode: getStoredCallTransportMode(),
		callMuteBehavior: getStoredCallMuteBehavior(),
		callRecordingStemMode: getStoredCallRecordingStemMode(),
		srtGatewayEnabled: isSrtGatewayEnabled(),
		screenShareQualityPreset: getStoredScreenShareQualityPreset(),
		screenShareBitrateKbps: getStoredScreenShareBitrateKbps() ?? 0,
		spatialAudio: getStoredSpatialAudioSettings(),
		runtime
	};
}

function isGatewayHealthy(runtime: ServerMediaRuntimeResponse | null): boolean {
	return isLivekitReady(runtime);
}

function getSfuProvider(runtime: ServerMediaRuntimeResponse | null): SfuProvider {
	const provider = runtime?.media?.sfu?.provider;
	if (provider === 'livekit') return 'livekit';
	return 'none';
}

function isLivekitReady(runtime: ServerMediaRuntimeResponse | null): boolean {
	if (getSfuProvider(runtime) !== 'livekit') return false;
	const livekit = runtime?.media?.livekit;
	return Boolean(livekit?.configured && livekit?.url);
}

function getSfuFallbackReason(runtime: ServerMediaRuntimeResponse | null): string {
	const provider = getSfuProvider(runtime);
	if (provider === 'none') return 'sfu_plugin_disabled';
	const livekit = runtime?.media?.livekit;
	if (!livekit?.configured || !livekit?.url) return 'livekit_unconfigured';
	return 'livekit_connect_failed';
}

export async function resolveCallTransportPlan(): Promise<CallTransportPlan> {
	const mode = getStoredCallTransportMode();
	const runtime = (await syncMediaRuntimeFromServer()) || lastRuntimeSnapshot;
	const sfuProvider = getSfuProvider(runtime || null);
	const gatewayHealthy = isGatewayHealthy(runtime || null);
	const livekitReady = isLivekitReady(runtime || null);
	const canUseSfu = sfuProvider === 'livekit' && livekitReady;
	const checkedAt = Date.now();

	if (mode === 'storefwd') {
		return { mode, effective: 'storefwd', fallbackApplied: false, reason: null, gatewayHealthy, sfuProvider, checkedAt };
	}
	if (mode === 'p2p-only') {
		return { mode, effective: 'p2p', fallbackApplied: false, reason: null, gatewayHealthy, sfuProvider, checkedAt };
	}
	if (mode === 'stdb') {
		return { mode, effective: 'stdb', fallbackApplied: false, reason: null, gatewayHealthy, sfuProvider, checkedAt };
	}
	if (mode === 'sfu-preferred') {
		if (canUseSfu) {
			return { mode, effective: 'sfu', fallbackApplied: false, reason: null, gatewayHealthy, sfuProvider, checkedAt };
		}
		return { mode, effective: 'p2p', fallbackApplied: true, reason: getSfuFallbackReason(runtime || null), gatewayHealthy, sfuProvider, checkedAt };
	}

	return { mode, effective: 'stdb', fallbackApplied: false, reason: null, gatewayHealthy, sfuProvider, checkedAt };
}
