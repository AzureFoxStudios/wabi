import { getServerUrl } from './serverUrl';

export type MediaGatewaySessionKind = 'voice' | 'screen' | 'recording';

export interface MediaGatewaySession {
	sessionId: string;
	channelId: string | null;
	kind: MediaGatewaySessionKind;
	status: 'open' | 'closed';
	transport: 'srt';
	gatewayUrl: string;
	publishUrl: string;
	playbackUrl: string;
	accessToken: string;
	createdAt: number;
	updatedAt: number;
	expiresAt: number;
}

export interface LivekitAccessTokenResponse {
	token: string;
	url: string;
	roomName: string;
	identity: string;
}

function getAuthToken(): string | null {
	if (typeof localStorage === 'undefined') return null;
	return localStorage.getItem('token') || localStorage.getItem('authToken');
}

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
		body: JSON.stringify({ channelId, kind })
	});

	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.error || `Failed to create media gateway session (${response.status})`);
	}

	const body = await response.json() as { session: MediaGatewaySession };
	return body.session;
}

export async function closeMediaGatewaySession(sessionId: string): Promise<void> {
	const response = await fetch(`${getServerUrl()}/api/media/gateway/session/${encodeURIComponent(sessionId)}/close`, {
		method: 'POST',
		headers: getAuthHeaders()
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
		body: JSON.stringify(typeof ttlSeconds === 'number' ? { ttlSeconds } : {})
	});

	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.error || `Failed to renew media gateway session (${response.status})`);
	}

	const body = await response.json() as { session: MediaGatewaySession };
	return body.session;
}

export async function getMediaGatewaySession(sessionId: string): Promise<MediaGatewaySession | null> {
	const response = await fetch(`${getServerUrl()}/api/media/gateway/session/${encodeURIComponent(sessionId)}`, {
		method: 'GET',
		headers: getAuthHeaders()
	});

	if (response.status === 404) {
		return null;
	}

	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.error || `Failed to fetch media gateway session (${response.status})`);
	}

	const body = await response.json() as { session: MediaGatewaySession };
	return body.session;
}

export async function createLivekitAccessToken(channelId: string, displayName?: string): Promise<LivekitAccessTokenResponse> {
	const response = await fetch(`${getServerUrl()}/api/media/livekit/token`, {
		method: 'POST',
		headers: getAuthHeaders(),
		body: JSON.stringify({ channelId, displayName })
	});

	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.error || `Failed to create LiveKit token (${response.status})`);
	}

	return await response.json() as LivekitAccessTokenResponse;
}
