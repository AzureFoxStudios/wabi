import { get } from 'svelte/store';
import {
	audioProcessingRuntimeStatus,
	applyCurrentAudioProcessingToLocalTrack,
	refreshLocalAudioMuteState,
	refreshSpatialAudioRuntime,
	spatialAudioRuntimeStatus
} from '$lib/calling';
import { refreshCallRecordingMix } from '$lib/callRecording';
import {
	DESKTOP_HELPER_PROFILE_KEY,
	desktopHelperState,
	syncDesktopHelperService,
	type DesktopHelperProfileMode
} from '$lib/desktopHelper';
import { getTauriPlatform } from '$lib/tauri-platform';
import {
	getAudioCaptureConstraints,
	isTauriRuntime,
	loadEffectiveMediaSettingsSnapshot,
	setAudioProcessingMode,
	setCallMuteBehavior,
	setCallRecordingStemMode,
	setCallTransportMode,
	setMediaQualityMode,
	setScreenShareQualityPreset,
	setScreenShareBitrateKbps,
	setSpatialAudioDistanceScale,
	setSpatialAudioEnabled,
	setSpatialAudioMasterStrength,
	setSpatialAudioMode,
	setSpatialAudioQuickToggleVisible,
	setSpatialAudioWarningMuted,
	setSrtGatewayEnabled,
	getPreferredMicDeviceId,
	setPreferredMicDeviceId,
	getPreferredCameraDeviceId,
	setPreferredCameraDeviceId,
	type AudioProcessingMode,
	type CallMuteBehavior,
	type CallRecordingStemMode,
	type CallTransportMode,
	type MediaQualityMode,
	type ScreenShareQualityPreset,
	type SpatialAudioMode
} from '$lib/mediaRuntime';

export interface AudioSettingsState {
	soundEnabled: boolean;
	micEnabled: boolean;
	cameraEnabled: boolean;
	selectedMicDeviceId: string;
	selectedCameraDeviceId: string;
	mediaQualityMode: MediaQualityMode;
	audioProcessingMode: AudioProcessingMode;
	spatialAudioEnabled: boolean;
	spatialAudioMode: SpatialAudioMode;
	spatialAudioStrength: number;
	spatialAudioDistanceScale: number;
	spatialAudioWarningsMuted: boolean;
	spatialAudioQuickToggleVisible: boolean;
	screenShareQualityPreset: ScreenShareQualityPreset;
	screenShareBitrateKbps: number;
	callTransportMode: CallTransportMode;
	callMuteBehavior: CallMuteBehavior;
	callRecordingStemMode: CallRecordingStemMode;
	srtGatewayEnabled: boolean;
	localAppRuntime: boolean;
	desktopLocalAppRuntime: boolean;
	desktopHelperProfileName: string;
	desktopHelperProfileMode: DesktopHelperProfileMode;
}

export function getBoosterRelayModeLabel(mode: string): string {
	switch (mode) {
		case 'turn-only':
			return 'TURN only';
		case 'turn-sfu':
			return 'TURN + SFU';
		case 'turn-sfu-gateway':
			return 'TURN + SFU + Gateway';
		default:
			return 'Off';
	}
}

export function getBoosterRelayComponentsSummary(runtime: any): string {
	const components = runtime?.media?.boosterRelay?.components;
	if (!components) return 'No booster relay components advertised.';
	return [
		`TURN ${components.turnConfigured ? 'ready' : 'off'}`,
		`SFU ${components.sfuConfigured ? 'ready' : 'off'}`,
		`Gateway ${components.gatewayConfigured ? (components.gatewayHealthy && components.gatewayMediaPlaneReady ? 'ready' : 'starting') : 'off'}`
	].join(' | ');
}

export function getBoosterRelaySelfAdvertisementSummary(runtime: any): string {
	const advertisement = runtime?.media?.boosterRelay?.selfAdvertisement;
	if (!advertisement) return 'Self-advertised relay node: unknown.';
	if (!advertisement.advertised) return 'Self-advertised relay node: not registered.';
	const location = advertisement.url || '(missing URL)';
	const relayId = advertisement.relayId ? `, ID ${advertisement.relayId}` : '';
	return `Self-advertised relay node: ${advertisement.status || 'unknown'} at ${location}${relayId}.`;
}

export function formatRuntimeTime(timestamp: number | null): string {
	if (!timestamp) return 'never';
	return new Date(timestamp).toLocaleTimeString();
}

export async function loadAudioSettings(): Promise<AudioSettingsState> {
	const localAppRuntime = isTauriRuntime();
	const desktopLocalAppRuntime = getTauriPlatform() === 'desktop';
	const mediaSettings = await loadEffectiveMediaSettingsSnapshot();
	let desktopHelperProfileName = '';
	let desktopHelperProfileMode: DesktopHelperProfileMode = 'off';
	try {
		const raw = typeof window !== 'undefined' ? localStorage.getItem(DESKTOP_HELPER_PROFILE_KEY) : null;
		if (raw) {
			const parsed = JSON.parse(raw) as { name?: string; mode?: DesktopHelperProfileMode };
			desktopHelperProfileName = typeof parsed.name === 'string' ? parsed.name : '';
			desktopHelperProfileMode = parsed.mode === 'files-only' || parsed.mode === 'desktop-assist' ? parsed.mode : 'off';
		}
	} catch {
		// no-op
	}
	return {
		soundEnabled: typeof window !== 'undefined' ? localStorage.getItem('soundEnabled') !== 'false' : true,
		micEnabled: typeof window !== 'undefined' ? localStorage.getItem('micEnabled') !== 'false' : true,
		cameraEnabled: typeof window !== 'undefined' ? localStorage.getItem('cameraEnabled') !== 'false' : true,
		selectedMicDeviceId: getPreferredMicDeviceId() || '',
		selectedCameraDeviceId: getPreferredCameraDeviceId() || '',
		mediaQualityMode: mediaSettings.qualityMode,
		audioProcessingMode: mediaSettings.audioProcessingMode,
		spatialAudioEnabled: mediaSettings.spatialAudio.enabled,
		spatialAudioMode: mediaSettings.spatialAudio.mode,
		spatialAudioStrength: mediaSettings.spatialAudio.masterStrength,
		spatialAudioDistanceScale: mediaSettings.spatialAudio.distanceScale,
		spatialAudioWarningsMuted: mediaSettings.spatialAudio.warningMuted,
		spatialAudioQuickToggleVisible: mediaSettings.spatialAudio.quickToggleVisible,
		screenShareQualityPreset: mediaSettings.screenShareQualityPreset,
		screenShareBitrateKbps: mediaSettings.screenShareBitrateKbps,
		callTransportMode: mediaSettings.callTransportMode,
		callMuteBehavior: mediaSettings.callMuteBehavior,
		callRecordingStemMode: mediaSettings.callRecordingStemMode,
		srtGatewayEnabled: mediaSettings.srtGatewayEnabled,
		localAppRuntime,
		desktopLocalAppRuntime,
		desktopHelperProfileName,
		desktopHelperProfileMode
	};
}

export async function saveDesktopHelperProfile(
	name: string,
	mode: DesktopHelperProfileMode
): Promise<{ status: string; success: boolean }> {
	const normalizedName = name.trim();
	if (mode !== 'off' && !normalizedName) {
		return { status: 'Pick a helper name before using helper mode.', success: false };
	}
	try {
		localStorage.setItem(DESKTOP_HELPER_PROFILE_KEY, JSON.stringify({ name: normalizedName, mode }));
		await syncDesktopHelperService();
		const message = get(desktopHelperState).message || (mode === 'off' ? 'Desktop helper profile saved. Helper mode stays off.' : 'Desktop helper profile saved. Activating desktop helper...');
		return { status: message, success: true };
	} catch {
		return { status: 'Failed to save desktop helper profile locally.', success: false };
	}
}

export function cleanupMicTest(state: {
	micTestLevelInterval: number | null;
	micTestRecorder: MediaRecorder | null;
	micTestStream: MediaStream | null;
	micTestAudioContext: AudioContext | null;
	micTestAnalyser: AnalyserNode | null;
	micTestLevel: number;
}): void {
	if (state.micTestLevelInterval !== null) {
		clearInterval(state.micTestLevelInterval);
		state.micTestLevelInterval = null;
	}
	if (state.micTestRecorder && state.micTestRecorder.state !== 'inactive') {
		state.micTestRecorder.stop();
	}
	state.micTestRecorder = null;
	if (state.micTestStream) {
		state.micTestStream.getTracks().forEach((track) => track.stop());
		state.micTestStream = null;
	}
	if (state.micTestAudioContext) {
		void state.micTestAudioContext.close().catch(() => undefined);
		state.micTestAudioContext = null;
	}
	state.micTestAnalyser = null;
	state.micTestLevel = 0;
}
