import { IncomingMessage, ServerResponse } from 'http';
import { getCommunityNodeAccessPolicy } from '../communityNodeAccess.js';
import { relayRepository } from '../db/repositories/relayRepository.js';
import { getAuthenticatedUserIdFromRequest } from '../auth/requestAuth.js';
import { parseRelayMetadata } from '../relay/relayMetadata.js';
import { announceCommunityNodeStatusChange } from '../communityNodeAnnouncements.js';
import { stateUserStore as userRepository } from '../state-plane/index.js';
import {
	isInvalidJsonBodyError as isInvalidJsonError,
	isRequestBodyTooLargeError as isPayloadTooLargeError,
	readJsonObjectBody
} from '../utils/requestBodies.js';
import type { DesktopHelperMode } from '../../../shared/runtimeAdminContracts.js';
import type { AdminRelayNode } from '../../../shared/relayContracts.js';

interface RateBucket {
	count: number;
	windowStartMs: number;
}

type RelayRequestBody = Record<string, unknown>;
const MAX_RELAY_BODY_BYTES = Math.max(
	1024,
	Math.min(1024 * 1024, Number(process.env.RELAY_MAX_BODY_BYTES || 64 * 1024))
);

const rateBuckets = new Map<string, RateBucket>();
let lastRateCleanupMs = 0;

function writeJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(payload));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getHeaderString(value: string | string[] | undefined): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

async function parseBody(req: IncomingMessage): Promise<RelayRequestBody> {
	return await readJsonObjectBody(req, MAX_RELAY_BODY_BYTES);
}

function getClientIp(req: IncomingMessage): string {
	const xfwd = req.headers['x-forwarded-for'];
	if (typeof xfwd === 'string' && xfwd.trim()) {
		return xfwd.split(',')[0].trim();
	}
	return req.socket.remoteAddress || 'unknown';
}

function isRateLimited(
	req: IncomingMessage,
	keyPrefix: string,
	maxRequests: number,
	windowMs: number
): boolean {
	const ip = getClientIp(req);
	const key = `${keyPrefix}:${ip}`;
	const now = Date.now();

	if (now - lastRateCleanupMs > 5 * 60_000) {
		for (const [bucketKey, bucket] of rateBuckets.entries()) {
			if (now - bucket.windowStartMs > 10 * windowMs) {
				rateBuckets.delete(bucketKey);
			}
		}
		lastRateCleanupMs = now;
	}

	const existing = rateBuckets.get(key);
	if (!existing || now - existing.windowStartMs >= windowMs) {
		rateBuckets.set(key, { count: 1, windowStartMs: now });
		return false;
	}

	existing.count += 1;
	return existing.count > maxRequests;
}

function normalizeOptionalString(value: unknown, maxLength: number): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, maxLength) : null;
}

function normalizeRequiredString(
	value: unknown,
	maxLength: number
): string | null {
	return normalizeOptionalString(value, maxLength);
}

function normalizeOptionalFiniteNumber(value: unknown): number | null | undefined {
	if (value == null || value === '') return undefined;
	const parsed = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(parsed)) return null;
	return parsed;
}

function normalizeOptionalInteger(value: unknown): number | null | undefined {
	const parsed = normalizeOptionalFiniteNumber(value);
	if (parsed == null || parsed === undefined) return parsed;
	return Number.isInteger(parsed) ? parsed : Math.trunc(parsed);
}

function normalizePositiveInteger(value: unknown): number | null {
	const parsed = normalizeOptionalInteger(value);
	if (parsed == null || parsed === undefined || parsed <= 0) return null;
	return parsed;
}

function normalizeMetadata(value: unknown): Record<string, unknown> | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	return isRecord(value) ? value : null;
}

function normalizeDesktopHelperMode(value: unknown): 'off' | DesktopHelperMode | null {
	return value === 'off' || value === 'files-only' || value === 'desktop-assist' ? value : null;
}

function normalizeDesktopHelperName(value: unknown): string | null {
	return normalizeOptionalString(value, 120);
}

function normalizeDesktopHelperId(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return /^[A-Za-z0-9._:-]{8,128}$/.test(trimmed) ? trimmed : null;
}

function getDesktopHelperUrl(userId: number, helperId: string): string {
	return `wabi-helper://desktop/${userId}/${helperId}`;
}

function getRelayAdminIds(): Set<number> {
	return new Set(
		(process.env.RELAY_ADMIN_USER_IDS || '1')
			.split(',')
			.map((value) => Number.parseInt(value.trim(), 10))
			.filter((value) => Number.isFinite(value) && value > 0)
	);
}

function isRelayAdmin(userId: number | null): userId is number {
	return typeof userId === 'number' && getRelayAdminIds().has(userId);
}

function buildDesktopHelperMetadata(params: {
	userId: number;
	username: string;
	mode: DesktopHelperMode;
	status: 'active' | 'offline';
	reason: string | null;
}): Record<string, unknown> {
	return {
		kind: 'desktop-helper',
		source: 'tauri-desktop',
		status: params.status,
		reason: params.reason,
		ownerUserId: params.userId,
		ownerUsername: params.username,
		helperMode: params.mode,
		capabilities: {
			fileRelay: false,
			turn: false,
			sfu: false,
			gateway: false,
			selfHosted: false,
			boosterMode: null
		},
		updatedAt: new Date().toISOString()
	};
}

function handleBodyError(
	res: ServerResponse,
	error: unknown,
	invalidMessage: string,
	tooLargeMessage: string
): void {
	if (isPayloadTooLargeError(error)) {
		writeJson(res, 413, { error: tooLargeMessage });
		return;
	}
	if (isInvalidJsonError(error)) {
		writeJson(res, 400, { error: invalidMessage });
		return;
	}
	writeJson(res, 500, { error: 'Unexpected request parsing failure' });
}

async function authenticateRelay(req: IncomingMessage): Promise<number | null> {
	const relayIdHeader = getHeaderString(req.headers['x-relay-id']);
	const apiKey = getHeaderString(req.headers['x-relay-key']);
	if (!relayIdHeader || !apiKey) return null;

	const relayId = normalizePositiveInteger(relayIdHeader);
	if (relayId == null) return null;

	const valid = await relayRepository.verifyApiKey(relayId, apiKey);
	return valid ? relayId : null;
}

export async function handleGetRelays(
	_req: IncomingMessage,
	res: ServerResponse
): Promise<void> {
	try {
		const relays = relayRepository.getActiveRelays();
		writeJson(res, 200, { relays });
	} catch (error) {
		console.error('[Relay] Get relays error:', error);
		writeJson(res, 500, { error: 'Failed to fetch relays' });
	}
}

export async function handleRelayRegister(
	req: IncomingMessage,
	res: ServerResponse
): Promise<void> {
	try {
		if (isRateLimited(req, 'relay-register', 15, 60_000)) {
			writeJson(res, 429, { error: 'Too many relay registration requests. Try again shortly.' });
			return;
		}

		const body = await parseBody(req);
		const url = normalizeRequiredString(body.url, 2048);
		const name = normalizeRequiredString(body.name, 120);
		const region = normalizeRequiredString(body.region, 64);
		const latitude = normalizeOptionalFiniteNumber(body.latitude);
		const longitude = normalizeOptionalFiniteNumber(body.longitude);
		const bandwidthMbps = normalizeOptionalInteger(body.bandwidth_mbps);
		const storageGb = normalizeOptionalInteger(body.storage_gb);
		const syncthingDeviceId = normalizeOptionalString(body.syncthing_device_id, 255);
		const metadata = normalizeMetadata(body.metadata);

		if (!url || !name || !region) {
			writeJson(res, 400, { error: 'url, name, and region are required' });
			return;
		}
		if (latitude === null || longitude === null || bandwidthMbps === null || storageGb === null) {
			writeJson(res, 400, {
				error: 'latitude, longitude, bandwidth_mbps, and storage_gb must be numeric when provided'
			});
			return;
		}
		if (body.metadata !== undefined && metadata === null) {
			writeJson(res, 400, { error: 'metadata must be an object when provided' });
			return;
		}

		let parsedUrl: URL;
		try {
			parsedUrl = new URL(url);
		} catch {
			writeJson(res, 400, { error: 'Invalid URL format' });
			return;
		}
		if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
			writeJson(res, 400, { error: 'Relay URL must use http or https' });
			return;
		}

		const normalizedUrl = parsedUrl.toString();
		const existing = relayRepository.findByUrl(normalizedUrl);
		if (existing) {
			writeJson(res, 409, { error: 'Relay with this URL already registered' });
			return;
		}

		const { relay_id, api_key } = await relayRepository.register({
			url: normalizedUrl,
			name,
			region,
			latitude,
			longitude,
			bandwidth_mbps: bandwidthMbps,
			storage_gb: storageGb,
			syncthing_device_id: syncthingDeviceId || undefined,
			metadata: metadata || undefined
		});

		console.log(`[Relay] New relay registered: ${name} (${normalizedUrl}) - ID: ${relay_id}`);
		writeJson(res, 201, {
			relay_id,
			api_key,
			status: 'pending',
			message: 'Relay registered. An admin must approve it before it goes active.'
		});
	} catch (error) {
		if (isPayloadTooLargeError(error) || isInvalidJsonError(error)) {
			handleBodyError(
				res,
				error,
				'Invalid JSON in request body',
				'Relay registration payload too large'
			);
			return;
		}
		console.error('[Relay] Register error:', error);
		writeJson(res, 500, { error: 'Failed to register relay' });
	}
}

export async function handleRelayHealth(
	req: IncomingMessage,
	res: ServerResponse
): Promise<void> {
	try {
		if (isRateLimited(req, 'relay-health', 240, 60_000)) {
			writeJson(res, 429, { error: 'Too many relay health updates. Slow down heartbeat interval.' });
			return;
		}

		const relayId = await authenticateRelay(req);
		if (!relayId) {
			writeJson(res, 401, { error: 'Invalid relay credentials' });
			return;
		}

		const body = await parseBody(req);
		const bandwidthMbps = normalizeOptionalInteger(body.bandwidth_mbps);
		const storageGb = normalizeOptionalInteger(body.storage_gb);
		if (bandwidthMbps === null || storageGb === null) {
			writeJson(res, 400, {
				error: 'bandwidth_mbps and storage_gb must be numeric when provided'
			});
			return;
		}

		relayRepository.updateHealth(relayId, {
			bandwidth_mbps: bandwidthMbps,
			storage_gb: storageGb
		});
		writeJson(res, 200, { status: 'ok' });
	} catch (error) {
		if (isPayloadTooLargeError(error) || isInvalidJsonError(error)) {
			handleBodyError(res, error, 'Invalid JSON in request body', 'Relay health payload too large');
			return;
		}
		console.error('[Relay] Health update error:', error);
		writeJson(res, 500, { error: 'Failed to update health' });
	}
}

export async function handleRelayApprove(
	req: IncomingMessage,
	res: ServerResponse
): Promise<void> {
	try {
		const userId = getAuthenticatedUserIdFromRequest(req);
		if (!userId) {
			writeJson(res, 401, { error: 'Authentication required' });
			return;
		}
		if (!isRelayAdmin(userId)) {
			writeJson(res, 403, { error: 'Admin access required' });
			return;
		}

		const body = await parseBody(req);
		const relayId = normalizePositiveInteger(body.relay_id);
		if (relayId == null) {
			writeJson(res, 400, { error: 'relay_id is required' });
			return;
		}

		const relay = relayRepository.findById(relayId);
		if (!relay) {
			writeJson(res, 404, { error: 'Relay not found' });
			return;
		}

		relayRepository.approve(relayId);
		console.log(`[Relay] Relay approved: ${relay.name} (${relay.url})`);
		writeJson(res, 200, { success: true, relay_id: relayId, status: 'active' });
	} catch (error) {
		if (isPayloadTooLargeError(error) || isInvalidJsonError(error)) {
			handleBodyError(res, error, 'Invalid JSON in request body', 'Relay approval payload too large');
			return;
		}
		console.error('[Relay] Approve error:', error);
		writeJson(res, 500, { error: 'Failed to approve relay' });
	}
}

export async function handleGetAllRelays(
	req: IncomingMessage,
	res: ServerResponse
): Promise<void> {
	try {
		const userId = getAuthenticatedUserIdFromRequest(req);
		if (!userId) {
			writeJson(res, 401, { error: 'Authentication required' });
			return;
		}
		if (!isRelayAdmin(userId)) {
			writeJson(res, 403, { error: 'Admin access required' });
			return;
		}

		const relays = relayRepository.getAllRelays();
		const sanitized: AdminRelayNode[] = relays.map(({ api_key_hash: _apiKeyHash, metadata_json, ...rest }) => ({
			...rest,
			metadata: parseRelayMetadata(metadata_json)
		}));
		writeJson(res, 200, { relays: sanitized });
	} catch (error) {
		console.error('[Relay] Admin list error:', error);
		writeJson(res, 500, { error: 'Failed to fetch relays' });
	}
}

export async function handleRelayDelete(
	req: IncomingMessage,
	res: ServerResponse,
	relayId: number
): Promise<void> {
	try {
		const userId = getAuthenticatedUserIdFromRequest(req);
		if (!userId) {
			writeJson(res, 401, { error: 'Authentication required' });
			return;
		}
		if (!isRelayAdmin(userId)) {
			writeJson(res, 403, { error: 'Admin access required' });
			return;
		}

		const relay = relayRepository.findById(relayId);
		if (!relay) {
			writeJson(res, 404, { error: 'Relay not found' });
			return;
		}

		relayRepository.delete(relayId);
		console.log(`[Relay] Relay deleted by admin: ${relay.name} (${relay.url})`);
		writeJson(res, 200, { success: true, relay_id: relayId, deleted: true });
	} catch (error) {
		console.error('[Relay] Delete error:', error);
		writeJson(res, 500, { error: 'Failed to delete relay' });
	}
}

export async function handleDesktopHelperRegister(
	req: IncomingMessage,
	res: ServerResponse
): Promise<void> {
	try {
		const userId = getAuthenticatedUserIdFromRequest(req);
		if (!userId) {
			writeJson(res, 401, { error: 'Authentication required' });
			return;
		}
		if (isRateLimited(req, 'desktop-helper-register', 30, 60_000)) {
			writeJson(res, 429, { error: 'Too many desktop helper registration requests.' });
			return;
		}

		const body = await parseBody(req);
		const helperId = normalizeDesktopHelperId(body.helperId);
		const helperName = normalizeDesktopHelperName(body.name);
		const helperMode = normalizeDesktopHelperMode(body.mode);
		const region =
			normalizeOptionalString(body.region, 64) ||
			process.env.BOOSTER_RELAY_REGION ||
			process.env.SERVER_REGION ||
			'desktop';

		if (!helperId || !helperName || (helperMode !== 'files-only' && helperMode !== 'desktop-assist')) {
			writeJson(res, 400, {
				error: 'helperId, name, and an active helper mode are required'
			});
			return;
		}

		const user = userRepository.findById(userId);
		if (!user) {
			writeJson(res, 404, { error: 'Registered user not found' });
			return;
		}

		const existing = relayRepository.findByUrl(getDesktopHelperUrl(userId, helperId));
		const accessPolicy = getCommunityNodeAccessPolicy();
		const isWhitelisted = accessPolicy.allowedUsers.some((entry) => entry.userId === userId);
		const canActivateImmediately =
			accessPolicy.mode === 'open' ||
			existing?.approved === 1 ||
			(accessPolicy.mode === 'whitelist_only' && isWhitelisted);

		if (accessPolicy.mode === 'whitelist_only' && !canActivateImmediately) {
			writeJson(res, 403, {
				error: 'Desktop helper activation is restricted to the node whitelist on this server.'
			});
			return;
		}

		const nextStatus: 'pending' | 'active' = canActivateImmediately ? 'active' : 'pending';
		const nextApproved = canActivateImmediately ? 1 : 0;
		const relay = await relayRepository.upsertManaged({
			url: getDesktopHelperUrl(userId, helperId),
			name: helperName,
			region,
			status: nextStatus,
			approved: nextApproved,
			metadata: buildDesktopHelperMetadata({
				userId,
				username: user.username,
				mode: helperMode,
				status: nextStatus === 'active' ? 'active' : 'offline',
				reason:
					nextStatus === 'active'
						? helperMode === 'files-only'
							? 'Files-only helper is online.'
							: 'Desktop assist helper is online.'
						: 'Desktop helper is waiting for admin approval.'
			})
		});

		if (nextApproved === 1 && (!existing || existing.status !== 'active')) {
			await announceCommunityNodeStatusChange({
				nodeName: relay.name,
				ownerUsername: user.username,
				mode: helperMode,
				status: 'online'
			});
		}

		writeJson(res, 200, { success: true, relayId: relay.relay_id, status: relay.status });
	} catch (error) {
		if (isPayloadTooLargeError(error) || isInvalidJsonError(error)) {
			handleBodyError(
				res,
				error,
				'Invalid JSON in request body',
				'Desktop helper registration payload too large'
			);
			return;
		}
		console.error('[DesktopHelper] Register error:', error);
		writeJson(res, 500, { error: 'Failed to register desktop helper' });
	}
}

export async function handleDesktopHelperHeartbeat(
	req: IncomingMessage,
	res: ServerResponse
): Promise<void> {
	try {
		const userId = getAuthenticatedUserIdFromRequest(req);
		if (!userId) {
			writeJson(res, 401, { error: 'Authentication required' });
			return;
		}
		if (isRateLimited(req, 'desktop-helper-heartbeat', 300, 60_000)) {
			writeJson(res, 429, { error: 'Too many desktop helper heartbeats.' });
			return;
		}

		const body = await parseBody(req);
		const helperId = normalizeDesktopHelperId(body.helperId);
		const helperMode = normalizeDesktopHelperMode(body.mode);
		const helperName = normalizeDesktopHelperName(body.name);
		const region =
			normalizeOptionalString(body.region, 64) ||
			process.env.BOOSTER_RELAY_REGION ||
			process.env.SERVER_REGION ||
			'desktop';

		if (!helperId || (helperMode !== 'files-only' && helperMode !== 'desktop-assist')) {
			writeJson(res, 400, { error: 'helperId and active mode are required' });
			return;
		}

		const existing = relayRepository.findByUrl(getDesktopHelperUrl(userId, helperId));
		if (!existing) {
			writeJson(res, 404, { error: 'Desktop helper is not registered' });
			return;
		}

		const user = userRepository.findById(userId);
		const metadata = parseRelayMetadata(existing.metadata_json);
		const effectiveStatus = existing.approved === 1 ? 'active' : 'pending';

		await relayRepository.upsertManaged({
			url: existing.url,
			name: helperName || existing.name,
			region: region || existing.region || 'desktop',
			status: effectiveStatus,
			approved: existing.approved,
			metadata: buildDesktopHelperMetadata({
				userId,
				username: user?.username || metadata?.ownerUsername || 'unknown',
				mode: helperMode,
				status: existing.approved === 1 ? 'active' : 'offline',
				reason:
					existing.approved === 1
						? helperMode === 'files-only'
							? 'Files-only helper heartbeat is healthy.'
							: 'Desktop assist helper heartbeat is healthy.'
						: 'Desktop helper is waiting for admin approval.'
			})
		});

		writeJson(res, 200, { success: true, status: effectiveStatus });
	} catch (error) {
		if (isPayloadTooLargeError(error) || isInvalidJsonError(error)) {
			handleBodyError(
				res,
				error,
				'Invalid JSON in request body',
				'Desktop helper heartbeat payload too large'
			);
			return;
		}
		console.error('[DesktopHelper] Heartbeat error:', error);
		writeJson(res, 500, { error: 'Failed to update desktop helper heartbeat' });
	}
}

export async function handleDesktopHelperOffline(
	req: IncomingMessage,
	res: ServerResponse
): Promise<void> {
	try {
		const userId = getAuthenticatedUserIdFromRequest(req);
		if (!userId) {
			writeJson(res, 401, { error: 'Authentication required' });
			return;
		}

		const body = await parseBody(req);
		const helperId = normalizeDesktopHelperId(body.helperId);
		const reason =
			normalizeOptionalString(body.reason, 256) || 'Desktop helper went offline.';

		if (!helperId) {
			writeJson(res, 400, { error: 'helperId is required' });
			return;
		}

		const existing = relayRepository.findByUrl(getDesktopHelperUrl(userId, helperId));
		if (!existing) {
			writeJson(res, 200, { success: true, status: 'offline' });
			return;
		}

		const metadata = parseRelayMetadata(existing.metadata_json);
		await relayRepository.upsertManaged({
			url: existing.url,
			name: existing.name,
			region: existing.region,
			status: 'offline',
			approved: existing.approved,
			metadata: buildDesktopHelperMetadata({
				userId,
				username: metadata?.ownerUsername || 'unknown',
				mode: metadata?.helperMode === 'desktop-assist' ? 'desktop-assist' : 'files-only',
				status: 'offline',
				reason
			})
		});

		if (existing.status !== 'offline') {
			await announceCommunityNodeStatusChange({
				nodeName: existing.name,
				ownerUsername: metadata?.ownerUsername || 'a community member',
				mode: metadata?.helperMode,
				status: 'offline'
			});
		}

		writeJson(res, 200, { success: true, status: 'offline' });
	} catch (error) {
		if (isPayloadTooLargeError(error) || isInvalidJsonError(error)) {
			handleBodyError(
				res,
				error,
				'Invalid JSON in request body',
				'Desktop helper offline payload too large'
			);
			return;
		}
		console.error('[DesktopHelper] Offline error:', error);
		writeJson(res, 500, { error: 'Failed to mark desktop helper offline' });
	}
}
