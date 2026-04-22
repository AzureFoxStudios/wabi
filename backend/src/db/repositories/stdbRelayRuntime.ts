import { createStdbClient, INGEST_AUTH_KEY_HASH } from '../../state-plane/stdbCommon.js';
import { toStdbEventId, type StdbDecodedRow } from '../../state-plane/stdbSyncClient.js';

const stdbClient = createStdbClient();
const reducerName = process.env.WABI_STDB_BRIDGE_REDUCER || 'ingest_wabi_event';

function fail(scope: string, key: string, error: unknown): never {
	const detail = error instanceof Error ? error.message : String(error);
	throw new Error(`[StatePlane] ${scope} failed for ${key}: ${detail}`);
}

function ensureConfigured(scope: string): void {
	if (!stdbClient.isEnabled()) {
		throw new Error(`[StatePlane] ${scope} requires STDB bridge configuration`);
	}
}

export function stdbRelaysEnabled(): boolean {
	return stdbClient.isEnabled();
}

export function stdbRelayRows(key: string, query: string): StdbDecodedRow[] {
	ensureConfigured('Relay repository');
	try {
		return stdbClient.sqlRows(query);
	} catch (error) {
		return fail('Relay query', key, error);
	}
}

export function stdbRelayIngest(
	key: string,
	operation: string,
	payload: Record<string, unknown>
): void {
	ensureConfigured('Relay repository');
	try {
		const event: Record<string, unknown> = {
			eventId: toStdbEventId('relay', operation, payload),
			timestamp: Date.now(),
			entity: 'relay',
			operation,
			payload
		};
		if (INGEST_AUTH_KEY_HASH) event.authKey = INGEST_AUTH_KEY_HASH;
		stdbClient.callReducer(reducerName, [JSON.stringify(event)]);
	} catch (error) {
		fail('Relay ingest', key, error);
	}
}
