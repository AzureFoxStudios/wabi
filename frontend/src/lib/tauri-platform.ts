import { browser } from '$app/environment';

export type TauriPlatform = 'desktop' | 'android' | 'ios' | 'unknown';

type TauriWindowSignals = Window & {
	__TAURI__?: unknown;
	__TAURI_CORE__?: unknown;
	__TAURI_INTERNALS__?: unknown;
};

export function isTauriRuntime(): boolean {
	if (!browser) return false;

	const w = window as TauriWindowSignals;

	// Tauri globals vary by runtime version/build flags.
	if (w.__TAURI__ || w.__TAURI_CORE__ || w.__TAURI_INTERNALS__) {
		return true;
	}

	// Fallbacks for environments where globals are not exposed.
	const protocol = window.location.protocol;
	const hostname = window.location.hostname;
	if (protocol === 'tauri:' || protocol === 'asset:' || hostname === 'tauri.localhost') {
		return true;
	}

	// Desktop WebView user agent commonly includes "Tauri".
	return navigator.userAgent.toLowerCase().includes('tauri');
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
