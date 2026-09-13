import { browser } from '$app/environment';
import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from './tauri-platform';

async function isNativePermissionGranted(): Promise<boolean> {
	try {
		return await invoke<boolean>('plugin:notification|is_permission_granted');
	} catch {
		return false;
	}
}

async function requestNativePermission(): Promise<string> {
	try {
		return await invoke<string>('plugin:notification|request_permission');
	} catch {
		return 'denied';
	}
}

/**
 * Send a local OS notification from any installed Tauri client.
 *
 * Android/iOS must not fall through to the browser Notification API: WebViews
 * do not provide the same notification surface as a normal browser, while the
 * Tauri notification plugin is explicitly mobile-capable.
 */
export async function sendTauriNotification(title: string, body: string): Promise<boolean> {
	if (!browser || !isTauriRuntime()) return false;

	try {
		let granted = await isNativePermissionGranted();
		if (!granted) {
			const result = await requestNativePermission();
			granted = result === 'granted';
		}
		if (!granted) return false;

		await invoke('plugin:notification|notify', { request: { title, body } });
		return true;
	} catch (err) {
		console.warn('[wabi] native notification failed:', err);
		return false;
	}
}

/** Backward-compatible name for older desktop callers. */
export const sendTauriDesktopNotification = sendTauriNotification;

export async function requestTauriNotificationPermission(): Promise<boolean> {
	if (!browser || !isTauriRuntime()) return false;
	const result = await requestNativePermission();
	return result === 'granted';
}
