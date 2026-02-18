/**
 * Centralized TURN Server Configuration
 *
 * This module provides a unified configuration for TURN/STUN servers
 * used in WebRTC connections for voice/video calling and screen sharing.
 *
 * Configuration is loaded from environment variables (VITE_* prefixed).
 */
import { browser } from '$app/environment';
import { getServerUrl } from './serverUrl';

interface TurnServerConfig {
	urls: string[];
	username: string;
	credential: string;
}

interface CachedTurnCredentials {
	server: string;
	port: string;
	useTurns: boolean;
	username: string;
	credential: string;
	expiresAt: number; // unix seconds
}

const TURN_REFRESH_SKEW_SECONDS = 30;
let cachedTurnCredentials: CachedTurnCredentials | null = null;
let inFlightTurnFetch: Promise<void> | null = null;

function buildTurnUrls(server: string, port: string, useTurns: boolean): string[] {
	const protocol = useTurns ? 'turns' : 'turn';
	return [
		`${protocol}:${server}:${port}`,
		`${protocol}:${server}:${port}?transport=udp`,
		`${protocol}:${server}:${port}?transport=tcp`
	];
}

function hasValidCachedTurnCredentials(): boolean {
	if (!cachedTurnCredentials) return false;
	const now = Math.floor(Date.now() / 1000);
	return cachedTurnCredentials.expiresAt - now > TURN_REFRESH_SKEW_SECONDS;
}

function getStaticTurnFallback(): TurnServerConfig | null {
	const server = import.meta.env.VITE_TURN_SERVER;
	const port = import.meta.env.VITE_TURN_PORT || '3478';
	const username = import.meta.env.VITE_TURN_USERNAME;
	const password = import.meta.env.VITE_TURN_PASSWORD;
	const useTurns = import.meta.env.VITE_USE_TURNS === 'true';

	if (!server || !username || !password) {
		return null;
	}

	return {
		urls: buildTurnUrls(server, port, useTurns),
		username,
		credential: password
	};
}

async function fetchEphemeralTurnCredentials(): Promise<void> {
	if (!browser) return;

	const token = localStorage.getItem('authToken');
	if (!token) return;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);
	try {
		const response = await fetch(`${getServerUrl()}/api/media/turn-credentials`, {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${token}`
			},
			signal: controller.signal
		});

		if (!response.ok) {
			if (response.status !== 401 && response.status !== 503) {
				console.warn(`[TURN Config] TURN credential endpoint returned ${response.status}`);
			}
			return;
		}

		const payload = await response.json();
		const turn = payload?.turn;
		if (!turn) return;

		const server = typeof turn.server === 'string' ? turn.server : import.meta.env.VITE_TURN_SERVER;
		const port = turn.port ? String(turn.port) : (import.meta.env.VITE_TURN_PORT || '3478');
		const useTurns = typeof turn.useTurns === 'boolean' ? turn.useTurns : import.meta.env.VITE_USE_TURNS === 'true';
		const username = typeof turn.username === 'string' ? turn.username : '';
		const credential = typeof turn.credential === 'string' ? turn.credential : '';
		const expiresAt = typeof turn.expiresAt === 'number' ? turn.expiresAt : 0;

		if (!server || !username || !credential || !expiresAt) {
			return;
		}

		cachedTurnCredentials = {
			server,
			port,
			useTurns,
			username,
			credential,
			expiresAt
		};
	} catch (error) {
		console.warn('[TURN Config] Failed to fetch ephemeral TURN credentials, using fallback if available', error);
	} finally {
		clearTimeout(timeout);
	}
}

export async function prefetchTurnCredentials(): Promise<void> {
	if (hasValidCachedTurnCredentials()) return;
	if (!inFlightTurnFetch) {
		inFlightTurnFetch = fetchEphemeralTurnCredentials().finally(() => {
			inFlightTurnFetch = null;
		});
	}
	await inFlightTurnFetch;
}

/**
 * Builds TURN server configuration from environment variables
 * Supports both TURN (port 3478) and TURNS (port 5349 with TLS)
 *
 * @returns TURN server configuration object or null if not configured
 */
export function getTurnConfig(): TurnServerConfig | null {
	if (hasValidCachedTurnCredentials() && cachedTurnCredentials) {
		return {
			urls: buildTurnUrls(cachedTurnCredentials.server, cachedTurnCredentials.port, cachedTurnCredentials.useTurns),
			username: cachedTurnCredentials.username,
			credential: cachedTurnCredentials.credential
		};
	}

	const fallback = getStaticTurnFallback();
	if (fallback) {
		console.warn('[TURN Config] Using static TURN credentials fallback');
		return fallback;
	}

	console.warn('[TURN Config] TURN server not configured and no ephemeral credentials available');
	return null;
}

/**
 * Builds STUN server list
 * Includes self-hosted coturn STUN as primary
 * Optionally includes Google STUN servers as fallback
 *
 * @returns Array of STUN server configurations
 */
export function getStunServers(): { urls: string }[] {
	const stunServers: { urls: string }[] = [];

	// Add self-hosted STUN (coturn also provides STUN)
	const server = import.meta.env.VITE_TURN_SERVER;
	const port = import.meta.env.VITE_TURN_PORT || '3478';

	if (server) {
		stunServers.push({ urls: `stun:${server}:${port}` });
	}

	// Add Google STUN servers as optional fallback
	const enableGoogleStun = import.meta.env.VITE_ENABLE_GOOGLE_STUN !== 'false';

	if (enableGoogleStun) {
		stunServers.push(
			{ urls: 'stun:stun.l.google.com:19302' },
			{ urls: 'stun:stun1.l.google.com:19302' }
		);
	}

	return stunServers;
}

/**
 * Builds complete RTCConfiguration object for WebRTC connections
 * Combines STUN and TURN servers into a production-ready configuration
 *
 * @returns RTCConfiguration object ready for use with RTCPeerConnection
 */
export function buildRTCConfig(): RTCConfiguration {
	const iceServers: RTCIceServer[] = [];

	// Add STUN servers
	const stunServers = getStunServers();
	iceServers.push(...stunServers);

	// Add TURN server if configured
	const turnConfig = getTurnConfig();
	if (turnConfig) {
		iceServers.push(turnConfig);
		console.log('[TURN Config] Using configured TURN server');
	} else {
		console.warn('[TURN Config] No TURN server configured - calls may fail across restrictive NATs');
	}

	return {
		iceServers
	};
}
