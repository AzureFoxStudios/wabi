import { get } from 'svelte/store';
import { getAuthToken } from './authSession';
import { getServerUrl } from './serverUrl';
import { placeRegistry, placeRegistryLoaded } from './placeStore';
import type { PlaceRecord, PlaceDraft, PlacePoiDraft, PlaceMapLayerDraft, PlacePoiThemePreset, PlacePoiRecord, PlaceMapLayerRecord, PlacePoiIconPreset } from './placeRegistry';
import { normalizeRegistryPayload, normalizeKey, normalizeRotationDegrees, clampNormalizedCoordinate, normalizePoiRenderMode, safeString, safeCoordinate } from './placeNormalization';

export function resolvePlaceAssetUrl(value: string | null | undefined): string | null {
	const normalized = safeString(value);
	if (!normalized) return null;
	if (/^https?:\/\//i.test(normalized) || normalized.startsWith('data:') || normalized.startsWith('blob:')) {
		return normalized;
	}
	if (normalized.startsWith('/')) {
		return `${getServerUrl()}${normalized}`;
	}
	return normalized;
}

export function createEmptyPlaceDraft(): PlaceDraft {
	return {
		id: '',
		name: '',
		aliases: '',
		building: '',
		floor: '',
		lat: '',
		lon: '',
		description: '',
		modelUrl: '',
		mapImageUrl: '',
		mapRotation: '0',
		poiThemePreset: 'classic',
		mapLayers: [],
		pois: [],
		tags: ''
	};
}

export function createPlaceDraft(place: PlaceRecord | null | undefined): PlaceDraft {
	if (!place) return createEmptyPlaceDraft();
	const mapLayers = place.mapLayers.length
		? place.mapLayers.map((layer) => ({
				id: layer.id,
				name: layer.name,
				floor: layer.floor || '',
				imageUrl: layer.imageUrl,
				rotation: String(layer.rotation ?? 0)
			}))
		: place.mapImageUrl
			? [
					{
						id: 'main-map',
						name: place.floor ? `Floor ${place.floor}` : 'Main Map',
						floor: place.floor || '',
						imageUrl: place.mapImageUrl,
						rotation: String(place.mapRotation ?? 0)
					}
				]
			: [];
	const primaryLayer = mapLayers[0] || null;
	return {
		id: place.id || place.slug,
		name: place.name || '',
		aliases: place.aliases.filter((alias) => alias !== place.id && alias !== place.slug).join(', '),
		building: place.building || '',
		floor: place.floor || '',
		lat: place.lat != null ? String(place.lat) : '',
		lon: place.lon != null ? String(place.lon) : '',
		description: place.description || '',
		modelUrl: place.modelUrl || '',
		mapImageUrl: primaryLayer?.imageUrl || place.mapImageUrl || '',
		mapRotation: primaryLayer?.rotation || String(place.mapRotation ?? 0),
		poiThemePreset: place.poiThemePreset || 'classic',
		mapLayers,
		pois: place.pois.map((poi) => ({
			id: poi.id,
			name: poi.name,
			x: String(poi.x),
			y: String(poi.y),
			layerId: poi.layerId || '',
			description: poi.description || '',
			renderMode: poi.renderMode,
			themePreset: poi.themePreset || '',
			iconPreset: poi.iconPreset || 'pin',
			iconGlyph: poi.iconGlyph || '',
			iconColor: poi.iconColor || '#78b4ff'
		})),
		tags: place.tags.join(', ')
	};
}

export function createEmptyPoiDraft(): PlacePoiDraft {
	return {
		id: '',
		name: '',
		x: '0.5',
		y: '0.5',
		layerId: '',
		description: '',
		renderMode: 'both',
		themePreset: '',
		iconPreset: 'pin',
		iconGlyph: '📍',
		iconColor: '#78b4ff'
	};
}

export function createEmptyMapLayerDraft(): PlaceMapLayerDraft {
	return {
		id: '',
		name: '',
		floor: '',
		imageUrl: '',
		rotation: '0'
	};
}

function splitCsvInput(value: string): string[] {
	return value
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function serializeMapLayerDraft(draft: PlaceMapLayerDraft): Record<string, unknown> | null {
	const imageUrl = draft.imageUrl.trim();
	if (!imageUrl) return null;
	const id = normalizeKey(draft.id || draft.name || draft.floor || 'map-layer');
	const name = draft.name.trim() || draft.floor.trim() || 'Map Layer';
	const rotation = normalizeRotationDegrees(draft.rotation) ?? 0;
	return {
		id,
		name,
		floor: draft.floor.trim() || undefined,
		imageUrl,
		rotation
	};
}

function serializePoiDraft(draft: PlacePoiDraft): Record<string, unknown> | null {
	const id = normalizeKey(draft.id || draft.name);
	const name = draft.name.trim();
	const x = clampNormalizedCoordinate(draft.x);
	const y = clampNormalizedCoordinate(draft.y);
	if (!id || !name || x == null || y == null) return null;
	return {
		id,
		name,
		x,
		y,
		layerId: normalizeKey(draft.layerId) || undefined,
		description: draft.description.trim() || undefined,
		renderMode: normalizePoiRenderMode(draft.renderMode),
		themePreset: draft.themePreset ? (draft.themePreset as PlacePoiThemePreset) : undefined,
		iconPreset: draft.iconPreset,
		iconGlyph: draft.iconGlyph.trim() || undefined,
		iconColor: draft.iconColor.trim() || undefined
	};
}

export function serializePlaceDraft(draft: PlaceDraft): Record<string, unknown> {
	const mapLayers = draft.mapLayers
		.map((layer) => serializeMapLayerDraft(layer))
		.filter((layer): layer is Record<string, unknown> => Boolean(layer));
	const primaryLayer = mapLayers[0] || null;
	const payload: Record<string, unknown> = {
		id: draft.id.trim() || draft.name.trim(),
		name: draft.name.trim(),
		aliases: splitCsvInput(draft.aliases),
		description: draft.description.trim() || undefined,
		building: draft.building.trim() || undefined,
		floor: draft.floor.trim() || undefined,
		modelUrl: draft.modelUrl.trim() || undefined,
		poiThemePreset: draft.poiThemePreset,
		mapImageUrl: (primaryLayer?.imageUrl as string | undefined) || draft.mapImageUrl.trim() || undefined,
		pois: draft.pois
			.map((poi) => serializePoiDraft(poi))
			.filter((poi): poi is Record<string, unknown> => Boolean(poi)),
		tags: splitCsvInput(draft.tags),
		mapLayers
	};

	const lat = clampNormalizedCoordinate(draft.lat);
	const lon = clampNormalizedCoordinate(draft.lon);
	const mapRotation =
		(typeof primaryLayer?.rotation === 'number' ? primaryLayer.rotation : null) ??
		normalizeRotationDegrees(draft.mapRotation);
	if (lat != null) payload.lat = lat;
	if (lon != null) payload.lon = lon;
	if (mapRotation != null) payload.mapRotation = mapRotation;
	return payload;
}

export async function savePlaceDraft(draft: PlaceDraft): Promise<PlaceRecord[]> {
	const token = getAuthToken();
	if (!token) throw new Error('You must be logged in to manage places.');

	const response = await fetch(`${getServerUrl()}/api/places`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
		},
		body: JSON.stringify({ place: serializePlaceDraft(draft) })
	});

	const payload = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(payload?.error || `Failed to save place (${response.status})`);
	}

	const normalized = normalizeRegistryPayload(payload?.places);
	placeRegistry.set(normalized);
	placeRegistryLoaded.set(true);
	return normalized;
}

export async function deletePlace(placeId: string): Promise<PlaceRecord[]> {
	const token = getAuthToken();
	if (!token) throw new Error('You must be logged in to manage places.');

	const response = await fetch(`${getServerUrl()}/api/places/${encodeURIComponent(placeId)}`, {
		method: 'DELETE',
		headers: {
			Authorization: `Bearer ${token}`
		}
	});

	const payload = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(payload?.error || `Failed to delete place (${response.status})`);
	}

	const normalized = normalizeRegistryPayload(payload?.places);
	placeRegistry.set(normalized);
	placeRegistryLoaded.set(true);
	return normalized;
}

function parseCoordinate(value: string): number | null {
	if (!value.trim()) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function draftPoiToRecord(draft: PlacePoiDraft): PlacePoiRecord | null {
	const name = draft.name.trim();
	const id = normalizeKey(draft.id || draft.name);
	const x = parseCoordinate(draft.x);
	const y = parseCoordinate(draft.y);
	if (!name || !id || x == null || y == null) return null;
	return {
		id,
		name,
		x: clampNormalizedCoordinate(x) ?? x,
		y: clampNormalizedCoordinate(y) ?? y,
		layerId: normalizeKey(draft.layerId) || null,
		description: draft.description.trim() || undefined,
		renderMode: draft.renderMode,
		themePreset: draft.themePreset || undefined,
		iconPreset: draft.iconPreset as PlacePoiIconPreset,
		iconGlyph: draft.iconGlyph.trim() || null,
		iconColor: draft.iconColor.trim() || null
	};
}

export function draftMapLayerToRecord(draft: PlaceMapLayerDraft): PlaceMapLayerRecord | null {
	const imageUrl = draft.imageUrl.trim();
	if (!imageUrl) return null;
	const id = normalizeKey(draft.id || draft.name || draft.floor || 'map-layer');
	const name = draft.name.trim() || draft.floor.trim() || 'Map Layer';
	return {
		id,
		name,
		floor: draft.floor.trim() || undefined,
		imageUrl,
		rotation: normalizeRotationDegrees(parseCoordinate(draft.rotation) ?? 0) ?? 0
	};
}

export function buildDraftPreview(draft: PlaceDraft): PlaceRecord | null {
	if (!draft.name.trim() && !draft.id.trim()) return null;
	const id = normalizeKey(draft.id || draft.name || 'draft-place');
	const name = draft.name.trim() || 'Untitled Place';
	const mapLayers = draft.mapLayers.map((layer) => draftMapLayerToRecord(layer)).filter((layer): layer is PlaceMapLayerRecord => Boolean(layer));
	const primaryLayer = mapLayers[0] || null;
	return {
		id,
		slug: id,
		name,
		aliases: splitCsvInput(draft.aliases),
		building: draft.building.trim() || undefined,
		floor: draft.floor.trim() || undefined,
		lat: parseCoordinate(draft.lat),
		lon: parseCoordinate(draft.lon),
		description: draft.description.trim() || undefined,
		modelUrl: draft.modelUrl.trim() || null,
		mapImageUrl: primaryLayer?.imageUrl || null,
		mapRotation: primaryLayer?.rotation ?? normalizeRotationDegrees(parseCoordinate(draft.mapRotation) ?? 0) ?? 0,
		poiThemePreset: draft.poiThemePreset,
		mapLayers,
		pois: draft.pois.map((poi) => draftPoiToRecord(poi)).filter((poi): poi is PlacePoiRecord => Boolean(poi)),
		tags: splitCsvInput(draft.tags)
	};
}

export function buildDraftValidationIssues(draft: PlaceDraft): string[] {
	const issues: string[] = [];
	const layerIds = new Map<string, number[]>();
	const poiIds = new Map<string, number[]>();
	draft.mapLayers.forEach((layer, index) => {
		const normalized = normalizeKey(layer.id || layer.name || layer.floor || '');
		if (!normalized) {
			issues.push(`Layer ${index + 1} needs an ID, name, or floor.`);
			return;
		}
		layerIds.set(normalized, [...(layerIds.get(normalized) || []), index + 1]);
	});
	draft.pois.forEach((poi, index) => {
		const normalized = normalizeKey(poi.id || poi.name || '');
		if (!normalized) {
			issues.push(`POI ${index + 1} needs an ID or name.`);
			return;
		}
		poiIds.set(normalized, [...(poiIds.get(normalized) || []), index + 1]);
	});
	for (const [id, indexes] of layerIds.entries()) {
		if (indexes.length > 1) issues.push(`Duplicate layer ID "${id}" on layers ${indexes.join(', ')}.`);
	}
	for (const [id, indexes] of poiIds.entries()) {
		if (indexes.length > 1) issues.push(`Duplicate POI ID "${id}" on POIs ${indexes.join(', ')}.`);
	}
	return issues;
}
