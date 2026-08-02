import { browser } from '$app/environment';
import { writable } from 'svelte/store';
import { parseApiJson } from './api/utils';
import { getLocalMockPlaces, isLocalMockApiMode } from './localMockApi';
import { getServerUrl } from './serverUrl';
import { normalizeRegistryPayload } from './placeNormalization';
import { isEndpointUnsupported, markEndpointUnsupported } from './optionalEndpoints';
import type { PlaceRecord } from './placeRegistry';

export const placeRegistry = writable<PlaceRecord[]>([]);
export const placeRegistryLoaded = writable(false);
export const placeRegistryLoading = writable(false);

let loadPromise: Promise<PlaceRecord[]> | null = null;

export async function loadPlaceRegistry(force = false): Promise<PlaceRecord[]> {
	if (!browser) return [];
	if (!force && loadPromise) return loadPromise;

	loadPromise = (async () => {
		placeRegistryLoading.set(true);
		if (isLocalMockApiMode()) {
			const places = getLocalMockPlaces();
			placeRegistry.set(places);
			placeRegistryLoaded.set(true);
			placeRegistryLoading.set(false);
			return places;
		}

		const placesUrl = `${getServerUrl()}/api/places`;
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
			placeRegistry.set(normalized);
			placeRegistryLoaded.set(true);
			return normalized;
		} catch (error) {
			// Network / unexpected only — HTML/empty already soft-failed above.
			console.warn('[Places] Failed to load registry:', error);
			placeRegistry.set([]);
			placeRegistryLoaded.set(false);
			return [];
		} finally {
			placeRegistryLoading.set(false);
		}
	})();

	const result = await loadPromise;
	if (force) {
		loadPromise = null;
	}
	return result;
}
