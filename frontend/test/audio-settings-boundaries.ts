// Only the mounted settings component's application-service imports are
// replaced. Device acquisition, DSP, ownership and MediaRecorder are real.
import { writable } from 'svelte/store';
// isInCall: AudioSettingsTab reads it since 0deef6bf (wave 1c) to decide whether to mirror connection details.
export { audioProcessingRuntimeStatus, callTransportState, isInCall, spatialAudioDiagnostics, spatialAudioRuntimeStatus } from '../src/lib/callingStateStores';
export const _ = writable((key: string) => key);
export const DESKTOP_HELPER_PROFILE_KEY = 'smoke-helper';
export const desktopHelperState = writable({ message: 'Off' });
export const syncDesktopHelperService = async () => {};
export const clearAudioPerformanceFallbackOverride = () => {};
export const refreshLocalAudioMuteState = () => {};
export const refreshSpatialAudioRuntime = () => {};
export const refreshCallRecordingMix = () => {};
export const applyCurrentAudioProcessingToLocalTrack = async () => {
	(window as any).__settingsApplyCount = ((window as any).__settingsApplyCount ?? 0) + 1;
};
