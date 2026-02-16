import type { IncomingMessage, ServerResponse } from 'http';
import { createHmac } from 'crypto';

function boolFromEnv(value: string | undefined, fallback: boolean = false): boolean {
	if (value == null) return fallback;
	return value === 'true' || value === '1';
}

function numberFromEnv(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function getTurnCredentialTtlSeconds(): number {
	const configured = numberFromEnv(process.env.TURN_CREDENTIAL_TTL_SECONDS, 3600);
	// Guardrail against unreasonable values.
	return Math.min(Math.max(configured, 60), 86400);
}

interface GatewayHeartbeatState {
	lastSeenAt: number;
	version?: string;
	region?: string;
	activeStreams?: number;
}

const gatewayHeartbeat: GatewayHeartbeatState = {
	lastSeenAt: 0
};

function isGatewayAuthorized(req: IncomingMessage): boolean {
	const configuredKey = process.env.MEDIA_GATEWAY_KEY;
	if (!configuredKey) return false;
	const provided = req.headers['x-media-gateway-key'];
	return typeof provided === 'string' && provided === configuredKey;
}

interface MintedTurnCredentials {
	username: string;
	credential: string;
	expiresAt: number;
	ttlSeconds: number;
}

function mintTurnCredentials(userId: number): MintedTurnCredentials | null {
	const sharedSecret = process.env.TURN_SHARED_SECRET;
	if (!sharedSecret) {
		return null;
	}

	const ttlSeconds = getTurnCredentialTtlSeconds();
	const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
	const username = `${expiresAt}:${userId}`;
	const credential = createHmac('sha1', sharedSecret).update(username).digest('base64');

	return {
		username,
		credential,
		expiresAt,
		ttlSeconds
	};
}


// GET /api/media/runtime
// Provides server runtime hints for media quality transport paths.
export async function handleGetMediaRuntime(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const srtGatewayEnabled = boolFromEnv(process.env.MEDIA_SRT_GATEWAY_ENABLED, false);
		const localEnhancedEnabled = boolFromEnv(process.env.MEDIA_LOCAL_ENHANCED_ENABLED, true);

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			media: {
				localEnhancedEnabled,
				srtGatewayEnabled,
				srtGatewayUrl: process.env.MEDIA_SRT_GATEWAY_URL || null,
				opus: {
					audioBitrateWeb: numberFromEnv(process.env.MEDIA_OPUS_AUDIO_WEB_BITRATE, 64000),
					audioBitrateLocal: numberFromEnv(process.env.MEDIA_OPUS_AUDIO_LOCAL_BITRATE, 96000)
				},
				gateway: {
					configured: Boolean(process.env.MEDIA_SRT_GATEWAY_URL),
					heartbeatTimeoutMs: numberFromEnv(process.env.MEDIA_GATEWAY_HEARTBEAT_TIMEOUT_MS, 45_000),
					healthy: gatewayHeartbeat.lastSeenAt > 0 && Date.now() - gatewayHeartbeat.lastSeenAt < numberFromEnv(process.env.MEDIA_GATEWAY_HEARTBEAT_TIMEOUT_MS, 45_000),
					lastSeenAt: gatewayHeartbeat.lastSeenAt || null,
					activeStreams: gatewayHeartbeat.activeStreams ?? 0,
					version: gatewayHeartbeat.version || null,
					region: gatewayHeartbeat.region || null
				}
			},
			notes: {
				srtDirectBrowserSupported: false,
				message: 'SRT is expected to run through a server-side media gateway, not directly from browser WebRTC peers.'
			}
		}));
	} catch (error) {
		console.error('[MediaRuntime] Failed to return media runtime config:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to read media runtime configuration' }));
	}
}

// GET /api/media/turn-credentials
// Returns short-lived TURN REST credentials for authenticated users.
export async function handleGetTurnCredentials(req: IncomingMessage, res: ServerResponse, userId: number): Promise<void> {
	try {
		const turnServer = process.env.TURN_EXTERNAL_IP || null;
		const turnRealm = process.env.TURN_REALM || null;
		const turnPort = numberFromEnv(process.env.TURN_PORT, 3478);
		const useTurns = boolFromEnv(process.env.TURN_USE_TLS, false);

		if (!turnServer || !turnRealm) {
			res.writeHead(503, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'TURN server is not configured' }));
			return;
		}

		const minted = mintTurnCredentials(userId);
		if (!minted) {
			res.writeHead(503, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'TURN shared secret is not configured' }));
			return;
		}

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			turn: {
				server: turnServer,
				port: turnPort,
				realm: turnRealm,
				useTurns,
				...minted
			}
		}));
	} catch (error) {
		console.error('[TURN] Failed to mint TURN credentials:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to mint TURN credentials' }));
	}
}


// POST /api/media/gateway-heartbeat
// Optional SRT gateway can report health/stream load to backend.
export async function handleMediaGatewayHeartbeat(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (!isGatewayAuthorized(req)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Unauthorized gateway heartbeat' }));
		return;
	}

	let body = '';
	await new Promise<void>((resolve, reject) => {
		req.on('data', chunk => {
			body += chunk.toString();
		});
		req.on('end', () => resolve());
		req.on('error', reject);
	});

	let payload: Record<string, unknown> = {};
	if (body) {
		try {
			payload = JSON.parse(body);
		} catch {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid JSON in gateway heartbeat' }));
			return;
		}
	}

	gatewayHeartbeat.lastSeenAt = Date.now();
	gatewayHeartbeat.version = typeof payload.version === 'string' ? payload.version : undefined;
	gatewayHeartbeat.region = typeof payload.region === 'string' ? payload.region : undefined;
	gatewayHeartbeat.activeStreams = typeof payload.activeStreams === 'number' ? payload.activeStreams : 0;

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ ok: true }));
}
