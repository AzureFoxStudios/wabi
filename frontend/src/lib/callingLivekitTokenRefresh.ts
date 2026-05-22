import { get } from 'svelte/store';
import { activeVoiceChannel } from './callingStateStores';
import {
	LIVEKIT_TOKEN_REFRESH_BASE_RETRY_MS,
	LIVEKIT_TOKEN_REFRESH_BUFFER_MS,
	LIVEKIT_TOKEN_REFRESH_MAX_RETRIES,
	LIVEKIT_TOKEN_REFRESH_MAX_RETRY_MS
} from './callingTypes';

type LivekitTokenRefreshHandler = (channelId: string, displayName: string) => Promise<void>;

let refreshHandler: LivekitTokenRefreshHandler | null = null;
const refreshTimers = new Map<string, number>();
const refreshRetryCounts = new Map<string, number>();
const refreshInFlight = new Set<string>();

export function configureLivekitTokenRefresh(handler: LivekitTokenRefreshHandler): void {
	refreshHandler = handler;
}

function decodeJwtExp(token: string): number | null {
	try {
		const parts = token.split('.');
		if (parts.length < 2) return null;
		const payload = JSON.parse(atob(parts[1]));
		if (typeof payload?.exp === 'number') {
			return payload.exp * 1000;
		}
	} catch {
		// ignore decode errors
	}
	return null;
}

export function scheduleLivekitTokenRefresh(channelId: string, displayName: string, token: string): void {
	if (typeof window === 'undefined') return;
	const exp = decodeJwtExp(token);
	if (!exp) return;
	cancelLivekitTokenRefresh(channelId);
	const delay = Math.max(0, exp - Date.now() - LIVEKIT_TOKEN_REFRESH_BUFFER_MS);
	const timer = window.setTimeout(() => {
		void attemptLivekitTokenRefresh(channelId, displayName);
	}, delay);
	refreshTimers.set(channelId, timer);
}

async function attemptLivekitTokenRefresh(channelId: string, displayName: string): Promise<void> {
	if (typeof window === 'undefined' || refreshInFlight.has(channelId) || !refreshHandler) return;

	refreshInFlight.add(channelId);
	try {
		await refreshHandler(channelId, displayName);
		refreshRetryCounts.delete(channelId);
	} catch (error) {
		const shouldRetry = get(activeVoiceChannel)?.id === channelId;
		const nextAttempt = (refreshRetryCounts.get(channelId) ?? 0) + 1;

		if (shouldRetry && nextAttempt <= LIVEKIT_TOKEN_REFRESH_MAX_RETRIES) {
			refreshRetryCounts.set(channelId, nextAttempt);
			const retryDelay = Math.min(
				LIVEKIT_TOKEN_REFRESH_MAX_RETRY_MS,
				LIVEKIT_TOKEN_REFRESH_BASE_RETRY_MS * 2 ** (nextAttempt - 1)
			);
			const retryTimer = window.setTimeout(() => {
				void attemptLivekitTokenRefresh(channelId, displayName);
			}, retryDelay);
			refreshTimers.set(channelId, retryTimer);
			console.warn(`[Calling] LiveKit token refresh failed for ${channelId}; retrying in ${retryDelay}ms`, error);
		} else {
			refreshRetryCounts.delete(channelId);
			console.error(`[Calling] LiveKit token refresh exhausted for ${channelId}`, error);
		}
	} finally {
		refreshInFlight.delete(channelId);
	}
}

export function cancelLivekitTokenRefresh(channelId: string): void {
	const timer = refreshTimers.get(channelId);
	if (timer != null) {
		window.clearTimeout(timer);
	}
	refreshTimers.delete(channelId);
	refreshRetryCounts.delete(channelId);
}
