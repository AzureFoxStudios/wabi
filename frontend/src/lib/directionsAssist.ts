import { browser } from '$app/environment';
import { writable } from 'svelte/store';
import { channelMessages } from '$lib/socket';
import {
	buildPlaceDirectionsLabel,
	buildPlaceMessageEntity,
	resolvePlaceReference,
	type PlaceRecord
} from '$lib/placeRegistry';
import { buildMapExternalUrl, openPreferredMapSurface } from '$lib/mapWorkspace';

const STORAGE_KEY = 'wabi-directions-assist-v1';
const LOCAL_DIRECTIONS_TTL_MS = 10 * 60 * 1000;

export interface DirectionsAssistSettings {
	gpsEnabled: boolean;
}

const DEFAULT_SETTINGS: DirectionsAssistSettings = {
	gpsEnabled: false
};

const localDirectionsTimeouts = new Map<string, number>();

function loadSettings(): DirectionsAssistSettings {
	if (!browser) return DEFAULT_SETTINGS;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return DEFAULT_SETTINGS;
		const parsed = JSON.parse(raw) as Partial<DirectionsAssistSettings>;
		return {
			gpsEnabled: parsed.gpsEnabled === true
		};
	} catch {
		return DEFAULT_SETTINGS;
	}
}

function persistSettings(settings: DirectionsAssistSettings): void {
	if (!browser) return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	} catch {
		// best-effort persistence only
	}
}

const initialSettings = loadSettings();

export const directionsAssistSettings = writable<DirectionsAssistSettings>(initialSettings);

directionsAssistSettings.subscribe((value) => {
	persistSettings(value);
});

export function setDirectionsGpsEnabled(enabled: boolean): void {
	directionsAssistSettings.update((state) => ({ ...state, gpsEnabled: enabled }));
}

function formatDirectionsCoordinates(place: PlaceRecord): string | null {
	if (place.lat == null || place.lon == null) return null;
	return `${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`;
}

function buildDirectionsRouteUrl(
	place: PlaceRecord,
	origin?: { lat: number; lon: number } | null
): { url: string; label: string } | null {
	if (place.lat == null || place.lon == null) {
		return null;
	}
	if (origin) {
		const route = `${origin.lat},${origin.lon};${place.lat},${place.lon}`;
		return {
			url: `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${encodeURIComponent(route)}`,
			label: 'Open Route'
		};
	}
	const url = buildMapExternalUrl(place);
	return url ? { url, label: 'Open OSM' } : null;
}

export async function requestDirectionsOrigin(): Promise<{ lat: number; lon: number } | null> {
	if (!browser || !('geolocation' in navigator)) return null;
	return new Promise((resolve) => {
		navigator.geolocation.getCurrentPosition(
			(position) => {
				resolve({
					lat: position.coords.latitude,
					lon: position.coords.longitude
				});
			},
			() => resolve(null),
			{
				enableHighAccuracy: true,
				timeout: 8000,
				maximumAge: 60_000
			}
		);
	});
}

export async function requestDirectionsGpsPermission(): Promise<boolean> {
	const origin = await requestDirectionsOrigin();
	return Boolean(origin);
}

export async function pushLocalDirectionsCard(
	targetChannelId: string,
	rawTarget: string
): Promise<boolean> {
	if (!browser) return false;
	const resolved = resolvePlaceReference(rawTarget);
	if (!resolved) return false;

	const settings = loadSettings();
	const origin = settings.gpsEnabled ? await requestDirectionsOrigin() : null;
	const directionLabel = buildPlaceDirectionsLabel(resolved);
	const header = `Directions to ${directionLabel}`;
	const external = buildDirectionsRouteUrl(resolved.place, origin);
	const resolvedLayerLabel =
		(resolved.poi?.layerId &&
			resolved.place.mapLayers.find((layer) => layer.id === resolved.poi?.layerId)?.name) ||
		'';
	const coordinates = formatDirectionsCoordinates(resolved.place) || '';
	const text = header;
	const mentionStart = header.indexOf(directionLabel);
	const messageId = `local-directions-${Date.now()}`;
	const expiresAt = Date.now() + LOCAL_DIRECTIONS_TTL_MS;
	const entities =
		mentionStart >= 0
			? [
					buildPlaceMessageEntity(
						resolved.place,
						mentionStart,
						mentionStart + directionLabel.length,
						{
							poi: resolved.poi,
							displayText: directionLabel
						}
					)
				]
			: [];

	channelMessages.update((state) => ({
		...state,
		[targetChannelId]: [
			...(state[targetChannelId] || []),
			{
				id: messageId,
				user: 'Directions',
				userId: 'local-directions',
				text,
				timestamp: Date.now(),
				type: 'text',
				entities,
				localCard: {
					kind: 'directions',
					placeId: resolved.place.id,
					placeLabel: directionLabel,
					poiId: resolved.poi?.id,
					poiLabel: resolved.poi?.name,
					layerId: resolved.poi?.layerId,
					layerLabel: resolvedLayerLabel || undefined,
					building: resolved.place.building || undefined,
					floor: resolved.place.floor || undefined,
					coordinates: coordinates || undefined,
					externalUrl: external?.url,
					externalLabel: external?.label,
					originCoordinates: origin ? `${origin.lat.toFixed(5)}, ${origin.lon.toFixed(5)}` : undefined,
					expiresAt
				}
			}
		]
	}));

	void openPreferredMapSurface(resolved.place.id, {
		layerId: resolved.poi?.layerId || null,
		poiId: resolved.poi?.id || null
	});

	const timeoutHandle = window.setTimeout(() => {
		channelMessages.update((state) => ({
			...state,
			[targetChannelId]: (state[targetChannelId] || []).filter((message) => message.id !== messageId)
		}));
		localDirectionsTimeouts.delete(messageId);
	}, LOCAL_DIRECTIONS_TTL_MS);
	localDirectionsTimeouts.set(messageId, timeoutHandle);

	return true;
}
