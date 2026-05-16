import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';
import type { PlacePoiRenderMode, PlacePoiThemePreset, PlacePoiIconPreset, PlacePoiRecord } from './placeRegistry';

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

export function formatPoiThemePreset(preset: PlacePoiThemePreset): string {
	if (preset === 'campus') return 'Campus';
	if (preset === 'quest') return 'Quest';
	if (preset === 'terminal') return 'Terminal';
	return 'Classic';
}

export function formatPoiIconPreset(preset: PlacePoiIconPreset): string {
	if (preset === 'star') return 'Star';
	if (preset === 'door') return 'Door';
	if (preset === 'food') return 'Food';
	if (preset === 'meeting') return 'Meeting';
	if (preset === 'warning') return 'Warning';
	if (preset === 'vendor') return 'Vendor';
	if (preset === 'boss') return 'Boss';
	if (preset === 'info') return 'Info';
	return 'Pin';
}

export function resolvePoiMarkerGlyph(poi: Pick<PlacePoiRecord, 'iconGlyph' | 'iconPreset'>): string {
	if (poi.iconGlyph && poi.iconGlyph.trim()) return poi.iconGlyph.trim();
	switch (poi.iconPreset || 'pin') {
		case 'star': return '*';
		case 'door': return 'D';
		case 'food': return 'F';
		case 'meeting': return 'M';
		case 'warning': return '!';
		case 'vendor': return '$';
		case 'boss': return 'B';
		case 'info': return 'i';
		default: return '+';
	}
}

export function formatPoiDisplayPreference(mode: MapPoiDisplayPreference): string {
	if (mode === 'label') return 'Labels only';
	if (mode === 'pin') return 'Pins only';
	if (mode === 'both') return 'Labels + Pins';
	return 'Server default';
}
