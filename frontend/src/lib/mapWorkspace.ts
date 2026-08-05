import { derived, get, writable } from 'svelte/store';
import { layoutStore } from '$lib/layoutStore';
import { mobileTabQueue } from '$lib/mobileTabQueue';
import { getPlaceById, loadPlaceRegistry, type PlaceRecord } from '$lib/placeRegistry';
import { placeRegistry } from '$lib/placeStore';

export const MAP_ADDON_ID = 'server-map';

const focusedPlaceId = writable<string | null>(null);
const focusedLayerId = writable<string | null>(null);
const focusedPoiId = writable<string | null>(null);
const mapHydrated = writable(false);

export interface MapFocusOptions {
	layerId?: string | null;
	poiId?: string | null;
	surface?: 'auto' | 'panel' | 'full' | null;
}

export const focusedMapPlaceId = {
	subscribe: focusedPlaceId.subscribe
};

export const focusedMapLayerId = {
	subscribe: focusedLayerId.subscribe
};

export const focusedMapPoiId = {
	subscribe: focusedPoiId.subscribe
};

export const focusedMapPlace = derived(
	[focusedPlaceId, placeRegistry],
	([$focusedPlaceId, $places]): PlaceRecord | null => {
		if (!$focusedPlaceId) return null;
		return $places.find((place) => place.id === $focusedPlaceId || place.slug === $focusedPlaceId) || null;
	}
);

export async function ensureMapRegistry(): Promise<PlaceRecord[]> {
	const places = await loadPlaceRegistry();
	mapHydrated.set(true);
	return places;
}

export async function ensureMapFocus(preferredPlaceId: string | null = null): Promise<PlaceRecord | null> {
	const places = await ensureMapRegistry();
	let nextPlace: PlaceRecord | null = null;

	if (preferredPlaceId) {
		nextPlace = getPlaceById(preferredPlaceId) || null;
	}

	if (!nextPlace) {
		const current = get(focusedMapPlace);
		if (current) {
			return current;
		}
		nextPlace = places[0] || null;
	}

	focusedPlaceId.set(nextPlace?.id || null);
	return nextPlace;
}

function hasExplicitFocusOptions(options: MapFocusOptions): boolean {
	return Object.prototype.hasOwnProperty.call(options, 'layerId') || Object.prototype.hasOwnProperty.call(options, 'poiId');
}

function stripSurfaceOption(options: MapFocusOptions): MapFocusOptions {
	return {
		layerId: options.layerId ?? null,
		poiId: options.poiId ?? null
	};
}

function applyMapFocusContext(placeId: string | null, options: MapFocusOptions = {}): void {
	if (!placeId) {
		focusedPlaceId.set(null);
		focusedLayerId.set(null);
		focusedPoiId.set(null);
		return;
	}
	focusedPlaceId.set(placeId);
	focusedLayerId.set(options.layerId ?? null);
	focusedPoiId.set(options.poiId ?? null);
}

export async function focusMapPlace(placeId: string | null, options: MapFocusOptions = {}): Promise<PlaceRecord | null> {
	if (!placeId) {
		applyMapFocusContext(null);
		return null;
	}
	const nextPlace = await ensureMapFocus(placeId);
	applyMapFocusContext(nextPlace?.id || null, options);
	return nextPlace;
}

export async function openMapPanel(
	placeId: string | null = null,
	options: MapFocusOptions = {}
): Promise<PlaceRecord | null> {
	const focusOptions = stripSurfaceOption(options);
	const nextPlace = await ensureMapFocus(placeId);
	if (placeId || hasExplicitFocusOptions(focusOptions)) {
		applyMapFocusContext(nextPlace?.id || null, focusOptions);
	}
	layoutStore.showMapTab();
	return nextPlace;
}

export async function openFullMapTab(
	placeId: string | null = null,
	options: MapFocusOptions = {}
): Promise<PlaceRecord | null> {
	const focusOptions = stripSurfaceOption(options);
	const nextPlace = await ensureMapFocus(placeId);
	if (placeId || hasExplicitFocusOptions(focusOptions)) {
		applyMapFocusContext(nextPlace?.id || null, focusOptions);
	}
	mobileTabQueue.openAddonTab(MAP_ADDON_ID);
	return nextPlace;
}

export async function openPreferredMapSurface(
	placeId: string | null = null,
	options: MapFocusOptions = {}
): Promise<PlaceRecord | null> {
	if (options.surface === 'panel') {
		return openMapPanel(placeId, options);
	}
	if (options.surface === 'full') {
		return openFullMapTab(placeId, options);
	}
	const rightPanelView = get(layoutStore.rightPanelView);
	const selectedDmChannelId = get(layoutStore.selectedDmChannelId);
	if (rightPanelView === 'map') {
		return openMapPanel(placeId, options);
	}
	if (rightPanelView === 'dms' && selectedDmChannelId) {
		return openFullMapTab(placeId, options);
	}
	return openMapPanel(placeId, options);
}

export function getSelectedMapPlace(): PlaceRecord | null {
	return get(focusedMapPlace);
}

function formatCoord(value: number): string {
	return Number.isFinite(value) ? value.toFixed(5) : '0';
}

function clampLongitude(value: number): number {
	return Math.max(-179.999, Math.min(179.999, value));
}

function clampLatitude(value: number): number {
	return Math.max(-85, Math.min(85, value));
}

export function buildMapEmbedUrl(place: PlaceRecord | null, variant: 'compact' | 'full' | 'detached' = 'full'): string | null {
	if (!place || place.lat == null || place.lon == null) return null;
	const delta = variant === 'compact' ? 0.004 : 0.01;
	const left = clampLongitude(place.lon - delta);
	const right = clampLongitude(place.lon + delta);
	const top = clampLatitude(place.lat + delta);
	const bottom = clampLatitude(place.lat - delta);
	const bbox = [left, bottom, right, top].map((value) => encodeURIComponent(formatCoord(value))).join('%2C');
	const marker = `${encodeURIComponent(formatCoord(place.lat))}%2C${encodeURIComponent(formatCoord(place.lon))}`;
	return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${marker}`;
}

export function buildMapExternalUrl(place: PlaceRecord | null): string | null {
	if (!place || place.lat == null || place.lon == null) return null;
	return `https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lon}#map=18/${place.lat}/${place.lon}`;
}

export const mapWorkspaceState = {
	focusedPlaceId,
	focusedLayerId,
	focusedPoiId,
	mapHydrated
};
