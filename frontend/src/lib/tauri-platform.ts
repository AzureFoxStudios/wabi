import { browser } from '$app/environment';

export type TauriPlatform = 'desktop' | 'android' | 'ios' | 'unknown';

export function isTauriRuntime(): boolean {
	if (!browser) return false;
	return Boolean((window as Window & { __TAURI_CORE__?: unknown }).__TAURI_CORE__);
}

function getUserAgent(): string {
	if (!browser) return '';
	return navigator.userAgent.toLowerCase();
}

export function getTauriPlatform(): TauriPlatform {
	if (!isTauriRuntime()) return 'unknown';

	const userAgent = getUserAgent();
	if (userAgent.includes('android')) return 'android';
	if (userAgent.includes('iphone') || userAgent.includes('ipad') || userAgent.includes('ipod')) return 'ios';
	return 'desktop';
}

export function isMobileTauri(): boolean {
	const platform = getTauriPlatform();
	return platform === 'android' || platform === 'ios';
}

export function isDesktopTauri(): boolean {
	return getTauriPlatform() === 'desktop';
}
