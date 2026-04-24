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

export function stdbAlbumsEnabled(): boolean {
	return stdbClient.isEnabled();
}

export function stdbAlbumRows(key: string, query: string): StdbDecodedRow[] | null {
	if (!stdbAlbumsEnabled()) return null;
	try {
		return stdbClient.sqlRows(query);
	} catch (error) {
		warnOnce(key, error);
		return null;
	}
}

export function stdbAlbumIngest(
	key: string,
	operation: string,
	payload: Record<string, unknown>
): boolean {
	if (!stdbAlbumsEnabled()) return false;
	try {
		const event: Record<string, unknown> = {
			eventId: toStdbEventId('album', operation, payload),
			timestamp: Date.now(),
			entity: 'album',
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

export function stdbAlbumItemIngest(
	key: string,
	operation: string,
	payload: Record<string, unknown>
): boolean {
	if (!stdbAlbumsEnabled()) return false;
	try {
		const event: Record<string, unknown> = {
			eventId: toStdbEventId('album_item', operation, payload),
			timestamp: Date.now(),
			entity: 'album_item',
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