/** Runtime self-hosted STUN/TURN, with an explicit build-time compatibility fallback. */
import { browser } from '$app/environment';
import { activeServerUrl, getServerUrl, normalizeServerUrl } from './serverUrl';
import { authSessionGeneration, getAuthToken, getStoredDbUserId, onAuthSessionCleared } from './authSession';
import { accountTokenSubject } from './apiRequest';
import { fetchWithTimeout } from './api/utils';
import { getPreferredTurnRelayId, selectedTurnRelay } from './relaySelector';
import { createTurnCredentialSource, readTurnEndpoint, stunUrl, turnUrls, type TurnEndpoint } from './turnCredentials';

interface TurnServerConfig { urls: string[]; username: string; credential: string }

const runtimeTurn = createTurnCredentialSource({
	context: () => {
		if (!browser) return null;
		const server = normalizeServerUrl(getServerUrl());
		const token = server ? getAuthToken(server) : null;
		if (!server || !token) return null;
		const subject = accountTokenSubject(token);
		return { server, token, generation: authSessionGeneration(server),
			account: JSON.stringify([getStoredDbUserId(server), subject ?? token]),
			preferredRelayId: getPreferredTurnRelayId() };
	},
	request: (url, token, signal) => fetchWithTimeout(url, {
		method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal, timeoutMs: 5000,
	}),
});

let observing = false;
function observeSelection() {
	if (!browser || observing) return;
	observing = true;
	// Observe selection transitions, including A→B→A while a request is pending.
	// No call/peer state is changed; already-created peers own their RTCConfiguration.
	// Start on first use, not while the calling module graph is still initializing.
	const offServer = activeServerUrl.subscribe(() => runtimeTurn.reconcile());
	const offRelay = selectedTurnRelay.subscribe(() => runtimeTurn.reconcile());
	const offSession = onAuthSessionCleared(() => runtimeTurn.reconcile());
	import.meta.hot?.dispose(() => { offServer(); offRelay(); offSession(); runtimeTurn.invalidate(); });
}

function staticEndpoint(): TurnEndpoint | null {
	const useTurns = import.meta.env.VITE_USE_TURNS === 'true';
	return readTurnEndpoint(import.meta.env.VITE_TURN_SERVER, import.meta.env.VITE_TURN_PORT || (useTurns ? '5349' : '3478'), useTurns);
}

export function prefetchTurnCredentials(): Promise<void> { observeSelection(); return runtimeTurn.prefetch(); }

export function getTurnConfig(): TurnServerConfig | null {
	observeSelection();
	const runtime = runtimeTurn.get();
	if (runtime) return { urls: turnUrls(runtime), username: runtime.username, credential: runtime.credential };
	const endpoint = staticEndpoint();
	const username = import.meta.env.VITE_TURN_USERNAME;
	const credential = import.meta.env.VITE_TURN_PASSWORD;
	return endpoint && username?.trim() && credential?.trim() ? { urls: turnUrls(endpoint), username, credential } : null;
}

export function getStunServers(): { urls: string }[] {
	observeSelection();
	const servers: { urls: string }[] = [];
	const runtime = runtimeTurn.get();
	const endpoint = runtime ?? staticEndpoint();
	const url = endpoint ? stunUrl(endpoint) : null;
	if (url) servers.push({ urls: url });
	// Third-party discovery is opt-in. Enabling runtime TURN never enables Google.
	if (import.meta.env.VITE_ENABLE_GOOGLE_STUN === 'true') {
		servers.push({ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' });
	}
	return servers;
}

export function buildRTCConfig(): RTCConfiguration {
	const iceServers: RTCIceServer[] = getStunServers();
	const turn = getTurnConfig();
	if (turn) iceServers.push(turn);
	return { iceServers };
}
