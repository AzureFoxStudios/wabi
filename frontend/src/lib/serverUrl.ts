import { browser } from '$app/environment';

const PERSISTED_URL_KEY = 'wabi.serverUrl';
const PERSISTED_REMEMBER_KEY = 'wabi.serverUrlRemember';
const SESSION_URL_KEY = 'wabi.serverUrlSession';

function isLocalHost(value: string): boolean {
	const normalized = value.toLowerCase();
	return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === 'tauri.localhost';
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
			const persisted = localStorage.getItem(PERSISTED_URL_KEY);
			if (persisted) return persisted;
		}

		const sessionValue = sessionStorage.getItem(SESSION_URL_KEY);
		if (sessionValue) return sessionValue;
	} catch {
		// Storage is best effort; fallback to auto-resolved URL.
	}
	return null;
}

export function setConfiguredServerUrl(value: string, remember: boolean): string {
	const normalized = normalizeServerUrl(value);
	if (!normalized) {
		throw new Error('Enter a valid domain, for example wabi.chat or https://staging.wabi.chat');
	}

	if (browser) {
		if (remember) {
			localStorage.setItem(PERSISTED_URL_KEY, normalized);
			localStorage.setItem(PERSISTED_REMEMBER_KEY, 'true');
			sessionStorage.removeItem(SESSION_URL_KEY);
		} else {
			sessionStorage.setItem(SESSION_URL_KEY, normalized);
			localStorage.removeItem(PERSISTED_URL_KEY);
			localStorage.setItem(PERSISTED_REMEMBER_KEY, 'false');
		}
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
	if (!browser) {
		return { url: 'http://localhost:8080', source: 'ssr_default' };
	}

	const configured = getConfiguredServerUrl();
	if (configured) {
		return { url: configured, source: 'user_configured' };
	}

	// 1. Explicit env override (baked at build time)
	const envUrl = import.meta.env.VITE_SOCKET_URL;
	if (envUrl) {
		// Safety guard: never let dev sessions accidentally point to production.
		// Override can be bypassed only with explicit VITE_ALLOW_REMOTE_DEV=true.
		if (import.meta.env.DEV && import.meta.env.VITE_ALLOW_REMOTE_DEV !== 'true') {
			try {
				const parsed = new URL(envUrl);
				if (!isLocalHost(parsed.hostname)) {
					return { url: 'http://localhost:8080', source: 'env_override_dev_rewrite' };
				}
			} catch {
				// Invalid URL in dev override -> fail safe to local backend.
				return { url: 'http://localhost:8080', source: 'env_override_dev_rewrite_invalid' };
			}
		}
		return { url: envUrl, source: 'env_override' };
	}

	const origin = window.location.origin;
	const hostname = window.location.hostname;
	const port = window.location.port;
	const protocol = window.location.protocol;
	const hasTauriBridge =
		typeof (window as any).__TAURI__ !== 'undefined' || typeof (window as any).__TAURI_INTERNALS__ !== 'undefined';

	// 2. Tauri runtime (Windows often uses https://tauri.localhost, but runtime can vary by platform/build)
	if (hasTauriBridge || hostname === 'tauri.localhost' || protocol === 'tauri:') {
		if (import.meta.env.DEV) {
			return { url: 'http://localhost:8080', source: 'dev_tauri' };
		}
		return { url: 'https://wabi.chat', source: 'prod_tauri' };
	}

	// 3. Vite dev server
	if (port === '5173') {
		return { url: 'http://localhost:8080', source: 'dev_vite' };
	}

	// 4. Docker: frontend on :3000, backend on :8080 (localhost only)
	if (port === '3000' && (hostname === 'localhost' || hostname === '127.0.0.1')) {
		return { url: origin.replace(':3000', ':8080'), source: 'docker_port_rewrite' };
	}

	// 5. Production: same-origin (platform routes /socket.io to backend)
	return { url: origin, source: 'same_origin' };
}
