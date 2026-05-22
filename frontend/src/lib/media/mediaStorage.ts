import { browser } from '$app/environment';

const STORAGE_KEYS = {
	qualityMode: 'wabi_media_quality_mode',
	qualityModeAutoMigrated: 'wabi_media_quality_mode_auto_migrated',
	audioProcessingMode: 'wabi_audio_processing_mode',
	srtGateway: 'wabi_enable_srt_gateway',
	screenShareQuality: 'wabi_screen_share_quality_preset',
	screenShareBitrateKbps: 'wabi_screen_share_bitrate_kbps',
	callTransportMode: 'wabi_call_transport_mode',
	callMuteBehavior: 'wabi_call_mute_behavior',
	callRecordingStemMode: 'wabi_call_recording_stem_mode',
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

export { STORAGE_KEYS };
