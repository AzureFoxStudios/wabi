import { browser } from '$app/environment';

/**
 * Centralized server URL detection
 * Handles all deployment modes: dev (Vite), Docker, Tauri, and production
 * Returns the backend server URL regardless of frontend origin
 */
export function getServerUrl(): string {
	if (!browser) {
		return 'http://localhost:3000';
	}

	// 1. Check for explicit environment variable override
	const envUrl = import.meta.env.VITE_SOCKET_URL;
	if (envUrl) {
		return envUrl;
	}

	const origin = window.location.origin;

	// 2. Dev mode (Vite dev server on :5173) or Tauri dev
	if (origin.includes(':5173') || origin.includes('tauri.localhost')) {
		return 'http://localhost:3000';
	}

	// 3. Docker deployment (frontend on :3000, backend on :8080)
	if (origin.includes(':3000')) {
		return origin.replace(':3000', ':8080');
	}

	// 4. Production or same-origin deployment
	return origin;
}
