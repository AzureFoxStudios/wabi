import { invoke } from '@tauri-apps/api/core';
import { browser } from '$app/environment';

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

export interface SrtGatewayRuntimeState {
	running: boolean;
	mode: 'idle' | 'simulated';
	updated_at: number;
}

function isTauriAvailable(): boolean {
	return browser && Boolean((window as Window & { __TAURI_CORE__?: unknown }).__TAURI_CORE__);
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

export async function getTauriSrtGatewayState(): Promise<SrtGatewayRuntimeState | null> {
	if (!isTauriAvailable()) return null;
	try {
		return await invoke<SrtGatewayRuntimeState>('get_srt_gateway_runtime_state');
	} catch (error) {
		console.warn('[Tauri Media] Could not get SRT gateway state:', error);
		return null;
	}
}

export async function startTauriSrtGatewaySimulation(): Promise<SrtGatewayRuntimeState | null> {
	if (!isTauriAvailable()) return null;
	try {
		return await invoke<SrtGatewayRuntimeState>('start_srt_gateway_simulation');
	} catch (error) {
		console.warn('[Tauri Media] Could not start SRT gateway simulation:', error);
		return null;
	}
}

export async function stopTauriSrtGatewaySimulation(): Promise<SrtGatewayRuntimeState | null> {
	if (!isTauriAvailable()) return null;
	try {
		return await invoke<SrtGatewayRuntimeState>('stop_srt_gateway_simulation');
	} catch (error) {
		console.warn('[Tauri Media] Could not stop SRT gateway simulation:', error);
		return null;
	}
}
