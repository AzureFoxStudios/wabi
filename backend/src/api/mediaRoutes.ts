import type { IncomingMessage, ServerResponse } from 'http';
import { mediaGatewayRepository, type GatewayReadinessState } from '../db/repositories/mediaGatewayRepository.js';

function boolFromEnv(value: string | undefined, fallback: boolean = false): boolean {
	if (value == null) return fallback;
	return value === 'true' || value === '1';
}

function numberFromEnv(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function isGatewayAuthorized(req: IncomingMessage): boolean {
	const configuredKey = process.env.MEDIA_GATEWAY_KEY;
	if (!configuredKey) return false;
	const provided = req.headers['x-media-gateway-key'];
	return typeof provided === 'string' && provided === configuredKey;
}

function parseReadinessState(value: unknown): GatewayReadinessState {
	if (value === 'starting' || value === 'ready' || value === 'degraded' || value === 'draining' || value === 'offline') {
		return value;
	}
	return 'starting';
}

async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	let body = '';
	await new Promise<void>((resolve, reject) => {
		req.on('data', chunk => {
			body += chunk.toString();
		});
		req.on('end', () => resolve());
		req.on('error', reject);
	});

	if (!body) return {};
	try {
		return JSON.parse(body);
	} catch {
		throw new Error('Invalid JSON payload');
	}
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

interface StreamAccessRule {
	tenantId: string;
	workspaceIds: string[];
	channelIds: string[];
}

function parseStreamAccessRules(): Record<string, StreamAccessRule> {
	const raw = process.env.MEDIA_STREAM_ACCESS_RULES;
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as Record<string, Partial<StreamAccessRule>>;
		const normalized: Record<string, StreamAccessRule> = {};
		for (const [token, rule] of Object.entries(parsed)) {
			normalized[token] = {
				tenantId: typeof rule.tenantId === 'string' && rule.tenantId ? rule.tenantId : 'default',
				workspaceIds: Array.isArray(rule.workspaceIds) ? rule.workspaceIds.filter((item): item is string => typeof item === 'string') : ['*'],
				channelIds: Array.isArray(rule.channelIds) ? rule.channelIds.filter((item): item is string => typeof item === 'string') : ['*']
			};
		}
		return normalized;
	} catch (error) {
		console.error('[MediaGateway] MEDIA_STREAM_ACCESS_RULES is invalid JSON:', error);
		return {};
	}
}

function authorizeStreamToken(req: IncomingMessage, workspaceId: string, channelId: string): { ok: true; tenantId: string; tokenId: string } | { ok: false; error: string } {
	const token = req.headers['x-media-stream-token'];
	if (typeof token !== 'string' || !token) {
		return { ok: false, error: 'Missing stream token' };
	}

	const rules = parseStreamAccessRules();
	const rule = rules[token];
	if (!rule) {
		return { ok: false, error: 'Invalid stream token' };
	}

	const workspaceAllowed = rule.workspaceIds.includes('*') || rule.workspaceIds.includes(workspaceId);
	const channelAllowed = rule.channelIds.includes('*') || rule.channelIds.includes(channelId);
	if (!workspaceAllowed || !channelAllowed) {
		return { ok: false, error: 'Token is not authorized for workspace/channel scope' };
	}

	return { ok: true, tenantId: rule.tenantId, tokenId: token.slice(0, 8) };
}

// GET /api/media/runtime
export async function handleGetMediaRuntime(_req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const srtGatewayEnabled = boolFromEnv(process.env.MEDIA_SRT_GATEWAY_ENABLED, false);
		const localEnhancedEnabled = boolFromEnv(process.env.MEDIA_LOCAL_ENHANCED_ENABLED, true);
		const heartbeatTimeoutMs = numberFromEnv(process.env.MEDIA_GATEWAY_HEARTBEAT_TIMEOUT_MS, 45_000);
		const runtime = mediaGatewayRepository.getRuntimeRecord();
		const now = Date.now();
		const healthy = Boolean(runtime && now - runtime.last_seen_at < heartbeatTimeoutMs && runtime.readiness_state !== 'offline');

		writeJson(res, 200, {
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
					heartbeatTimeoutMs,
					healthy,
					status: runtime?.status ?? 'offline',
					readinessState: runtime?.readiness_state ?? 'offline',
					lastSeenAt: runtime?.last_seen_at ?? null,
					activeStreams: runtime?.active_streams ?? 0,
					version: runtime?.version ?? null,
					region: runtime?.region ?? null,
					instanceId: runtime?.instance_id ?? null,
					activeLeases: mediaGatewayRepository.countActiveLeases(now)
				}
			},
			notes: {
				srtDirectBrowserSupported: false,
				message: 'SRT is expected to run through a server-side media gateway, not directly from browser WebRTC peers.'
			}
		});
	} catch (error) {
		console.error('[MediaRuntime] Failed to return media runtime config:', error);
		writeJson(res, 500, { error: 'Failed to read media runtime configuration' });
	}
}

// POST /api/media/gateway/register
export async function handleMediaGatewayRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (!isGatewayAuthorized(req)) {
		writeJson(res, 401, { error: 'Unauthorized gateway register' });
		return;
	}

	try {
		const payload = await parseBody(req);
		const instanceId = typeof payload.instanceId === 'string' ? payload.instanceId : undefined;
		const runtime = mediaGatewayRepository.upsertRuntime({
			instanceId,
			status: typeof payload.status === 'string' ? payload.status : 'online',
			readinessState: parseReadinessState(payload.readinessState),
			version: typeof payload.version === 'string' ? payload.version : undefined,
			region: typeof payload.region === 'string' ? payload.region : undefined,
			activeStreams: typeof payload.activeStreams === 'number' ? payload.activeStreams : undefined,
			lastSeenAt: Date.now()
		});

		mediaGatewayRepository.audit({
			actorType: 'gateway',
			actorId: instanceId ?? 'unknown',
			action: 'gateway.register',
			metadata: { readinessState: runtime.readiness_state }
		});

		writeJson(res, 200, { ok: true, runtime });
	} catch (error) {
		writeJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid payload' });
	}
}

// POST /api/media/gateway-heartbeat
export async function handleMediaGatewayHeartbeat(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (!isGatewayAuthorized(req)) {
		writeJson(res, 401, { error: 'Unauthorized gateway heartbeat' });
		return;
	}

	try {
		const payload = await parseBody(req);
		mediaGatewayRepository.upsertRuntime({
			instanceId: typeof payload.instanceId === 'string' ? payload.instanceId : undefined,
			status: 'online',
			readinessState: parseReadinessState(payload.readinessState === undefined ? 'ready' : payload.readinessState),
			version: typeof payload.version === 'string' ? payload.version : undefined,
			region: typeof payload.region === 'string' ? payload.region : undefined,
			activeStreams: typeof payload.activeStreams === 'number' ? payload.activeStreams : undefined,
			lastSeenAt: Date.now()
		});
		writeJson(res, 200, { ok: true });
	} catch (error) {
		writeJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid payload' });
	}
}

// POST /api/media/gateway/streams/claim
export async function handleMediaGatewayStreamClaim(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (!isGatewayAuthorized(req)) {
		writeJson(res, 401, { error: 'Unauthorized gateway request' });
		return;
	}

	try {
		const payload = await parseBody(req);
		const streamId = typeof payload.streamId === 'string' ? payload.streamId : '';
		const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId : '';
		const channelId = typeof payload.channelId === 'string' ? payload.channelId : '';
		const ownerInstance = typeof payload.ownerInstance === 'string' && payload.ownerInstance ? payload.ownerInstance : 'gateway';
		const leaseTtlMsRaw = typeof payload.leaseTtlMs === 'number' ? payload.leaseTtlMs : 60_000;
		const leaseTtlMs = Math.max(10_000, Math.min(leaseTtlMsRaw, 300_000));

		if (!streamId || !workspaceId || !channelId) {
			writeJson(res, 400, { error: 'streamId, workspaceId, and channelId are required' });
			return;
		}

		const authz = authorizeStreamToken(req, workspaceId, channelId);
		if (!authz.ok) {
			writeJson(res, 403, { error: authz.error });
			return;
		}

		const result = mediaGatewayRepository.claimLease({
			streamId,
			tenantId: authz.tenantId,
			workspaceId,
			channelId,
			ownerInstance,
			leaseTtlMs
		});

		if (!result.granted || !result.lease) {
			mediaGatewayRepository.audit({
				actorType: 'gateway',
				actorId: ownerInstance,
				action: 'stream.claim.denied',
				streamId,
				workspaceId,
				channelId,
				metadata: { reason: 'lease_conflict', conflictOwner: result.conflict?.owner_instance }
			});
			writeJson(res, 409, {
				error: 'Stream already leased',
				conflict: {
					ownerInstance: result.conflict?.owner_instance,
					leaseExpiresAt: result.conflict?.lease_expires_at ?? null
				}
			});
			return;
		}

		mediaGatewayRepository.audit({
			actorType: 'gateway',
			actorId: ownerInstance,
			action: 'stream.claim.granted',
			streamId,
			workspaceId,
			channelId,
			metadata: { tokenId: authz.tokenId, leaseTtlMs }
		});

		writeJson(res, 200, {
			ok: true,
			lease: {
				streamId: result.lease.stream_id,
				leaseToken: result.lease.lease_token,
				leaseExpiresAt: result.lease.lease_expires_at,
				tenantId: result.lease.tenant_id,
				ownerInstance: result.lease.owner_instance
			}
		});
	} catch (error) {
		writeJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid payload' });
	}
}

// POST /api/media/gateway/streams/release
export async function handleMediaGatewayStreamRelease(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (!isGatewayAuthorized(req)) {
		writeJson(res, 401, { error: 'Unauthorized gateway request' });
		return;
	}

	try {
		const payload = await parseBody(req);
		const streamId = typeof payload.streamId === 'string' ? payload.streamId : '';
		const leaseToken = typeof payload.leaseToken === 'string' ? payload.leaseToken : '';
		const ownerInstance = typeof payload.ownerInstance === 'string' && payload.ownerInstance ? payload.ownerInstance : 'gateway';
		if (!streamId || !leaseToken) {
			writeJson(res, 400, { error: 'streamId and leaseToken are required' });
			return;
		}

		const released = mediaGatewayRepository.releaseLease(streamId, leaseToken);
		mediaGatewayRepository.audit({
			actorType: 'gateway',
			actorId: ownerInstance,
			action: released ? 'stream.release.success' : 'stream.release.miss',
			streamId,
			metadata: { providedLeaseTokenPrefix: leaseToken.slice(0, 8) }
		});

		if (!released) {
			writeJson(res, 404, { error: 'Active lease not found for stream/token combination' });
			return;
		}

		writeJson(res, 200, { ok: true });
	} catch (error) {
		writeJson(res, 400, { error: error instanceof Error ? error.message : 'Invalid payload' });
	}
}
