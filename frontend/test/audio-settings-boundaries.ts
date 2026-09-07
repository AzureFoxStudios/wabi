// Only the mounted settings component's application-service imports are
// replaced. Device acquisition, DSP, ownership and MediaRecorder are real.
import { writable } from 'svelte/store';
export { audioProcessingRuntimeStatus, callTransportState, spatialAudioDiagnostics, spatialAudioRuntimeStatus } from '../src/lib/callingStateStores';
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
