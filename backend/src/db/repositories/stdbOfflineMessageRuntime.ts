import { createStdbClient, INGEST_AUTH_KEY_HASH } from '../../state-plane/stdbCommon.js';
import { toStdbEventId, type StdbDecodedRow } from '../../state-plane/stdbSyncClient.js';

const stdbClient = createStdbClient();
const reducerName = process.env.WABI_STDB_BRIDGE_REDUCER || 'ingest_wabi_event';
const warnedKeys = new Set<string>();

function warnOnce(key: string, error: unknown): void {
	if (warnedKeys.has(key)) return;
	warnedKeys.add(key);
	const detail = error instanceof Error ? error.message : String(error);
	console.warn(`[StatePlane] ${key}; STDB write failed (${detail})`);
}

export function stdbOfflineMessagesEnabled(): boolean {
	return stdbClient.isEnabled();
}

export function stdbOfflineMessageRows(key: string, query: string): StdbDecodedRow[] | null {
	if (!stdbOfflineMessagesEnabled()) return null;
	try {
		return stdbClient.sqlRows(query);
	} catch (error) {
		warnOnce(key, error);
		return null;
	}
}

export function stdbOfflineMessageIngest(
	key: string,
	operation: string,
	payload: Record<string, unknown>
): boolean {
	if (!stdbOfflineMessagesEnabled()) return false;
	try {
		const event: Record<string, unknown> = {
			eventId: toStdbEventId('offline_message', operation, payload),
			timestamp: Date.now(),
			entity: 'offline_message',
			operation,
			payload
		};
		if (INGEST_AUTH_KEY_HASH) event.authKey = INGEST_AUTH_KEY_HASH;
		stdbClient.callReducer(reducerName, [JSON.stringify(event)]);
		return true;
	} catch (error) {
		warnOnce(key, error);
		return false;
	}
}