import { getStatePlaneConfigFromEnv } from '../state-plane/config.js';
import { createStdbClient, INGEST_AUTH_KEY_HASH } from '../state-plane/stdbCommon.js';
import { toStdbEventId, type StdbDecodedRow } from '../state-plane/stdbSyncClient.js';

type PaymentEntity = 'payment';

const statePlaneConfig = getStatePlaneConfigFromEnv();
const stdbClient = createStdbClient();
const reducerName = process.env.WABI_STDB_BRIDGE_REDUCER || 'ingest_wabi_event';
const warnedKeys = new Set<string>();

const USERNAME_CACHE_MAX_SIZE = 10_000;
const USERNAME_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const usernameCache = new Map<number, { value: string | null; cachedAt: number }>();

function warnOnce(key: string, error: unknown): void {
	if (warnedKeys.has(key)) return;
	warnedKeys.add(key);
	const detail = error instanceof Error ? error.message : String(error);
	console.warn(`[StatePlane] ${key}; falling back to SQLite (${detail})`);
}

export function stdbPaymentsEnabled(): boolean {
	return (
		statePlaneConfig.mode === 'stdb_primary' &&
		statePlaneConfig.stdbReadEnabled &&
		statePlaneConfig.stdbWriteEnabled &&
		stdbClient.isEnabled()
	);
}

export function stdbPaymentRows(key: string, query: string): StdbDecodedRow[] | null {
	if (!stdbPaymentsEnabled()) return null;
	try {
		return stdbClient.sqlRows(query);
	} catch (error) {
		warnOnce(key, error);
		return null;
	}
}

export function stdbPaymentIngest(
	key: string,
	operation: string,
	payload: Record<string, unknown>
): boolean {
	if (!stdbPaymentsEnabled()) return false;
	try {
		const event: Record<string, unknown> = {
				eventId: toStdbEventId('payment', operation, payload),
				timestamp: Date.now(),
				entity: 'payment' satisfies PaymentEntity,
				operation,
				payload
			};
		if (INGEST_AUTH_KEY_HASH) event.authKey = INGEST_AUTH_KEY_HASH;
		stdbClient.callReducer(reducerName, [
			JSON.stringify(event)
		]);
		return true;
	} catch (error) {
		warnOnce(key, error);
		return false;
	}
}

export function parseStdbRowJson<T>(row: StdbDecodedRow | null | undefined): T | null {
	if (!row) return null;
	const raw = row.row_json;
	if (typeof raw !== 'string' || raw.trim().length === 0) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

export function lookupStdbUsername(userId: number | null | undefined): string | null {
	if (userId == null || !Number.isFinite(userId) || userId <= 0) return null;
	const normalizedUserId = Math.floor(userId);
	const cached = usernameCache.get(normalizedUserId);
	if (cached && (Date.now() - cached.cachedAt) < USERNAME_CACHE_TTL_MS) {
		return cached.value;
	}

	const rows = stdbPaymentRows(
		`payment.user_lookup:${normalizedUserId}`,
		`SELECT row_json FROM state_user WHERE user_id = ${normalizedUserId} LIMIT 1`
	);
	const parsed = rows && rows.length > 0 ? parseStdbRowJson<{ username?: unknown }>(rows[0]) : null;
	const username =
		typeof parsed?.username === 'string' && parsed.username.trim().length > 0
			? parsed.username
			: null;
	// Evict oldest entries if cache is full
	if (usernameCache.size >= USERNAME_CACHE_MAX_SIZE) {
		const firstKey = usernameCache.keys().next().value;
		if (firstKey !== undefined) usernameCache.delete(firstKey);
	}
	usernameCache.set(normalizedUserId, { value: username, cachedAt: Date.now() });
	return username;
}
