/**
 * Centralized TURN Server Configuration
 *
 * This module provides a unified configuration for TURN/STUN servers
 * used in WebRTC connections for voice/video calling and screen sharing.
 *
 * Configuration is loaded from environment variables (VITE_* prefixed).
 */

interface TurnServerConfig {
	urls: string[];
	username: string;
	credential: string;
}

/**
 * Builds TURN server configuration from environment variables
 * Supports both TURN (port 3478) and TURNS (port 5349 with TLS)
 *
 * @returns TURN server configuration object or null if not configured
 */
export function getTurnConfig(): TurnServerConfig | null {
	const server = import.meta.env.VITE_TURN_SERVER;
	const port = import.meta.env.VITE_TURN_PORT || '3478';
	const username = import.meta.env.VITE_TURN_USERNAME;
	const password = import.meta.env.VITE_TURN_PASSWORD;
	const useTurns = import.meta.env.VITE_USE_TURNS === 'true';

	// Validate required configuration
	if (!server || !username || !password) {
		console.warn('[TURN Config] TURN server not configured. Set VITE_TURN_SERVER, VITE_TURN_USERNAME, and VITE_TURN_PASSWORD in .env');
		return null;
	}

	const protocol = useTurns ? 'turns' : 'turn';

	// Build TURN URLs with different transport options
	const urls = [
		`${protocol}:${server}:${port}`,
		`${protocol}:${server}:${port}?transport=udp`,
		`${protocol}:${server}:${port}?transport=tcp`
	];

	return {
		urls,
		username,
		credential: password
	};
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
