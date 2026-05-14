/**
 * livekitToken.ts
 * LiveKit token refresh scheduling and retry logic
 */

import { get } from 'svelte/store';
import { activeVoiceChannel } from './callingStateStores';
import {
	LIVEKIT_TOKEN_REFRESH_BUFFER_MS,
	LIVEKIT_TOKEN_REFRESH_BASE_RETRY_MS,
	LIVEKIT_TOKEN_REFRESH_MAX_RETRY_MS,
	LIVEKIT_TOKEN_REFRESH_MAX_RETRIES
} from './callingTypes';
import { connectLivekitSfu, disconnectLivekitSfu } from './livekitSfu';

let _livekitRefreshTimers = new Map<string, number>();
let _livekitRefreshRetryCounts = new Map<string, number>();
let _livekitRefreshInFlight = new Set<string>();

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

export function scheduleLivekitTokenRefresh(channelId: string, displayName: string, token: string) {
	if (typeof window === 'undefined') return;
	const exp = decodeJwtExp(token);
	if (!exp) return;
	cancelLivekitTokenRefresh(channelId);
	const delay = Math.max(0, exp - Date.now() - LIVEKIT_TOKEN_REFRESH_BUFFER_MS);
	const t = window.setTimeout(() => {
		void attemptLivekitTokenRefresh(channelId, displayName);
	}, delay);
	_livekitRefreshTimers.set(channelId, t);
}

async function attemptLivekitTokenRefresh(channelId: string, displayName: string): Promise<void> {
	if (typeof window === 'undefined') return;
	if (_livekitRefreshInFlight.has(channelId)) return;

	_livekitRefreshInFlight.add(channelId);
	try {
		await refreshLivekitToken(channelId, displayName);
		_livekitRefreshRetryCounts.delete(channelId);
	} catch (error) {
		const activeVoiceChannelId = get(activeVoiceChannel)?.id;
		const shouldRetry = activeVoiceChannelId === channelId;
		const nextAttempt = (_livekitRefreshRetryCounts.get(channelId) ?? 0) + 1;

		if (shouldRetry && nextAttempt <= LIVEKIT_TOKEN_REFRESH_MAX_RETRIES) {
			_livekitRefreshRetryCounts.set(channelId, nextAttempt);
			const retryDelay = Math.min(
				LIVEKIT_TOKEN_REFRESH_MAX_RETRY_MS,
				LIVEKIT_TOKEN_REFRESH_BASE_RETRY_MS * (2 ** (nextAttempt - 1))
			);
			const retryTimer = window.setTimeout(() => {
				void attemptLivekitTokenRefresh(channelId, displayName);
			}, retryDelay);
			_livekitRefreshTimers.set(channelId, retryTimer);
			console.warn(`[Calling] LiveKit token refresh failed for ${channelId}; retrying in ${retryDelay}ms`, error);
		} else {
			_livekitRefreshRetryCounts.delete(channelId);
			console.error(`[Calling] LiveKit token refresh exhausted for ${channelId}`, error);
		}
	} finally {
		_livekitRefreshInFlight.delete(channelId);
	}
}

async function refreshLivekitToken(channelId: string, displayName: string) {
	if (get(activeVoiceChannel)?.id !== channelId) return;
	const { livekitRoom, livekitChannelId } = await import('./livekitSfu').then(m => ({
		livekitRoom: m.livekitRoom,
		livekitChannelId: m.livekitChannelId
	}));
	if (livekitRoom && livekitChannelId === channelId) {
		await disconnectLivekitSfu({ preserveCallState: true });
	}
	await connectLivekitSfu(channelId, displayName);
}

export function cancelLivekitTokenRefresh(channelId: string) {
	const t = _livekitRefreshTimers.get(channelId);
	if (t != null) {
		window.clearTimeout(t);
	}
	_livekitRefreshTimers.delete(channelId);
	_livekitRefreshRetryCounts.delete(channelId);
}
