import { createStdbClient, INGEST_AUTH_KEY_HASH } from '../../state-plane/stdbCommon.js';
import { toStdbEventId, type StdbDecodedRow } from '../../state-plane/stdbSyncClient.js';

type PreferenceEntity = 'settings' | 'theme';

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

export function stdbPreferencesEnabled(): boolean {
	return stdbClient.isEnabled();
}

export function stdbPreferenceRows(key: string, query: string): StdbDecodedRow[] {
	ensureConfigured('Preference repository');
	try {
		return stdbClient.sqlRows(query);
	} catch (error) {
		return fail('Preference query', key, error);
	}
}

export function stdbPreferenceIngest(
	key: string,
	entity: PreferenceEntity,
	operation: string,
	payload: Record<string, unknown>
): void {
	ensureConfigured('Preference repository');
	try {
		const event: Record<string, unknown> = {
			eventId: toStdbEventId(entity, operation, payload),
			timestamp: Date.now(),
			entity,
			operation,
			payload
		};
		if (INGEST_AUTH_KEY_HASH) event.authKey = INGEST_AUTH_KEY_HASH;
		stdbClient.callReducer(reducerName, [JSON.stringify(event)]);
	} catch (error) {
		fail('Preference ingest', key, error);
	}
}

export async function stdbPreferenceIngestAsync(
	key: string,
	entity: PreferenceEntity,
	operation: string,
	payload: Record<string, unknown>
): Promise<void> {
	ensureConfigured('Preference repository');
	try {
		const event: Record<string, unknown> = {
			eventId: toStdbEventId(entity, operation, payload),
			timestamp: Date.now(),
			entity,
			operation,
			payload
		};
		if (INGEST_AUTH_KEY_HASH) event.authKey = INGEST_AUTH_KEY_HASH;
		await stdbClient.callReducerAsync(reducerName, [JSON.stringify(event)]);
	} catch (error) {
		fail('Preference ingest', key, error);
	}
}
