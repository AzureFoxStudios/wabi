import { browser } from '$app/environment';
import { invoke } from '@tauri-apps/api/core';
import { isDesktopTauri } from './tauri-platform';

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

export async function sendTauriDesktopNotification(title: string, body: string): Promise<boolean> {
	if (!browser || !isDesktopTauri()) return false;

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
		console.warn('[wabi] native notification failed, falling back to browser API:', err);
		return false;
	}
}

export async function requestTauriNotificationPermission(): Promise<boolean> {
	if (!browser || !isDesktopTauri()) return false;
	const result = await requestNativePermission();
	return result === 'granted';
}
