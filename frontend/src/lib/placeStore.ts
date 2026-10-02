import { browser } from '$app/environment';
import { writable } from 'svelte/store';
import { parseApiJson } from './api/utils';
import { getLocalMockPlaces, isLocalMockApiMode } from './localMockApi';
import { getServerUrl } from './serverUrl';
import { groupMembership } from './groupAccess';
import { normalizeRegistryPayload } from './placeNormalization';
import { isEndpointUnsupported, markEndpointUnsupported } from './optionalEndpoints';
import type { PlaceRecord } from './placeRegistry';

export const placeRegistry = writable<PlaceRecord[]>([]);
export const placeRegistryLoaded = writable(false);
export const placeRegistryLoading = writable(false);
export const placeRegistryScope = writable<{server: string; realm: string | null} | null>(null);
export function publishPlaceRegistry(records: PlaceRecord[], scope: {server: string; realm: string | null}): boolean {
 if (groupMembership.realm() !== scope.realm || getServerUrl() !== scope.server) return false;
 placeRegistryScope.set(scope); placeRegistry.set(records); placeRegistryLoaded.set(true);
 return true;
}

let loadPromise: Promise<PlaceRecord[]> | null = null;
let generation = 0;
let cachedServer: string | null = null;
function resetPlaceRegistry() {
 generation += 1; loadPromise = null;
 placeRegistryScope.set(null); placeRegistry.set([]); placeRegistryLoaded.set(false); placeRegistryLoading.set(false);
}
groupMembership.onContextChanged(resetPlaceRegistry);

export async function loadPlaceRegistry(force = false): Promise<PlaceRecord[]> {
	if (!browser) return [];
	const realm = groupMembership.realm(), server = getServerUrl();
	if (cachedServer !== server) { cachedServer = server; resetPlaceRegistry(); }
	if (!force && loadPromise) return loadPromise;

	const epoch = ++generation;
	const isCurrent = () => groupMembership.realm() === realm && generation === epoch && getServerUrl() === server;
	const request = (async () => {
		placeRegistryLoading.set(true);
		if (isLocalMockApiMode()) {
			const places = getLocalMockPlaces();
			publishPlaceRegistry(places, {server, realm});
			placeRegistryLoading.set(false);
			return places;
		}

		const placesUrl = `${server}/api/places`;
		if (isEndpointUnsupported(placesUrl)) {
			// Optional endpoint already known to be missing — silent fallback.
			placeRegistry.set([]);
			placeRegistryLoaded.set(false);
			return [];
		}

		try {
			const response = await fetch(placesUrl, {
				credentials: 'include'
			});
			if (!isCurrent()) return [];
			if (!response.ok) {
				if (response.status === 404 || response.status === 405) {
					// Optional endpoint not implemented yet — remember it and
					// fall back silently so we never spam the console with 404s.
					markEndpointUnsupported(placesUrl);
					placeRegistry.set([]);
					placeRegistryLoaded.set(false);
					return [];
				}
				throw new Error(`places_${response.status}`);
			}
			// Tim/SPA often returns 200 text/html for missing /api/places — treat like 404.
			const payload = await parseApiJson(response);
			if (!isCurrent()) return [];
			if (payload == null || typeof payload !== 'object') {
				markEndpointUnsupported(placesUrl);
				placeRegistry.set([]);
				placeRegistryLoaded.set(false);
				return [];
			}
			const rows = Array.isArray((payload as { places?: unknown }).places)
				? (payload as { places: unknown[] }).places
				: [];
			const normalized = normalizeRegistryPayload(rows);
			publishPlaceRegistry(normalized, {server, realm});
			return normalized;
		} catch (error) {
			if (!isCurrent()) return [];
			// Network / unexpected only — HTML/empty already soft-failed above.
			console.warn('[Places] Failed to load registry:', error);
			placeRegistry.set([]);
			placeRegistryLoaded.set(false);
			return [];
		} finally {
			if (isCurrent()) placeRegistryLoading.set(false);
		}
	})();

	loadPromise = request;
	const result = await request;
	if (force && loadPromise === request) {
		loadPromise = null;
	}
	return result;
}
