import type { IncomingMessage, ServerResponse } from 'http';
import { createHmac } from 'crypto';
import { randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import { relayRepository } from '../db/repositories/relayRepository.js';
import {
	getBoosterRelayComponentConfigState,
	getEffectiveBoosterRelayMode,
	getRequestedBoosterRelayMode
} from '../relay/boosterRelayMode.js';
import { parseRelayMetadata } from '../relay/relayMetadata.js';
import { getSelfHostedBoosterRelaySnapshot } from '../relay/selfHostedBoosterRelay.js';
import type {
	LivekitAccessTokenResponse,
	MediaGatewayHealthSnapshot,
	MediaGatewaySession,
	MediaGatewaySessionKind,
	MediaGatewaySessionResponse,
	MediaGatewaySessionsResponse,
	MediaRelaySelectionSource,
	ServerMediaRuntimeResponse,
	SfuProvider,
	TurnCredentialsResponse
} from '../../../shared/mediaContracts.js';
import {
	isInvalidJsonBodyError,
	isRequestBodyTooLargeError,
	readJsonObjectBody
} from '../utils/requestBodies.js';

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
	mediaPlaneReady?: boolean;
}

const gatewayHeartbeat: GatewayHeartbeatState = {
	lastSeenAt: 0
};

interface GatewaySessionRecord extends MediaGatewaySession {
	userId: number;
}

interface LivekitAccessTokenPayload {
	iss: string;
	sub: string;
	nbf: number;
	exp: number;
	video: {
		roomJoin: boolean;
		room: string;
		canPublish: boolean;
		canSubscribe: boolean;
		canPublishData: boolean;
	};
	name?: string;
	metadata?: string;
}

const gatewaySessions = new Map<string, GatewaySessionRecord>();
let gatewayPortOffset = 0;

function isGatewayAuthorized(req: IncomingMessage): boolean {
	const configuredKey = process.env.MEDIA_GATEWAY_KEY;
	if (!configuredKey) return false;
	const provided = req.headers['x-media-gateway-key'];
	return typeof provided === 'string' && provided === configuredKey;
}

function clampInt(value: number, min: number, max: number): number {
	return Math.min(Math.max(Math.floor(value), min), max);
}

function getGatewayHeartbeatTimeoutMs(): number {
	return clampInt(numberFromEnv(process.env.MEDIA_GATEWAY_HEARTBEAT_TIMEOUT_MS, 45_000), 10_000, 600_000);
}

function getGatewaySessionDefaultTtlSeconds(): number {
	return clampInt(numberFromEnv(process.env.MEDIA_SRT_SESSION_TTL_SECONDS, 900), 60, 86_400);
}

function getGatewaySessionBasePort(): number {
	return clampInt(numberFromEnv(process.env.MEDIA_SRT_BASE_PORT, 7000), 1024, 65535);
}

function getGatewayUrl(): string | null {
	const value = (process.env.MEDIA_SRT_GATEWAY_URL || '').trim();
	if (!value) return null;
	return value.replace(/\/+$/, '');
}

function getLivekitUrl(): string | null {
	const value = (process.env.LIVEKIT_URL || '').trim();
	if (!value) return null;
	return value.replace(/\/+$/, '');
}

function isLivekitConfigured(): boolean {
	return Boolean(getLivekitUrl() && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
}

function getSfuProvider(): SfuProvider {
	const raw = (process.env.SFU_PROVIDER || '').trim().toLowerCase();
	if (raw === 'livekit') return 'livekit';
	return 'none';
}

type MediaRuntimeBoosterRelaySnapshot = NonNullable<
	NonNullable<ServerMediaRuntimeResponse['media']>['boosterRelay']
>;

function buildBoosterRelayRuntimeState(): MediaRuntimeBoosterRelaySnapshot {
	const requestedMode = getRequestedBoosterRelayMode();
	const effectiveMode = getEffectiveBoosterRelayMode();
	const { turnConfigured, sfuConfigured, gatewayConfigured } = getBoosterRelayComponentConfigState();
	const gatewayHealthy = isGatewayHealthyNow();
	const gatewayMediaPlaneReady = isGatewayMediaPlaneReadyNow();
	const selfAdvertisement = getSelfHostedBoosterRelaySnapshot();

	return {
		requestedMode,
		effectiveMode,
		selfHosted: requestedMode !== 'off' || effectiveMode !== 'off',
		selfAdvertisement,
		components: {
			turnConfigured,
			sfuConfigured,
			gatewayConfigured,
			gatewayHealthy,
			gatewayMediaPlaneReady
		}
	};
}

function isSrtGatewayEnabledByConfig(): boolean {
	return boolFromEnv(process.env.MEDIA_SRT_GATEWAY_ENABLED, false);
}

function isGatewayHealthyNow(): boolean {
	const timeoutMs = getGatewayHeartbeatTimeoutMs();
	return gatewayHeartbeat.lastSeenAt > 0 && Date.now() - gatewayHeartbeat.lastSeenAt < timeoutMs;
}

function isGatewayMediaPlaneReadyNow(): boolean {
	return gatewayHeartbeat.mediaPlaneReady === true;
}

function buildSrtEndpoint(sessionId: string, accessToken: string, mode: 'caller' | 'listener', port: number): string {
	const gatewayUrl = getGatewayUrl();
	const host = gatewayUrl ? new URL(gatewayUrl).hostname : 'localhost';
	const streamId = mode === 'caller' ? `publish:${sessionId}:${accessToken}` : `playback:${sessionId}:${accessToken}`;
	return `srt://${host}:${port}?mode=${mode}&streamid=${encodeURIComponent(streamId)}`;
}

function pruneExpiredGatewaySessions(now = Date.now()): void {
	for (const [sessionId, session] of gatewaySessions.entries()) {
		if (session.expiresAt <= now || session.status !== 'open') {
			gatewaySessions.delete(sessionId);
		}
	}
}

function sanitizeSessionForClient(session: GatewaySessionRecord): MediaGatewaySession {
	return {
		sessionId: session.sessionId,
		channelId: session.channelId,
		kind: session.kind,
		status: session.status,
		transport: session.transport,
		gatewayUrl: session.gatewayUrl,
		publishUrl: session.publishUrl,
		playbackUrl: session.playbackUrl,
		accessToken: session.accessToken,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		expiresAt: session.expiresAt
	};
}

function sanitizeSessionForGateway(session: GatewaySessionRecord) {
	return {
		sessionId: session.sessionId,
		channelId: session.channelId,
		kind: session.kind,
		status: session.status,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		expiresAt: session.expiresAt,
		publishUrl: session.publishUrl,
		playbackUrl: session.playbackUrl
	};
}

async function parseJsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
	try {
		return await readJsonObjectBody(req);
	} catch (error) {
		if (isRequestBodyTooLargeError(error)) {
			res.writeHead(413, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Media payload too large' }));
			return null;
		}
		if (isInvalidJsonBodyError(error)) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid JSON body' }));
			return null;
		}
		console.error('[MediaGateway] Failed reading request body:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to read request body' }));
		return null;
	}
}

interface MintedTurnCredentials {
	username: string;
	credential: string;
	expiresAt: number;
	ttlSeconds: number;
}

interface ResolvedTurnTarget {
	server: string;
	port: number;
	useTurns: boolean;
	realm: string | null;
	relayId: number | null;
	relayName: string | null;
	source: MediaRelaySelectionSource;
}

interface ResolvedLivekitTarget {
	url: string;
	relayId: number | null;
	relayName: string | null;
	source: MediaRelaySelectionSource;
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

function resolveRequestedTurnTarget(req: IncomingMessage): ResolvedTurnTarget | null {
	const requestUrl = new URL(req.url || '/api/media/turn-credentials', 'http://localhost');
	const requestedRelayIdRaw = requestUrl.searchParams.get('relayId');
	const originTurnServer = (process.env.TURN_EXTERNAL_IP || '').trim() || null;
	const originTurnRealm = (process.env.TURN_REALM || '').trim() || null;
	const originTurnPort = numberFromEnv(process.env.TURN_PORT, 3478);
	const originUseTurns = boolFromEnv(process.env.TURN_USE_TLS, false);

	if (requestedRelayIdRaw) {
		const requestedRelayId = Number.parseInt(requestedRelayIdRaw, 10);
		if (Number.isFinite(requestedRelayId) && requestedRelayId > 0) {
			const relay = relayRepository.findById(requestedRelayId);
			if (relay && relay.approved === 1 && (relay.status === 'active' || relay.status === 'degraded')) {
				const metadata = parseRelayMetadata(relay.metadata_json);
				if (metadata?.capabilities.turn && metadata.turn?.server) {
					return {
						server: metadata.turn.server,
						port: metadata.turn.port,
						useTurns: metadata.turn.useTurns,
						realm: metadata.turn.realm || originTurnRealm,
						relayId: relay.relay_id,
						relayName: relay.name,
						source: 'relay'
					};
				}
			}
		}
	}

	if (!originTurnServer || !originTurnRealm) {
		return null;
	}

	return {
		server: originTurnServer,
		port: originTurnPort,
		useTurns: originUseTurns,
		realm: originTurnRealm,
		relayId: null,
		relayName: null,
		source: 'origin'
	};
}

function resolveRequestedLivekitTarget(req: IncomingMessage): ResolvedLivekitTarget | null {
	const requestUrl = new URL(req.url || '/api/media/livekit/token', 'http://localhost');
	const requestedRelayIdRaw = requestUrl.searchParams.get('relayId');
	const originLivekitUrl = getLivekitUrl();

	if (requestedRelayIdRaw) {
		const requestedRelayId = Number.parseInt(requestedRelayIdRaw, 10);
		if (Number.isFinite(requestedRelayId) && requestedRelayId > 0) {
			const relay = relayRepository.findById(requestedRelayId);
			if (relay && relay.approved === 1 && (relay.status === 'active' || relay.status === 'degraded')) {
				const metadata = parseRelayMetadata(relay.metadata_json);
				if (metadata?.capabilities.sfu && metadata.sfu?.provider === 'livekit' && metadata.sfu.url) {
					return {
						url: metadata.sfu.url,
						relayId: relay.relay_id,
						relayName: relay.name,
						source: 'relay'
					};
				}
			}
		}
	}

	if (!originLivekitUrl) {
		return null;
	}

	return {
		url: originLivekitUrl,
		relayId: null,
		relayName: null,
		source: 'origin'
	};
}


// GET /api/media/runtime
// Provides server runtime hints for media quality transport paths.
export async function handleGetMediaRuntime(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const srtGatewayEnabled = isSrtGatewayEnabledByConfig();
		const localEnhancedEnabled = boolFromEnv(process.env.MEDIA_LOCAL_ENHANCED_ENABLED, true);
		const boosterRelay = buildBoosterRelayRuntimeState();
		const payload: ServerMediaRuntimeResponse = {
			media: {
				localEnhancedEnabled,
				srtGatewayEnabled,
				srtGatewayUrl: getGatewayUrl(),
				opus: {
					audioBitrateWeb: numberFromEnv(process.env.MEDIA_OPUS_AUDIO_WEB_BITRATE, 64000),
					audioBitrateLocal: numberFromEnv(process.env.MEDIA_OPUS_AUDIO_LOCAL_BITRATE, 96000)
				},
				turn: {
					configured: boosterRelay.components?.turnConfigured,
					server: (process.env.TURN_EXTERNAL_IP || '').trim() || null,
					port: numberFromEnv(process.env.TURN_PORT, 3478),
					useTurns: boolFromEnv(process.env.TURN_USE_TLS, false)
				},
				gateway: {
					configured: Boolean(getGatewayUrl()),
					heartbeatTimeoutMs: getGatewayHeartbeatTimeoutMs(),
					healthy: isGatewayHealthyNow(),
					mediaPlaneReady: isGatewayMediaPlaneReadyNow(),
					lastSeenAt: gatewayHeartbeat.lastSeenAt || null,
					activeStreams: gatewayHeartbeat.activeStreams ?? 0,
					version: gatewayHeartbeat.version || null,
					region: gatewayHeartbeat.region || null
				},
				livekit: {
					configured: isLivekitConfigured(),
					url: getLivekitUrl()
				},
				sfu: {
					provider: getSfuProvider(),
					enabled: getSfuProvider() !== 'none'
				},
				boosterRelay
			},
			notes: {
				srtDirectBrowserSupported: false,
				message: 'SRT is expected to run through a server-side media gateway, not directly from browser WebRTC peers.'
			}
		};

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(payload));
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
		const target = resolveRequestedTurnTarget(req);

		if (!target || !target.server || !target.realm) {
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

		const responsePayload: TurnCredentialsResponse = {
			turn: {
				server: target.server,
				port: target.port,
				realm: target.realm,
				useTurns: target.useTurns,
				relayId: target.relayId,
				relayName: target.relayName,
				source: target.source,
				...minted
			}
		};
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(responsePayload));
	} catch (error) {
		console.error('[TURN] Failed to mint TURN credentials:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to mint TURN credentials' }));
	}
}

// POST /api/media/livekit/token
// Returns a short-lived access token for joining a LiveKit room.
export async function handleCreateLivekitToken(
	req: IncomingMessage,
	res: ServerResponse,
	userId: number
): Promise<void> {
	if (getSfuProvider() !== 'livekit') {
		res.writeHead(503, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'LiveKit provider is not enabled' }));
		return;
	}
	const livekitTarget = resolveRequestedLivekitTarget(req);
	const apiKey = process.env.LIVEKIT_API_KEY;
	const apiSecret = process.env.LIVEKIT_API_SECRET;
	if (!livekitTarget?.url || !apiKey || !apiSecret) {
		res.writeHead(503, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'LiveKit is not configured' }));
		return;
	}

	const payload = await parseJsonBody(req, res);
	if (payload == null) return;
	const channelIdRaw = payload.channelId;
	const displayNameRaw = payload.displayName;
	const roomName = typeof channelIdRaw === 'string' && channelIdRaw.trim().length > 0
		? channelIdRaw.trim()
		: '';
	if (!roomName) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'channelId is required' }));
		return;
	}

	const now = Math.floor(Date.now() / 1000);
	const identity = `user:${userId}`;
	const tokenPayload: LivekitAccessTokenPayload = {
		iss: apiKey,
		sub: identity,
		nbf: now - 10,
		exp: now + 3600,
		video: {
			roomJoin: true,
			room: roomName,
			canPublish: true,
			canSubscribe: true,
			canPublishData: true
		},
		name: typeof displayNameRaw === 'string' && displayNameRaw.trim().length > 0 ? displayNameRaw.trim() : undefined,
		metadata: JSON.stringify({ userId })
	};
	const token = jwt.sign(tokenPayload, apiSecret, { algorithm: 'HS256' });

	const responsePayload: LivekitAccessTokenResponse = {
		token,
		url: livekitTarget.url,
		roomName,
		identity,
		relayId: livekitTarget.relayId,
		relayName: livekitTarget.relayName,
		source: livekitTarget.source
	};
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(responsePayload));
}


// POST /api/media/gateway-heartbeat
// Optional SRT gateway can report health/stream load to backend.
export async function handleMediaGatewayHeartbeat(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (!isGatewayAuthorized(req)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Unauthorized gateway heartbeat' }));
		return;
	}

	const payload = await parseJsonBody(req, res);
	if (payload == null) return;

	gatewayHeartbeat.lastSeenAt = Date.now();
	gatewayHeartbeat.version = typeof payload.version === 'string' ? payload.version : undefined;
	gatewayHeartbeat.region = typeof payload.region === 'string' ? payload.region : undefined;
	gatewayHeartbeat.activeStreams = typeof payload.activeStreams === 'number' ? payload.activeStreams : 0;
	gatewayHeartbeat.mediaPlaneReady = payload.mediaPlaneReady === true;

	const activeSessionIds = Array.isArray(payload.activeSessionIds) ? payload.activeSessionIds : [];
	for (const sessionId of activeSessionIds) {
		if (typeof sessionId !== 'string') continue;
		const session = gatewaySessions.get(sessionId);
		if (!session) continue;
		session.updatedAt = Date.now();
		gatewaySessions.set(sessionId, session);
	}
	pruneExpiredGatewaySessions();

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ ok: true }));
}

// POST /api/media/gateway/session
// Authenticated clients request an SRT gateway session for control-plane orchestration.
export async function handleCreateMediaGatewaySession(
	req: IncomingMessage,
	res: ServerResponse,
	userId: number
): Promise<void> {
	if (!isSrtGatewayEnabledByConfig()) {
		res.writeHead(503, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'SRT gateway mode is disabled' }));
		return;
	}

	const gatewayUrl = getGatewayUrl();
	if (!gatewayUrl) {
		res.writeHead(503, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'SRT gateway URL is not configured' }));
		return;
	}

	if (!isGatewayHealthyNow()) {
		res.writeHead(503, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'SRT gateway is unavailable (no fresh heartbeat)' }));
		return;
	}
	if (!isGatewayMediaPlaneReadyNow()) {
		res.writeHead(503, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'SRT gateway media plane is not ready' }));
		return;
	}

	const payload = await parseJsonBody(req, res);
	if (payload == null) return;

	const kindRaw = payload.kind;
	const kind: GatewaySessionKind = kindRaw === 'screen' || kindRaw === 'recording' ? kindRaw : 'voice';
	const channelIdRaw = payload.channelId;
	const channelId = typeof channelIdRaw === 'string' && channelIdRaw.trim().length > 0 ? channelIdRaw.trim() : null;
	const requestedTtl = typeof payload.ttlSeconds === 'number' ? payload.ttlSeconds : getGatewaySessionDefaultTtlSeconds();
	const ttlSeconds = clampInt(requestedTtl, 60, 86_400);

	pruneExpiredGatewaySessions();

	const sessionId = randomBytes(16).toString('hex');
	const accessToken = randomBytes(24).toString('hex');
	const basePort = getGatewaySessionBasePort();
	const port = basePort + (gatewayPortOffset % 1000);
	gatewayPortOffset += 1;

	const now = Date.now();
	const session: GatewaySessionRecord = {
		sessionId,
		userId,
		channelId,
		kind,
		status: 'open',
		createdAt: now,
		updatedAt: now,
		expiresAt: now + (ttlSeconds * 1000),
		transport: 'srt',
		gatewayUrl,
		publishUrl: buildSrtEndpoint(sessionId, accessToken, 'caller', port),
		playbackUrl: buildSrtEndpoint(sessionId, accessToken, 'listener', port),
		accessToken
	};

	gatewaySessions.set(sessionId, session);

	const gateway: MediaGatewayHealthSnapshot = {
		healthy: isGatewayHealthyNow(),
		mediaPlaneReady: isGatewayMediaPlaneReadyNow(),
		lastSeenAt: gatewayHeartbeat.lastSeenAt || null,
		region: gatewayHeartbeat.region || null,
		version: gatewayHeartbeat.version || null
	};
	const responsePayload: MediaGatewaySessionResponse = {
		session: sanitizeSessionForClient(session),
		gateway
	};
	res.writeHead(201, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(responsePayload));
}

// GET /api/media/gateway/sessions
// Returns open sessions for the authenticated user.
export async function handleListMediaGatewaySessions(
	_req: IncomingMessage,
	res: ServerResponse,
	userId: number
): Promise<void> {
	pruneExpiredGatewaySessions();
	const sessions = [...gatewaySessions.values()]
		.filter((session) => session.userId === userId && session.status === 'open')
		.map(sanitizeSessionForClient);

	const responsePayload: MediaGatewaySessionsResponse = { sessions };
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(responsePayload));
}

// GET /api/media/gateway/session/:sessionId
export async function handleGetMediaGatewaySession(
	_req: IncomingMessage,
	res: ServerResponse,
	userId: number,
	sessionId: string
): Promise<void> {
	pruneExpiredGatewaySessions();
	const session = gatewaySessions.get(sessionId);
	if (!session || session.status !== 'open') {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Session not found' }));
		return;
	}

	if (session.userId !== userId) {
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Not allowed to access this session' }));
		return;
	}

	const responsePayload: MediaGatewaySessionResponse = { session: sanitizeSessionForClient(session) };
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(responsePayload));
}

// POST /api/media/gateway/session/:sessionId/close
export async function handleCloseMediaGatewaySession(
	_req: IncomingMessage,
	res: ServerResponse,
	userId: number,
	sessionId: string
): Promise<void> {
	pruneExpiredGatewaySessions();
	const session = gatewaySessions.get(sessionId);
	if (!session) {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Session not found' }));
		return;
	}

	if (session.userId !== userId) {
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Not allowed to close this session' }));
		return;
	}

	session.status = 'closed';
	session.updatedAt = Date.now();
	gatewaySessions.delete(sessionId);

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ ok: true, sessionId }));
}

// POST /api/media/gateway/session/:sessionId/renew
export async function handleRenewMediaGatewaySession(
	req: IncomingMessage,
	res: ServerResponse,
	userId: number,
	sessionId: string
): Promise<void> {
	pruneExpiredGatewaySessions();
	const session = gatewaySessions.get(sessionId);
	if (!session || session.status !== 'open') {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Session not found' }));
		return;
	}

	if (session.userId !== userId) {
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Not allowed to renew this session' }));
		return;
	}

	const payload = await parseJsonBody(req, res);
	if (payload == null) return;

	const requestedTtl = typeof payload.ttlSeconds === 'number' ? payload.ttlSeconds : getGatewaySessionDefaultTtlSeconds();
	const ttlSeconds = clampInt(requestedTtl, 60, 86_400);
	const now = Date.now();
	session.updatedAt = now;
	session.expiresAt = now + (ttlSeconds * 1000);
	gatewaySessions.set(sessionId, session);

	const responsePayload: MediaGatewaySessionResponse = { session: sanitizeSessionForClient(session) };
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(responsePayload));
}

// GET /api/media/gateway/control/sessions
// Consumed by the gateway daemon (key-authenticated) to reconcile desired sessions.
export async function handleGetMediaGatewayControlSessions(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (!isGatewayAuthorized(req)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Unauthorized' }));
		return;
	}

	pruneExpiredGatewaySessions();
	const sessions = [...gatewaySessions.values()]
		.filter((session) => session.status === 'open')
		.map(sanitizeSessionForGateway);

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({
		sessions,
		gateway: {
			healthy: isGatewayHealthyNow(),
			lastSeenAt: gatewayHeartbeat.lastSeenAt || null
		}
	}));
}
