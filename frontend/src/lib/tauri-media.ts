import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from './tauri-platform';

export interface MediaRuntimeCapabilities {
	supports_native_audio_pipeline: boolean;
	supports_srt_gateway: boolean;
	supports_hardware_acceleration_hinting: boolean;
}

export interface MediaTransportPreferences {
	quality_mode: 'web-baseline' | 'local-enhanced';
	srt_gateway_enabled: boolean;
	preferred_audio_bitrate: number;
	preferred_video_bitrate: number;
}

function isTauriAvailable(): boolean {
	return isTauriRuntime();
}

export async function getTauriMediaCapabilities(): Promise<MediaRuntimeCapabilities | null> {
	if (!isTauriAvailable()) return null;
	try {
		return await invoke<MediaRuntimeCapabilities>('get_media_runtime_capabilities');
	} catch (error) {
		console.warn('[Tauri Media] Could not get media capabilities:', error);
		return null;
	}
}

export async function loadTauriMediaPreferences(): Promise<MediaTransportPreferences | null> {
	if (!isTauriAvailable()) return null;
	try {
		return await invoke<MediaTransportPreferences>('get_media_transport_preferences');
	} catch (error) {
		console.warn('[Tauri Media] Could not load media preferences:', error);
		return null;
	}
}

export async function saveTauriMediaPreferences(prefs: MediaTransportPreferences): Promise<void> {
	if (!isTauriAvailable()) return;
	try {
		await invoke<string>('set_media_transport_preferences', { preferences: prefs });
	} catch (error) {
		console.warn('[Tauri Media] Could not save media preferences:', error);
	}
}
