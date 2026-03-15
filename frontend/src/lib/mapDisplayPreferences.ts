import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';
import type { PlacePoiRenderMode } from './placeRegistry';

export type MapPoiDisplayPreference = 'server' | PlacePoiRenderMode;

interface MapDisplayPreferences {
	poiDisplayMode: MapPoiDisplayPreference;
}

const STORAGE_KEY = 'wabi:map-display-preferences:v1';
const DEFAULT_PREFERENCES: MapDisplayPreferences = {
	poiDisplayMode: 'server'
};

function normalizePoiDisplayPreference(value: unknown): MapPoiDisplayPreference {
	if (value === 'label' || value === 'pin' || value === 'both') return value;
	return 'server';
}

function loadPreferences(): MapDisplayPreferences {
	if (!browser) return DEFAULT_PREFERENCES;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return DEFAULT_PREFERENCES;
		const parsed = JSON.parse(raw) as Partial<MapDisplayPreferences> | null;
		return {
			poiDisplayMode: normalizePoiDisplayPreference(parsed?.poiDisplayMode)
		};
	} catch {
		return DEFAULT_PREFERENCES;
	}
}

export const mapDisplayPreferences = writable<MapDisplayPreferences>(loadPreferences());

if (browser) {
	mapDisplayPreferences.subscribe((value) => {
		try {
			localStorage.setItem(
				STORAGE_KEY,
				JSON.stringify({
					poiDisplayMode: normalizePoiDisplayPreference(value.poiDisplayMode)
				})
			);
		} catch {
			// Best effort persistence only.
		}
	});
}

export function getMapPoiDisplayPreference(): MapPoiDisplayPreference {
	return get(mapDisplayPreferences).poiDisplayMode;
}

export function setMapPoiDisplayPreference(mode: MapPoiDisplayPreference): void {
	mapDisplayPreferences.update((current) => ({
		...current,
		poiDisplayMode: normalizePoiDisplayPreference(mode)
	}));
}

export function resolvePoiRenderMode(
	serverMode: PlacePoiRenderMode,
	overrideMode: MapPoiDisplayPreference
): PlacePoiRenderMode {
	return overrideMode === 'server' ? serverMode : overrideMode;
}
