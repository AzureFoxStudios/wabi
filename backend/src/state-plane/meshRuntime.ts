import { getStatePlaneConfigFromEnv } from './config.js';
import { createStdbClient, INGEST_AUTH_KEY_HASH } from './stdbCommon.js';
import { escapeSqlLiteral, toStdbEventId, type StdbDecodedRow } from './stdbSyncClient.js';

export interface StateMeshConnectionCounts {
	currentConnections: number;
	currentRegisteredUsers: number;
	currentGuestUsers: number;
}

export interface StateMeshSocketLeaseRecord {
	stableUserId: string;
	dbUserId: number | null;
	instanceId: string;
	status: string;
	connectedAt: number;
	leaseExpiresAt: number;
}

export interface StateMeshPresenceLeaseRecord {
	stableUserId: string;
	dbUserId: number | null;
	instanceId: string;
	username: string | null;
	color: string | null;
	profilePicture: string | null;
	status: string;
	connectedAt: number;
	leaseExpiresAt: number;
}

export interface StateMeshInstanceLeaseRecord {
	instanceId: string;
	region: string;
	role: string;
	status: string;
	currentConnections: number;
	currentRegisteredUsers: number;
	currentGuestUsers: number;
	heartbeatAt: number;
	leaseExpiresAt: number;
	startedAt: number;
	meshUrl: string | null;
	publicUrl: string | null;
}

export interface StateMeshDeliveryEnvelope {
	deliveryId: string;
	targetInstanceId: string;
	scope: 'user' | 'broadcast';
	event: string;
	payload: unknown;
	targetStableUserId?: string | null;
	fromInstanceId?: string | null;
	createdAt: number;
}

export interface StateMeshRuntimeStats {
	enabled: boolean;
	started: boolean;
	instanceId: string | null;
	region: string;
	role: string;
	heartbeatIntervalMs: number;
	leaseTtlMs: number;
	startedAt: number | null;
	lastHeartbeatAt: number | null;
	lastHeartbeatLeaseExpiresAt: number | null;
	heartbeatsAttempted: number;
	heartbeatsSucceeded: number;
	heartbeatsFailed: number;
	socketLeaseUpsertsAttempted: number;
	socketLeaseUpsertsSucceeded: number;
	socketLeaseUpsertsFailed: number;
	socketLeaseDeletesAttempted: number;
	socketLeaseDeletesSucceeded: number;
	socketLeaseDeletesFailed: number;
	presenceLeaseUpsertsAttempted: number;
	presenceLeaseUpsertsSucceeded: number;
	presenceLeaseUpsertsFailed: number;
	presenceLeaseDeletesAttempted: number;
	presenceLeaseDeletesSucceeded: number;
	presenceLeaseDeletesFailed: number;
	remoteDeliveriesAttempted: number;
	remoteDeliveriesSucceeded: number;
	remoteDeliveriesFailed: number;
	localSocketLeaseCount: number;
	localPresenceLeaseCount: number;
	currentConnections: number;
	currentRegisteredUsers: number;
	currentGuestUsers: number;
	meshIngressUrl: string | null;
	meshInstanceUrlTemplate: string | null;
	meshRemoteDeliveryEnabled: boolean;
	lastError: string | null;
	lastErrorAt: number | null;
	client: ReturnType<ReturnType<typeof createStdbClient>['getRuntimeStats']>;
}

interface LocalSocketLease {
	stableUserId: string;
	dbUserId: number | null;
	connectedAt: number;
}

interface LocalPresenceLease {
	stableUserId: string;
	dbUserId: number | null;
	username: string | null;
	color: string | null;
	profilePicture: string | null;
	status: string;
	connectedAt: number;
}

const statePlaneConfig = getStatePlaneConfigFromEnv();
const stdbClient = createStdbClient();
const reducerName = process.env.WABI_STDB_BRIDGE_REDUCER || 'ingest_wabi_event';
const instanceId = resolveInstanceId();
const region = normalizeOptional(process.env.WABI_SERVER_REGION) || normalizeOptional(process.env.RELAY_REGION) || 'local';
const role = normalizeOptional(process.env.WABI_SERVER_ROLE) || 'app';
const meshIngressUrl = normalizeMeshIngressUrl(process.env.WABI_MESH_INGRESS_URL);
const meshInstanceUrlTemplate = normalizeOptional(process.env.WABI_MESH_INSTANCE_URL_TEMPLATE) || 'http://{instanceId}:8080';
const meshSharedToken =
	normalizeOptional(process.env.WABI_MESH_SHARED_TOKEN) ||
	normalizeOptional(process.env.WABI_STDB_AUTH_TOKEN);
const publicClientUrl =
	normalizeClientBackendUrl(process.env.WABI_PUBLIC_BACKEND_URL) ||
	normalizeClientBackendUrl(process.env.PUBLIC_URL) ||
	normalizeClientBackendUrl(process.env.FRONTEND_URL);
const heartbeatIntervalMs = normalizePositiveInt(process.env.WABI_MESH_HEARTBEAT_INTERVAL_MS, 5000, 1000, 60000);
const leaseTtlMs = normalizePositiveInt(
	process.env.WABI_MESH_LEASE_TTL_MS,
	Math.max(heartbeatIntervalMs * 3, heartbeatIntervalMs + 1000),
	heartbeatIntervalMs + 1000,
	300000
);
const deliveryTimeoutMs = normalizePositiveInt(
	process.env.WABI_MESH_DELIVERY_TIMEOUT_MS,
	5000,
	250,
	60000
);
const meshBridgeProbe =
	stdbClient.isEnabled()
		? stdbClient.probeConnectivity(Math.min(stdbClient.getTimeoutMs(), 1500))
		: { ok: false, reason: 'stdb_client_disabled', latencyMs: null };
const meshEnabled =
	stdbClient.isEnabled() &&
	!!instanceId &&
	meshBridgeProbe.ok;
const meshRemoteDeliveryEnabled = meshEnabled && !!meshSharedToken && !!meshInstanceUrlTemplate;

let getConnectionCounts: () => StateMeshConnectionCounts = () => ({
	currentConnections: 0,
	currentRegisteredUsers: 0,
	currentGuestUsers: 0
});
let heartbeatTimer: NodeJS.Timeout | null = null;
let runtimeStarted = false;
let runtimeStartedAt: number | null = null;
let stopping = false;
let lastErrorKey: string | null = null;

const localSocketLeases = new Map<string, LocalSocketLease>();
const localPresenceLeases = new Map<string, LocalPresenceLease>();
const runtimeStats = {
	lastHeartbeatAt: null as number | null,
	lastHeartbeatLeaseExpiresAt: null as number | null,
	heartbeatsAttempted: 0,
	heartbeatsSucceeded: 0,
	heartbeatsFailed: 0,
	socketLeaseUpsertsAttempted: 0,
	socketLeaseUpsertsSucceeded: 0,
	socketLeaseUpsertsFailed: 0,
	socketLeaseDeletesAttempted: 0,
	socketLeaseDeletesSucceeded: 0,
	socketLeaseDeletesFailed: 0,
	presenceLeaseUpsertsAttempted: 0,
	presenceLeaseUpsertsSucceeded: 0,
	presenceLeaseUpsertsFailed: 0,
	presenceLeaseDeletesAttempted: 0,
	presenceLeaseDeletesSucceeded: 0,
	presenceLeaseDeletesFailed: 0,
	remoteDeliveriesAttempted: 0,
	remoteDeliveriesSucceeded: 0,
	remoteDeliveriesFailed: 0,
	lastError: null as string | null,
	lastErrorAt: null as number | null
};

function normalizeOptional(value: string | undefined): string | null {
	if (value == null) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeMeshIngressUrl(value: string | undefined): string | null {
	const normalized = normalizeOptional(value);
	if (!normalized) return null;
	if (/^https?:\/\//i.test(normalized)) {
		return normalized.replace(/\/+$/, '');
	}
	return `http://${normalized.replace(/\/+$/, '')}`;
}

function normalizeClientBackendUrl(value: string | undefined | null): string | null {
	const normalized = normalizeMeshIngressUrl(value ?? undefined);
	if (!normalized) return null;
	try {
		const parsed = new URL(normalized);
		const host = parsed.hostname.toLowerCase();
		const isLocalHost =
			host === 'localhost' ||
			host === '127.0.0.1' ||
			host === '::1' ||
			host === '[::1]' ||
			host === 'tauri.localhost';
		if (isLocalHost && (parsed.port === '5173' || parsed.port === '3000')) {
			parsed.port = '8080';
		}
		const normalizedPath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
		return `${parsed.origin}${normalizedPath}`;
	} catch {
		return normalized;
	}
}

function normalizePositiveInt(
	value: string | undefined,
	fallback: number,
	min: number,
	max: number
): number {
	if (!value || value.trim().length === 0) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function resolveInstanceId(): string | null {
	const direct = normalizeOptional(process.env.WABI_SERVER_INSTANCE_ID);
	if (direct) return direct;
	const hostname = normalizeOptional(process.env.HOSTNAME);
	if (hostname) return hostname;
	return `wabi-${process.pid}`;
}

function parseDbUserId(stableUserId: string, dbUserId: number | null | undefined): number | null {
	if (dbUserId != null && Number.isFinite(dbUserId) && dbUserId > 0) {
		return Math.floor(dbUserId);
	}
	if (stableUserId.startsWith('user-')) {
		const parsed = Number(stableUserId.slice(5));
		if (Number.isFinite(parsed) && parsed > 0) {
			return Math.floor(parsed);
		}
	}
	return null;
}

function toNumber(value: unknown): number {
	if (typeof value === 'number') return value;
	if (typeof value === 'bigint') return Number(value);
	if (value == null) return NaN;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : NaN;
}

function parseRowJsonObject(row: StdbDecodedRow | null | undefined): Record<string, unknown> | null {
	if (!row) return null;
	const raw =
		typeof row.row_json === 'string'
			? row.row_json
			: (typeof row.rowJson === 'string' ? row.rowJson : null);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function isRegisteredStableUserId(stableUserId: string | null | undefined): stableUserId is string {
	return typeof stableUserId === 'string' && stableUserId.startsWith('user-') && stableUserId.length > 5;
}

function isLeaseActive(status: string | null | undefined, leaseExpiresAt: number | null | undefined): boolean {
	if (!status || status === 'draining' || status === 'offline') return false;
	if (leaseExpiresAt == null || !Number.isFinite(leaseExpiresAt)) return false;
	return leaseExpiresAt > Date.now();
}

function resolveMeshUrlForInstance(targetInstanceId: string | null | undefined): string | null {
	if (!targetInstanceId || !meshInstanceUrlTemplate) return null;
	if (instanceId && targetInstanceId === instanceId && meshIngressUrl) {
		return meshIngressUrl;
	}
	const candidate = meshInstanceUrlTemplate.replace(/\{instanceId\}/g, targetInstanceId);
	return normalizeMeshIngressUrl(candidate);
}

function recordError(scope: string, error: unknown): void {
	const detail = error instanceof Error ? error.message : String(error);
	runtimeStats.lastError = `${scope}: ${detail}`;
	runtimeStats.lastErrorAt = Date.now();
	const errorKey = `${scope}:${detail}`;
	if (lastErrorKey === errorKey) return;
	lastErrorKey = errorKey;
	console.warn(`[StateMesh] ${runtimeStats.lastError}`);
}

function clearError(): void {
	lastErrorKey = null;
	runtimeStats.lastError = null;
	runtimeStats.lastErrorAt = null;
}

async function ingestMeshEvent(
	entity: 'mesh' | 'presence',
	operation:
		| 'upsert_backend_instance_lease'
		| 'upsert_socket_lease'
		| 'delete_socket_lease'
		| 'upsert_presence_lease'
		| 'delete_presence_lease',
	payload: Record<string, unknown>
): Promise<void> {
	if (!meshEnabled) return;
	const event: Record<string, unknown> = {
		eventId: toStdbEventId(entity, operation, payload),
		timestamp: Date.now(),
		entity,
		operation,
		payload
	};
	if (INGEST_AUTH_KEY_HASH) event.authKey = INGEST_AUTH_KEY_HASH;
	await stdbClient.callReducerAsync(reducerName, [
		JSON.stringify(event)
	]);
}

function currentCounts(): StateMeshConnectionCounts {
	try {
		const counts = getConnectionCounts();
		const currentConnections = Math.max(0, Math.floor(counts.currentConnections || 0));
		const currentRegisteredUsers = Math.max(0, Math.floor(counts.currentRegisteredUsers || 0));
		const currentGuestUsers = Math.max(0, Math.floor(counts.currentGuestUsers || 0));
		return {
			currentConnections,
			currentRegisteredUsers,
			currentGuestUsers
		};
	} catch (error) {
		recordError('counts_provider', error);
		return {
			currentConnections: 0,
			currentRegisteredUsers: 0,
			currentGuestUsers: 0
		};
	}
}

async function publishBackendInstanceLease(status = stopping ? 'draining' : 'active'): Promise<void> {
	if (!meshEnabled || !instanceId) return;
	const counts = currentCounts();
	const heartbeatAt = Date.now();
	const leaseExpiresAt = heartbeatAt + leaseTtlMs;
	runtimeStats.heartbeatsAttempted += 1;
	try {
		await ingestMeshEvent('mesh', 'upsert_backend_instance_lease', {
			row: {
				instanceId,
				region,
				role,
				status,
				currentConnections: counts.currentConnections,
				currentRegisteredUsers: counts.currentRegisteredUsers,
				currentGuestUsers: counts.currentGuestUsers,
				publicUrl: publicClientUrl,
				heartbeatAt,
				leaseExpiresAt,
				startedAt: runtimeStartedAt || heartbeatAt
			}
		});
		runtimeStats.heartbeatsSucceeded += 1;
		runtimeStats.lastHeartbeatAt = heartbeatAt;
		runtimeStats.lastHeartbeatLeaseExpiresAt = leaseExpiresAt;
		clearError();
	} catch (error) {
		runtimeStats.heartbeatsFailed += 1;
		recordError('backend_heartbeat', error);
	}
}

async function refreshLocalLeases(): Promise<void> {
	if (!meshEnabled) return;

	for (const lease of localSocketLeases.values()) {
		try {
			await upsertSocketLease(lease);
		} catch (error) {
			recordError('socket_lease_refresh', error);
		}
	}

	for (const lease of localPresenceLeases.values()) {
		try {
			await upsertPresenceLease(lease);
		} catch (error) {
			recordError('presence_lease_refresh', error);
		}
	}
}

function scheduleHeartbeat(): void {
	if (!meshEnabled) return;
	void publishBackendInstanceLease();
	void refreshLocalLeases();
	if (heartbeatTimer) clearInterval(heartbeatTimer);
	heartbeatTimer = setInterval(() => {
		void publishBackendInstanceLease();
		void refreshLocalLeases();
	}, heartbeatIntervalMs);
	heartbeatTimer.unref?.();
}

export function configureStateMeshRuntime(provider: (() => StateMeshConnectionCounts) | null | undefined): void {
	getConnectionCounts = provider || (() => ({
		currentConnections: 0,
		currentRegisteredUsers: 0,
		currentGuestUsers: 0
	}));
}

export function startStateMeshRuntime(): void {
	if (runtimeStarted) return;
	runtimeStarted = true;
	stopping = false;
	runtimeStartedAt = Date.now();
	if (!meshEnabled) {
		if (stdbClient.isEnabled() && meshBridgeProbe.reason) {
			console.warn(`[StateMesh] Disabled at startup because the STDB bridge is unavailable (${meshBridgeProbe.reason})`);
		}
		return;
	}
	scheduleHeartbeat();
}

export function stopStateMeshRuntime(): void {
	if (!runtimeStarted) return;
	runtimeStarted = false;
	stopping = true;
	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}

	const leases = Array.from(localSocketLeases.values());
	localSocketLeases.clear();
	for (const lease of leases) {
		void deleteSocketLease(lease.stableUserId, lease.connectedAt);
	}
	const presenceLeases = Array.from(localPresenceLeases.values());
	localPresenceLeases.clear();
	for (const lease of presenceLeases) {
		void deletePresenceLease(lease.stableUserId, lease.connectedAt);
	}
	void publishBackendInstanceLease('draining');
}

async function upsertSocketLease(lease: LocalSocketLease): Promise<void> {
	if (!meshEnabled || !instanceId) return;
	const leaseExpiresAt = Date.now() + leaseTtlMs;
	await ingestMeshEvent('mesh', 'upsert_socket_lease', {
		row: {
			stableUserId: lease.stableUserId,
			dbUserId: lease.dbUserId,
			instanceId,
			status: 'active',
			connectedAt: lease.connectedAt,
			leaseExpiresAt
		}
	});
}

async function deleteSocketLease(stableUserId: string, connectedAt: number): Promise<void> {
	if (!meshEnabled) return;
	await ingestMeshEvent('mesh', 'delete_socket_lease', {
		stableUserId,
		connectedAt
	});
}

export function registerStateMeshSocketLease(
	stableUserId: string | null | undefined,
	dbUserId?: number | null
): number | null {
	if (!isRegisteredStableUserId(stableUserId)) return null;
	const lease: LocalSocketLease = {
		stableUserId,
		dbUserId: parseDbUserId(stableUserId, dbUserId),
		connectedAt: Date.now()
	};
	localSocketLeases.set(stableUserId, lease);
	runtimeStats.socketLeaseUpsertsAttempted += 1;
	void upsertSocketLease(lease)
		.then(() => {
			runtimeStats.socketLeaseUpsertsSucceeded += 1;
			clearError();
		})
		.catch((error) => {
			runtimeStats.socketLeaseUpsertsFailed += 1;
			recordError('socket_lease_upsert', error);
	});
	void publishBackendInstanceLease();
	return lease.connectedAt;
}

export function releaseStateMeshSocketLease(
	stableUserId: string | null | undefined,
	expectedConnectedAt?: number | null
): void {
	if (!isRegisteredStableUserId(stableUserId)) return;
	const existing = localSocketLeases.get(stableUserId);
	if (!existing) return;
	if (expectedConnectedAt != null && expectedConnectedAt !== existing.connectedAt) {
		return;
	}
	localSocketLeases.delete(stableUserId);
	runtimeStats.socketLeaseDeletesAttempted += 1;
	void deleteSocketLease(stableUserId, existing.connectedAt)
		.then(() => {
			runtimeStats.socketLeaseDeletesSucceeded += 1;
			clearError();
		})
		.catch((error) => {
			runtimeStats.socketLeaseDeletesFailed += 1;
			recordError('socket_lease_delete', error);
	});
	void publishBackendInstanceLease();
}

async function upsertPresenceLease(lease: LocalPresenceLease): Promise<void> {
	if (!meshEnabled || !instanceId) return;
	const leaseExpiresAt = Date.now() + leaseTtlMs;
	await ingestMeshEvent('presence', 'upsert_presence_lease', {
		row: {
			stableUserId: lease.stableUserId,
			dbUserId: lease.dbUserId,
			instanceId,
			username: lease.username,
			color: lease.color,
			profilePicture: lease.profilePicture,
			status: lease.status,
			connectedAt: lease.connectedAt,
			leaseExpiresAt
		}
	});
}

async function deletePresenceLease(stableUserId: string, connectedAt: number): Promise<void> {
	if (!meshEnabled) return;
	await ingestMeshEvent('presence', 'delete_presence_lease', {
		stableUserId,
		connectedAt
	});
}

export function upsertStateMeshPresenceLease(payload: {
	stableUserId: string | null | undefined;
	dbUserId?: number | null;
	username?: string | null;
	color?: string | null;
	profilePicture?: string | null;
	status?: string | null;
}, connectedAt?: number | null): number | null {
	const stableUserId = payload.stableUserId?.trim();
	if (!stableUserId) return null;
	const existing = localPresenceLeases.get(stableUserId);
	const lease: LocalPresenceLease = {
		stableUserId,
		dbUserId: parseDbUserId(stableUserId, payload.dbUserId ?? existing?.dbUserId ?? null),
		username: payload.username?.trim() || existing?.username || null,
		color: payload.color?.trim() || existing?.color || null,
		profilePicture: payload.profilePicture?.trim() || existing?.profilePicture || null,
		status: payload.status?.trim() || existing?.status || 'active',
		connectedAt: connectedAt ?? existing?.connectedAt ?? Date.now()
	};
	localPresenceLeases.set(stableUserId, lease);
	runtimeStats.presenceLeaseUpsertsAttempted += 1;
	void upsertPresenceLease(lease)
		.then(() => {
			runtimeStats.presenceLeaseUpsertsSucceeded += 1;
			clearError();
		})
		.catch((error) => {
			runtimeStats.presenceLeaseUpsertsFailed += 1;
			recordError('presence_lease_upsert', error);
		});
	return lease.connectedAt;
}

export function deleteStateMeshPresenceLease(
	stableUserId: string | null | undefined,
	expectedConnectedAt?: number | null
): void {
	const normalized = stableUserId?.trim();
	if (!normalized) return;
	const existing = localPresenceLeases.get(normalized);
	if (!existing) return;
	if (expectedConnectedAt != null && expectedConnectedAt !== existing.connectedAt) return;
	localPresenceLeases.delete(normalized);
	runtimeStats.presenceLeaseDeletesAttempted += 1;
	void deletePresenceLease(normalized, existing.connectedAt)
		.then(() => {
			runtimeStats.presenceLeaseDeletesSucceeded += 1;
			clearError();
		})
		.catch((error) => {
			runtimeStats.presenceLeaseDeletesFailed += 1;
			recordError('presence_lease_delete', error);
		});
}

function decodeSocketLeaseRow(row: StdbDecodedRow | null | undefined): StateMeshSocketLeaseRecord | null {
	if (!row) return null;
	const stableUserId =
		typeof row.stable_user_id === 'string'
			? row.stable_user_id
			: (typeof row.stableUserId === 'string' ? row.stableUserId : '');
	if (!stableUserId) return null;
	const instanceIdValue =
		typeof row.instance_id === 'string'
			? row.instance_id
			: (typeof row.instanceId === 'string' ? row.instanceId : '');
	if (!instanceIdValue) return null;
	const statusValue =
		typeof row.status === 'string' && row.status.trim().length > 0
			? row.status
			: 'active';
	const dbUserIdValue =
		row.db_user_id == null && row.dbUserId == null
			? null
			: toNumber(row.db_user_id ?? row.dbUserId);
	return {
		stableUserId,
		dbUserId: dbUserIdValue > 0 ? dbUserIdValue : null,
		instanceId: instanceIdValue,
		status: statusValue,
		connectedAt: toNumber(row.connected_at ?? row.connectedAt),
		leaseExpiresAt: toNumber(row.lease_expires_at ?? row.leaseExpiresAt)
	};
}

function decodePresenceLeaseRow(row: StdbDecodedRow | null | undefined): StateMeshPresenceLeaseRecord | null {
	if (!row) return null;
	const stableUserId =
		typeof row.stable_user_id === 'string'
			? row.stable_user_id
			: (typeof row.stableUserId === 'string' ? row.stableUserId : '');
	if (!stableUserId) return null;
	const instanceIdValue =
		typeof row.instance_id === 'string'
			? row.instance_id
			: (typeof row.instanceId === 'string' ? row.instanceId : '');
	if (!instanceIdValue) return null;
	const statusValue =
		typeof row.status === 'string' && row.status.trim().length > 0
			? row.status
			: 'active';
	return {
		stableUserId,
		dbUserId: row.db_user_id == null && row.dbUserId == null ? null : toNumber(row.db_user_id ?? row.dbUserId),
		instanceId: instanceIdValue,
		username: typeof row.username === 'string' ? row.username : null,
		color: typeof row.color === 'string' ? row.color : null,
		profilePicture:
			typeof row.profile_picture === 'string'
				? row.profile_picture
				: (typeof row.profilePicture === 'string' ? row.profilePicture : null),
		status: statusValue,
		connectedAt: toNumber(row.connected_at ?? row.connectedAt),
		leaseExpiresAt: toNumber(row.lease_expires_at ?? row.leaseExpiresAt)
	};
}

function decodeInstanceLeaseRow(row: StdbDecodedRow | null | undefined): StateMeshInstanceLeaseRecord | null {
	if (!row) return null;
	const rowJson = parseRowJsonObject(row);
	const instanceIdValue =
		typeof row.instance_id === 'string'
			? row.instance_id
			: (typeof row.instanceId === 'string' ? row.instanceId : '');
	if (!instanceIdValue) return null;
	const statusValue =
		typeof row.status === 'string' && row.status.trim().length > 0
			? row.status
			: 'active';
	const regionValue =
		typeof row.region === 'string' && row.region.trim().length > 0
			? row.region
			: 'local';
	const roleValue =
		typeof row.role === 'string' && row.role.trim().length > 0
			? row.role
			: 'app';
	return {
		instanceId: instanceIdValue,
		region: regionValue,
		role: roleValue,
		status: statusValue,
		currentConnections: toNumber(row.current_connections ?? row.currentConnections),
		currentRegisteredUsers: toNumber(row.current_registered_users ?? row.currentRegisteredUsers),
		currentGuestUsers: toNumber(row.current_guest_users ?? row.currentGuestUsers),
		heartbeatAt: toNumber(row.heartbeat_at ?? row.heartbeatAt),
		leaseExpiresAt: toNumber(row.lease_expires_at ?? row.leaseExpiresAt),
		startedAt: toNumber(row.started_at ?? row.startedAt),
		meshUrl: resolveMeshUrlForInstance(instanceIdValue),
		publicUrl: normalizeClientBackendUrl(
			typeof row.public_url === 'string'
				? row.public_url
				: typeof row.publicUrl === 'string'
					? row.publicUrl
					: typeof rowJson?.public_url === 'string'
						? rowJson.public_url
						: typeof rowJson?.publicUrl === 'string'
							? rowJson.publicUrl
							: null
		)
	};
}

export function getCurrentStateMeshInstanceId(): string | null {
	return instanceId;
}

export function findStateMeshInstanceLeaseById(targetInstanceId: string | null | undefined): StateMeshInstanceLeaseRecord | null {
	if (!meshEnabled || !targetInstanceId) return null;
	try {
		const rows = stdbClient.sqlRows(
			`SELECT instance_id, region, role, status, current_connections, current_registered_users, current_guest_users, heartbeat_at, lease_expires_at, started_at, row_json FROM state_backend_instance_lease WHERE instance_id = ${escapeSqlLiteral(targetInstanceId)} LIMIT 1`
		);
		const lease = decodeInstanceLeaseRow(rows[0]);
		return lease && isLeaseActive(lease.status, lease.leaseExpiresAt) ? lease : null;
	} catch (error) {
		recordError('instance_lease_lookup', error);
		return null;
	}
}

export function listActiveStateMeshInstanceLeases(): StateMeshInstanceLeaseRecord[] {
	if (!meshEnabled) return [];
	try {
		const rows = stdbClient.sqlRows(
			'SELECT instance_id, region, role, status, current_connections, current_registered_users, current_guest_users, heartbeat_at, lease_expires_at, started_at, row_json FROM state_backend_instance_lease LIMIT 256'
		);
		return rows
			.map((row) => decodeInstanceLeaseRow(row))
			.filter((row): row is StateMeshInstanceLeaseRecord => Boolean(row))
			.filter((row) => isLeaseActive(row.status, row.leaseExpiresAt));
	} catch (error) {
		recordError('instance_lease_list', error);
		return [];
	}
}

export function listStateMeshPresenceLeases(): StateMeshPresenceLeaseRecord[] {
	if (!meshEnabled) return [];
	try {
		const rows = stdbClient.sqlRows(
			'SELECT stable_user_id, db_user_id, instance_id, username, color, profile_picture, status, connected_at, lease_expires_at FROM state_presence_lease LIMIT 2048'
		);
		return rows
			.map((row) => decodePresenceLeaseRow(row))
			.filter((row): row is StateMeshPresenceLeaseRecord => Boolean(row))
			.filter((row) => isLeaseActive(row.status, row.leaseExpiresAt));
	} catch (error) {
		recordError('presence_lease_list', error);
		return [];
	}
}

export function findStateMeshSocketLeaseByStableUserId(
	stableUserId: string | null | undefined
): StateMeshSocketLeaseRecord | null {
	if (!meshEnabled || !isRegisteredStableUserId(stableUserId)) return null;
	try {
		const rows = stdbClient.sqlRows(
			`SELECT stable_user_id, db_user_id, instance_id, status, connected_at, lease_expires_at FROM state_socket_lease WHERE stable_user_id = ${escapeSqlLiteral(stableUserId)} LIMIT 1`
		);
		const lease = decodeSocketLeaseRow(rows[0]);
		if (!lease) return null;
		if (!isLeaseActive(lease.status, lease.leaseExpiresAt)) return null;
		return lease;
	} catch (error) {
		recordError('socket_lease_lookup', error);
		return null;
	}
}

async function postRemoteDeliveryToLease(
	targetLease: StateMeshInstanceLeaseRecord,
	envelope: StateMeshDeliveryEnvelope
): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), deliveryTimeoutMs);
	try {
		const response = await fetch(`${targetLease.meshUrl}/api/internal/mesh/deliver`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${meshSharedToken}`
			},
			body: JSON.stringify({
				...envelope,
				targetInstanceId: targetLease.instanceId,
				fromInstanceId: instanceId
			}),
			signal: controller.signal
		});
		const text = await response.text().catch(() => '');
		if (!response.ok) {
			throw new Error(`status=${response.status} body=${text || response.statusText}`);
		}

		let parsed: Record<string, unknown> | null = null;
		if (text.trim().length > 0) {
			try {
				parsed = JSON.parse(text) as Record<string, unknown>;
			} catch (error) {
				throw new Error(
					`status=${response.status} invalid_json=${error instanceof Error ? error.message : String(error)} body=${text.slice(0, 256)}`
				);
			}
		}

		if (parsed?.duplicate === true || parsed?.delivered === true) {
			return;
		}

		throw new Error(`status=${response.status} body=${text || response.statusText} delivered=false`);
	} finally {
		clearTimeout(timeout);
	}
}

export async function sendStateMeshRemoteDelivery(envelope: StateMeshDeliveryEnvelope): Promise<boolean> {
	if (!meshRemoteDeliveryEnabled) {
		recordError('remote_delivery', 'mesh shared token is not configured');
		return false;
	}
	if (!envelope.targetInstanceId || envelope.targetInstanceId === instanceId) {
		return false;
	}

	runtimeStats.remoteDeliveriesAttempted += 1;
	const candidates: StateMeshInstanceLeaseRecord[] = [];
	const seenInstanceIds = new Set<string>();
	const pushCandidate = (lease: StateMeshInstanceLeaseRecord | null): void => {
		if (!lease?.meshUrl) return;
		if (seenInstanceIds.has(lease.instanceId)) return;
		seenInstanceIds.add(lease.instanceId);
		candidates.push(lease);
	};

	pushCandidate(findStateMeshInstanceLeaseById(envelope.targetInstanceId));
	if (envelope.scope === 'user') {
		for (const lease of listActiveStateMeshInstanceLeases()) {
			if (lease.instanceId === envelope.targetInstanceId || lease.instanceId === instanceId) continue;
			pushCandidate(lease);
		}
	}

	if (candidates.length === 0) {
		runtimeStats.remoteDeliveriesFailed += 1;
		recordError('remote_delivery', `target instance ${envelope.targetInstanceId} has no active mesh URL`);
		return false;
	}

	let lastError: unknown = null;
	try {
		for (const candidate of candidates) {
			try {
				await postRemoteDeliveryToLease(candidate, envelope);
				runtimeStats.remoteDeliveriesSucceeded += 1;
				clearError();
				return true;
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError || new Error('mesh_delivery_failed');
	} catch (error) {
		runtimeStats.remoteDeliveriesFailed += 1;
		recordError('remote_delivery', error);
		return false;
	}
}

export function getStateMeshRuntimeStats(): StateMeshRuntimeStats {
	const counts = currentCounts();
	return {
		enabled: meshEnabled,
		started: runtimeStarted,
		instanceId,
		region,
		role,
		heartbeatIntervalMs,
		leaseTtlMs,
		startedAt: runtimeStartedAt,
		lastHeartbeatAt: runtimeStats.lastHeartbeatAt,
		lastHeartbeatLeaseExpiresAt: runtimeStats.lastHeartbeatLeaseExpiresAt,
		heartbeatsAttempted: runtimeStats.heartbeatsAttempted,
		heartbeatsSucceeded: runtimeStats.heartbeatsSucceeded,
		heartbeatsFailed: runtimeStats.heartbeatsFailed,
		socketLeaseUpsertsAttempted: runtimeStats.socketLeaseUpsertsAttempted,
		socketLeaseUpsertsSucceeded: runtimeStats.socketLeaseUpsertsSucceeded,
		socketLeaseUpsertsFailed: runtimeStats.socketLeaseUpsertsFailed,
		socketLeaseDeletesAttempted: runtimeStats.socketLeaseDeletesAttempted,
		socketLeaseDeletesSucceeded: runtimeStats.socketLeaseDeletesSucceeded,
		socketLeaseDeletesFailed: runtimeStats.socketLeaseDeletesFailed,
		presenceLeaseUpsertsAttempted: runtimeStats.presenceLeaseUpsertsAttempted,
		presenceLeaseUpsertsSucceeded: runtimeStats.presenceLeaseUpsertsSucceeded,
		presenceLeaseUpsertsFailed: runtimeStats.presenceLeaseUpsertsFailed,
		presenceLeaseDeletesAttempted: runtimeStats.presenceLeaseDeletesAttempted,
		presenceLeaseDeletesSucceeded: runtimeStats.presenceLeaseDeletesSucceeded,
		presenceLeaseDeletesFailed: runtimeStats.presenceLeaseDeletesFailed,
		remoteDeliveriesAttempted: runtimeStats.remoteDeliveriesAttempted,
		remoteDeliveriesSucceeded: runtimeStats.remoteDeliveriesSucceeded,
		remoteDeliveriesFailed: runtimeStats.remoteDeliveriesFailed,
		localSocketLeaseCount: localSocketLeases.size,
		localPresenceLeaseCount: localPresenceLeases.size,
		currentConnections: counts.currentConnections,
		currentRegisteredUsers: counts.currentRegisteredUsers,
		currentGuestUsers: counts.currentGuestUsers,
		meshIngressUrl,
		meshInstanceUrlTemplate,
		meshRemoteDeliveryEnabled,
		lastError: runtimeStats.lastError,
		lastErrorAt: runtimeStats.lastErrorAt,
		client: stdbClient.getRuntimeStats()
	};
}
