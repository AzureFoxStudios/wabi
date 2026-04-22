import { createHash } from 'crypto';
import type { StatePlaneOutbox } from './outbox.js';
import { StdbSyncClient, toStdbEventId } from './stdbSyncClient.js';

/**
 * Pre-shared ingest auth key.  When set, every event sent to the
 * `ingest_wabi_event` reducer includes the SHA-256 hex digest so the
 * Rust module can verify the caller is the authorized backend.
 */
const INGEST_AUTH_SECRET = (process.env.WABI_STDB_INGEST_SECRET || '').trim();
export const INGEST_AUTH_KEY_HASH: string | null = INGEST_AUTH_SECRET
	? createHash('sha256').update(INGEST_AUTH_SECRET).digest('hex')
	: null;

export interface StdbPrimaryStoreOptions {
	outbox?: StatePlaneOutbox | null;
	reducerName?: string;
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
	if (value == null) return NaN;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : NaN;
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
	const value = process.env.WABI_STDB_AUTH_TOKEN?.trim();
	return value && value.length > 0 ? value : null;
}

function normalizeAnonymousEnv(token: string | null): boolean {
	if (token) return false;
	const defaultAnonymous = process.env.NODE_ENV === 'production' ? 'false' : 'true';
	const raw = (process.env.WABI_STDB_ANONYMOUS || defaultAnonymous).trim().toLowerCase();
	return raw !== '0' && raw !== 'false' && raw !== 'no' && raw !== 'off';
}

function normalizeTimeoutEnv(): number {
	const parsed = Number(process.env.WABI_STDB_BRIDGE_TIMEOUT_MS || '10000');
	if (!Number.isFinite(parsed)) return 10000;
	return Math.max(100, Math.min(30000, Math.floor(parsed)));
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

export function getStdbServer(): string | null {
	return normalizeServerEnv();
}

export function getStdbDatabase(): string | null {
	return normalizeDatabaseEnv();
}

export function getStdbAuthMode(): { token: string | null; anonymous: boolean } {
	const token = normalizeTokenEnv();
	return {
		token,
		anonymous: normalizeAnonymousEnv(token)
	};
}

export function getStdbTimeoutMs(): number {
	return normalizeTimeoutEnv();
}

export class StdbStoreBase {
	protected readonly client = createStdbClient();
	protected readonly outbox: StatePlaneOutbox | null;
	protected readonly reducerName: string;

	constructor(options: StdbPrimaryStoreOptions = {}) {
		this.outbox = options.outbox || null;
		this.reducerName = options.reducerName || process.env.WABI_STDB_BRIDGE_REDUCER || 'ingest_wabi_event';
	}

	protected ingest(
		entity: 'message' | 'channel' | 'channel_member' | 'user' | 'session' | 'rbac',
		operation: string,
		payload: Record<string, unknown>
	): void {
		const event: Record<string, unknown> = {
			eventId: toStdbEventId(entity, operation, payload),
			timestamp: nowMs(),
			entity,
			operation,
			payload
		};
		if (INGEST_AUTH_KEY_HASH) event.authKey = INGEST_AUTH_KEY_HASH;
		this.client.callReducer(this.reducerName, [JSON.stringify(event)]);
		this.outbox?.append(event);
	}

	protected async ingestAsync(
		entity: 'message' | 'channel' | 'channel_member' | 'user' | 'session' | 'rbac',
		operation: string,
		payload: Record<string, unknown>
	): Promise<void> {
		const event: Record<string, unknown> = {
			eventId: toStdbEventId(entity, operation, payload),
			timestamp: nowMs(),
			entity,
			operation,
			payload
		};
		if (INGEST_AUTH_KEY_HASH) event.authKey = INGEST_AUTH_KEY_HASH;
		await this.client.callReducerAsync(this.reducerName, [JSON.stringify(event)]);
		this.outbox?.append(event);
	}

	protected recordWriteFailure(stats: BaseStoreStats, op: string, error: unknown): never {
		stats.writesFailed += 1;
		stats.lastErrorAt = nowMs();
		stats.lastError = error instanceof Error ? error.message : String(error);
		bumpOperation(stats, `${op}_failed`);
		throw error instanceof Error ? error : new Error(String(error));
	}

}
