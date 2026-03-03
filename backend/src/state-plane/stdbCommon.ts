import type { StatePlaneOutbox } from './outbox.js';
import { StdbSyncClient, toStdbEventId } from './stdbSyncClient.js';

export interface StdbPrimaryStoreOptions {
	outbox?: StatePlaneOutbox | null;
	reducerName?: string;
	mirrorLegacyWrites?: boolean;
}

export interface BaseStoreStats {
	writesAttempted: number;
	writesSucceeded: number;
	writesFailed: number;
	lastError: string | null;
	lastErrorAt: number | null;
	operations: Record<string, number>;
}

export function makeBaseStats(): BaseStoreStats {
	return {
		writesAttempted: 0,
		writesSucceeded: 0,
		writesFailed: 0,
		lastError: null,
		lastErrorAt: null,
		operations: {}
	};
}

export function bumpOperation(stats: BaseStoreStats, key: string): void {
	stats.operations[key] = (stats.operations[key] || 0) + 1;
}

export function nowMs(): number {
	return Date.now();
}

export function toNumber(value: unknown): number {
	if (typeof value === 'number') return value;
	if (typeof value === 'bigint') return Number(value);
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

export function parseJsonObject<T>(raw: unknown): T | null {
	if (typeof raw !== 'string' || raw.trim().length === 0) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

function normalizeServerEnv(): string | null {
	return process.env.WABI_STDB_BRIDGE_SERVER?.trim() || null;
}

function normalizeDatabaseEnv(): string | null {
	return process.env.WABI_STDB_BRIDGE_DATABASE?.trim() || null;
}

function normalizeTokenEnv(): string | null {
	const candidates = [
		process.env.WABI_STDB_AUTH_TOKEN,
		process.env.STATE_SHADOW_TOKEN
	];
	for (const raw of candidates) {
		const value = raw?.trim();
		if (value) return value;
	}
	return null;
}

function normalizeAnonymousEnv(token: string | null): boolean {
	if (token) return false;
	const raw = (process.env.WABI_STDB_ANONYMOUS || 'true').trim().toLowerCase();
	return raw !== '0' && raw !== 'false' && raw !== 'no' && raw !== 'off';
}

function normalizeTimeoutEnv(): number {
	const parsed = Number(process.env.WABI_STDB_BRIDGE_TIMEOUT_MS || '10000');
	if (!Number.isFinite(parsed)) return 10000;
	return Math.max(100, Math.min(300000, Math.floor(parsed)));
}

export function createStdbClient(): StdbSyncClient {
	const token = normalizeTokenEnv();
	return new StdbSyncClient({
		server: normalizeServerEnv(),
		database: normalizeDatabaseEnv(),
		timeoutMs: normalizeTimeoutEnv(),
		authToken: token,
		anonymous: normalizeAnonymousEnv(token)
	});
}

export class StdbStoreBase {
	protected readonly client = createStdbClient();
	protected readonly outbox: StatePlaneOutbox | null;
	protected readonly reducerName: string;
	protected readonly mirrorLegacyWrites: boolean;

	constructor(options: StdbPrimaryStoreOptions = {}) {
		this.outbox = options.outbox || null;
		this.reducerName = options.reducerName || process.env.WABI_STDB_BRIDGE_REDUCER || 'ingest_wabi_event';
		this.mirrorLegacyWrites = options.mirrorLegacyWrites !== false;
	}

	protected ingest(
		entity: 'message' | 'channel' | 'channel_member' | 'user' | 'session' | 'rbac',
		operation: string,
		payload: Record<string, unknown>
	): void {
		const event = {
			eventId: toStdbEventId(entity, operation, payload),
			timestamp: nowMs(),
			entity,
			operation,
			payload
		};
		this.client.callReducer(this.reducerName, [JSON.stringify(event)]);
		this.outbox?.append(event);
	}

	protected recordWriteFailure(stats: BaseStoreStats, op: string, error: unknown): never {
		stats.writesFailed += 1;
		stats.lastErrorAt = nowMs();
		stats.lastError = error instanceof Error ? error.message : String(error);
		bumpOperation(stats, `${op}_failed`);
		throw error instanceof Error ? error : new Error(String(error));
	}

	protected mirrorWrite(
		stats: BaseStoreStats,
		tracker: {
			attempted: number;
			succeeded: number;
			failed: number;
			lastError: string | null;
			lastErrorAt: number | null;
		},
		op: string,
		fn: () => void
	): void {
		if (!this.mirrorLegacyWrites) return;
		tracker.attempted += 1;
		try {
			fn();
			tracker.succeeded += 1;
		} catch (error) {
			tracker.failed += 1;
			tracker.lastErrorAt = nowMs();
			tracker.lastError = error instanceof Error ? error.message : String(error);
			bumpOperation(stats, `shadow_${op}_failed`);
		}
	}
}
