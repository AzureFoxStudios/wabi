import { getServerUrl } from './serverUrl';
import { getAuthToken } from './authSession';
import { getPreferredSfuRelayId } from './relaySelector';
import type {
	LivekitAccessTokenResponse,
	MediaGatewaySession,
	MediaGatewaySessionKind,
	MediaGatewaySessionResponse
} from '../../../shared/mediaContracts';
export type {
	LivekitAccessTokenResponse,
	MediaGatewaySession,
	MediaGatewaySessionKind
} from '../../../shared/mediaContracts';

function getAuthHeaders(): HeadersInit {
	const token = getAuthToken();
	if (!token) {
		throw new Error('Missing auth token for media gateway request');
	}
	return {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${token}`
	};
}

export async function createMediaGatewaySession(channelId: string, kind: MediaGatewaySessionKind = 'voice'): Promise<MediaGatewaySession> {
	const response = await fetch(`${getServerUrl()}/api/media/gateway/session`, {
		method: 'POST',
		headers: getAuthHeaders(),
		credentials: 'include',
		body: JSON.stringify({ channelId, kind })
	});

	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.error || `Failed to create media gateway session (${response.status})`);
	}

	const body = await response.json() as MediaGatewaySessionResponse;
	return body.session;
}

export async function closeMediaGatewaySession(sessionId: string): Promise<void> {
	const response = await fetch(`${getServerUrl()}/api/media/gateway/session/${encodeURIComponent(sessionId)}/close`, {
		method: 'POST',
		headers: getAuthHeaders(),
		credentials: 'include'
	});

	if (!response.ok && response.status !== 404) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.error || `Failed to close media gateway session (${response.status})`);
	}
}

export async function renewMediaGatewaySession(sessionId: string, ttlSeconds?: number): Promise<MediaGatewaySession> {
	const response = await fetch(`${getServerUrl()}/api/media/gateway/session/${encodeURIComponent(sessionId)}/renew`, {
		method: 'POST',
		headers: getAuthHeaders(),
		credentials: 'include',
		body: JSON.stringify(typeof ttlSeconds === 'number' ? { ttlSeconds } : {})
	});

	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.error || `Failed to renew media gateway session (${response.status})`);
	}

	const body = await response.json() as MediaGatewaySessionResponse;
	return body.session;
}

export async function getMediaGatewaySession(sessionId: string): Promise<MediaGatewaySession | null> {
	const response = await fetch(`${getServerUrl()}/api/media/gateway/session/${encodeURIComponent(sessionId)}`, {
		method: 'GET',
		headers: getAuthHeaders(),
		credentials: 'include'
	});

	if (response.status === 404) {
		return null;
	}

	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.error || `Failed to fetch media gateway session (${response.status})`);
	}

	const body = await response.json() as MediaGatewaySessionResponse;
	return body.session;
}

export async function createLivekitAccessToken(channelId: string, displayName?: string): Promise<LivekitAccessTokenResponse> {
	const livekitTokenUrl = new URL(`${getServerUrl()}/api/media/livekit/token`);
	const sfuRelayId = getPreferredSfuRelayId();
	if (typeof sfuRelayId === 'number' && sfuRelayId > 0) {
		livekitTokenUrl.searchParams.set('relayId', String(sfuRelayId));
	}

	const response = await fetch(livekitTokenUrl.toString(), {
		method: 'POST',
		headers: getAuthHeaders(),
		credentials: 'include',
		body: JSON.stringify({ channelId, displayName })
	});

	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.error || `Failed to create LiveKit token (${response.status})`);
	}

	return await response.json() as LivekitAccessTokenResponse;
}
