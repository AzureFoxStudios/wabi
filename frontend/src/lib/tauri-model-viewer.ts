import { invoke } from '@tauri-apps/api/core';
import { isDesktopTauri } from './tauri-platform';

/**
 * Open a 3D model in the native wgpu viewer window (desktop Tauri builds only).
 * Returns false on web/non-desktop or if the launch failed, so callers can
 * fall back to the in-page three.js viewer.
 */
export async function openNativeModelViewer(src: string, fileName: string): Promise<boolean> {
	if (!isDesktopTauri()) return false;
	try {
		const response = await fetch(src);
		if (!response.ok) throw new Error(`model fetch failed: ${response.status}`);
		const buffer = await response.arrayBuffer();
		await invoke('open_model_viewer', { bytes: new Uint8Array(buffer) });
		return true;
	} catch (e) {
		console.error('openNativeModelViewer failed', e);
		return false;
	}
}
