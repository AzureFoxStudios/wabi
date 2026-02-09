import { browser } from '$app/environment';

export function getServerUrl(): string {
	const result = resolveServerUrl();
	if (browser) {
		console.log(`[ServerUrl] Resolved: ${result.url} (source: ${result.source})`);
	}
	return result.url;
}

export function resolveServerUrl(): { url: string; source: string } {
	if (!browser) {
		return { url: 'http://localhost:3000', source: 'ssr_default' };
	}

	// 1. Explicit env override (baked at build time)
	const envUrl = import.meta.env.VITE_SOCKET_URL;
	if (envUrl) {
		return { url: envUrl, source: 'env_override' };
	}

	const origin = window.location.origin;
	const hostname = window.location.hostname;
	const port = window.location.port;

	// 2. Tauri (Windows uses https://tauri.localhost, macOS/Linux use tauri://localhost)
	if (hostname === 'tauri.localhost' || window.location.protocol === 'tauri:') {
		if (import.meta.env.DEV) {
			return { url: 'http://localhost:3000', source: 'dev_tauri' };
		}
		return { url: 'https://wabi.chat', source: 'prod_tauri' };
	}

	// 3. Vite dev server
	if (port === '5173') {
		return { url: 'http://localhost:3000', source: 'dev_vite' };
	}

	// 4. Docker: frontend on :3000, backend on :8080 (localhost only)
	if (port === '3000' && (hostname === 'localhost' || hostname === '127.0.0.1')) {
		return { url: origin.replace(':3000', ':8080'), source: 'docker_port_rewrite' };
	}

	// 5. Production: same-origin (platform routes /socket.io to backend)
	return { url: origin, source: 'same_origin' };
}
