import { browser } from '$app/environment';
import { writable } from 'svelte/store';

const PERSISTED_URL_KEY = 'wabi.serverUrl';
const PERSISTED_REMEMBER_KEY = 'wabi.serverUrlRemember';
const PERSISTED_URL_CACHED_AT_KEY = 'wabi.serverUrlCachedAt';
const SESSION_URL_KEY = 'wabi.serverUrlSession';
const URL_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const activeServerUrl = writable<string>(browser ? resolveServerUrlInternal().url : 'http://localhost:8080');

function isLocalHost(value: string): boolean {
	const normalized = value.toLowerCase();
	return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === 'tauri.localhost';
}

function migrateLegacyLocalPort(urlValue: string): string {
	const raw = (urlValue || '').trim();
	if (!raw) return urlValue;

	let parsed: URL | null = null;
	try {
		parsed = new URL(raw);
	} catch {
		try {
			parsed = new URL(`http://${raw}`);
		} catch {
			parsed = null;
		}
	}

	if (!parsed) return urlValue;
	if (isLocalHost(parsed.hostname) && parsed.port === '3200') {
		parsed.port = '8080';
	}

	const normalizedPath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
	return `${parsed.origin}${normalizedPath}`;
}

export function normalizeServerUrl(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;

	const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	try {
		const parsed = new URL(withProtocol);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
		const normalizedPath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
		return `${parsed.origin}${normalizedPath}`;
	} catch {
		return null;
	}
}

export function getConfiguredServerUrl(): string | null {
	if (!browser) return null;
	try {
		const remembered = localStorage.getItem(PERSISTED_REMEMBER_KEY) === 'true';
		if (remembered) {
			const cachedAt = parseInt(localStorage.getItem(PERSISTED_URL_CACHED_AT_KEY) || '0', 10);
			if (cachedAt > 0 && Date.now() - cachedAt > URL_CACHE_TTL_MS) {
				localStorage.removeItem(PERSISTED_URL_KEY);
				localStorage.removeItem(PERSISTED_URL_CACHED_AT_KEY);
			} else {
				const persisted = localStorage.getItem(PERSISTED_URL_KEY);
				if (persisted) {
					const migrated = migrateLegacyLocalPort(persisted);
					if (migrated !== persisted) {
						localStorage.setItem(PERSISTED_URL_KEY, migrated);
					}
					return migrated;
				}
			}
		}

		const sessionValue = sessionStorage.getItem(SESSION_URL_KEY);
		if (sessionValue) {
			const migrated = migrateLegacyLocalPort(sessionValue);
			if (migrated !== sessionValue) {
				sessionStorage.setItem(SESSION_URL_KEY, migrated);
			}
			return migrated;
		}
	} catch {
		// Storage is best effort; fallback to auto-resolved URL.
	}
	return null;
}

export function getConfiguredServerRememberPreference(): boolean {
	if (!browser) return true;
	try {
		return localStorage.getItem(PERSISTED_REMEMBER_KEY) !== 'false';
	} catch {
		return true;
	}
}

export function setConfiguredServerUrl(value: string, remember: boolean): string {
	const normalized = normalizeServerUrl(migrateLegacyLocalPort(value));
	if (!normalized) {
		throw new Error('Enter a valid domain, for example wabi.chat or https://staging.wabi.chat');
	}

	if (browser) {
		if (remember) {
			localStorage.setItem(PERSISTED_URL_KEY, normalized);
			localStorage.setItem(PERSISTED_REMEMBER_KEY, 'true');
			localStorage.setItem(PERSISTED_URL_CACHED_AT_KEY, Date.now().toString());
			sessionStorage.removeItem(SESSION_URL_KEY);
		} else {
			sessionStorage.setItem(SESSION_URL_KEY, normalized);
			localStorage.removeItem(PERSISTED_URL_KEY);
			localStorage.setItem(PERSISTED_REMEMBER_KEY, 'false');
		}
		activeServerUrl.set(normalized);
	}

	return normalized;
}

export function getServerUrl(): string {
	const result = resolveServerUrl();
	if (browser) {
		console.log(`[ServerUrl] Resolved: ${result.url} (source: ${result.source})`);
	}
	return result.url;
}

export function resolveServerUrl(): { url: string; source: string } {
	const result = resolveServerUrlInternal();
	if (browser) {
		activeServerUrl.set(result.url);
	}
	return result;
}

function resolveServerUrlInternal(): { url: string; source: string } {
	if (!browser) {
		return { url: 'http://localhost:3000', source: 'ssr_default' };
	}

	const origin = window.location.origin;
	const hostname = window.location.hostname;
	const port = window.location.port;
	const protocol = window.location.protocol;

	const configured = getConfiguredServerUrl();
	if (configured) {
		// Discard stored URLs that are stale dev/test artifacts or www variants
		// of the current production host — both cause broken CORS preflight.
		try {
			const storedHost = new URL(configured).hostname;
			const pageHost = hostname;
			const isWwwVariant =
				storedHost === `www.${pageHost}` || pageHost === `www.${storedHost}`;
			if ((isLocalHost(storedHost) && !isLocalHost(pageHost)) || isWwwVariant) {
				// Silently discard and fall through to origin detection
			} else {
				return { url: configured, source: 'user_configured' };
			}
		} catch {
			return { url: configured, source: 'user_configured' };
		}
	}

	// 1. Explicit env override (baked at build time)
	const envUrl = migrateLegacyLocalPort(import.meta.env.VITE_SOCKET_URL || '');
	if (envUrl) {
		// Safety guard: never let dev sessions accidentally point to production.
		// Override can be bypassed only with explicit VITE_ALLOW_REMOTE_DEV=true.
		if (import.meta.env.DEV && import.meta.env.VITE_ALLOW_REMOTE_DEV !== 'true') {
			try {
				const parsed = new URL(envUrl);
				if (!isLocalHost(parsed.hostname)) {
					return { url: `${protocol}//${hostname}:3001`, source: 'env_override_dev_rewrite' };
				}
			} catch {
				// Invalid URL in dev override -> fail safe to local backend.
				return { url: `${protocol}//${hostname}:3001`, source: 'env_override_dev_rewrite_invalid' };
			}
		}
		return { url: envUrl, source: 'env_override' };
	}

	const hasTauriBridge =
		typeof (window as any).__TAURI__ !== 'undefined' || typeof (window as any).__TAURI_INTERNALS__ !== 'undefined';

	// 2. Tauri runtime (Windows often uses https://tauri.localhost, but runtime can vary by platform/build)
	if (hasTauriBridge || hostname === 'tauri.localhost' || protocol === 'tauri:') {
		if (import.meta.env.DEV) {
			return { url: `${protocol}//${hostname}:3001`, source: 'dev_tauri' };
		}
		return { url: 'https://wabi.chat', source: 'prod_tauri' };
	}

	// 3. Vite dev server — use the page's hostname with backend port 3001
	if (port === '5173') {
		return { url: `${protocol}//${hostname}:3001`, source: 'dev_vite' };
	}

	// 4. Direct container access: frontend on :3000, backend on :8080 on the same host.
	// Keep localhost and LAN/IP access working without requiring a separate reverse proxy.
	if (port === '3000') {
	    return { url: `${protocol}//${hostname}:3000`, source: 'docker_port_rewrite' };
	}

	// 5. Production: same-origin (platform routes /socket.io to backend)
	return { url: origin, source: 'same_origin' };
}
