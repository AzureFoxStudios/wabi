import { browser } from '$app/environment';
import { writable } from 'svelte/store';
import { getServerUrl } from './serverUrl';
import { normalizeRegistryPayload } from './placeNormalization';
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
		try {
			const response = await fetch(`${getServerUrl()}/api/places`, {
				credentials: 'include'
			});
			if (!response.ok) {
				throw new Error(`places_${response.status}`);
			}
			const payload = await response.json();
			const rows = Array.isArray(payload?.places) ? payload.places : [];
			const normalized = normalizeRegistryPayload(rows);
			placeRegistry.set(normalized);
			placeRegistryLoaded.set(true);
			return normalized;
		} catch (error) {
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
