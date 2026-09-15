import type { MapPoiDisplayPreference } from '$lib/mapDisplayPreferences';
import type {
	PlaceDraft,
	PlaceMapLayerDraft,
	PlaceMapLayerRecord,
	PlacePoiDraft,
	PlacePoiIconPreset,
	PlacePoiRecord,
	PlacePoiThemePreset,
	PlaceRecord
} from '$lib/placeRegistry';

export function normalizeKey(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export function splitCsvInput(value: string): string[] {
	return value
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
}

export function parseCoordinate(value: string): number | null {
	if (!value.trim()) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function clampNormalized(value: number): number {
	return Math.max(0, Math.min(1, value));
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
		if (indexes.length > 1) {
			issues.push(`Duplicate layer ID "${id}" on layers ${indexes.join(', ')}.`);
		}
	}
	for (const [id, indexes] of poiIds.entries()) {
		if (indexes.length > 1) {
			issues.push(`Duplicate POI ID "${id}" on POIs ${indexes.join(', ')}.`);
		}
	}

	return issues;
}

export function normalizeRotationDegrees(value: number): number {
	const normalized = ((value % 360) + 360) % 360;
	return Number(normalized.toFixed(3));
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
		x: clampNormalized(x),
		y: clampNormalized(y),
		layerId: normalizeKey(draft.layerId) || null,
		description: draft.description.trim() || undefined,
		renderMode: draft.renderMode,
		themePreset: draft.themePreset || undefined,
		iconPreset: draft.iconPreset,
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
		rotation: normalizeRotationDegrees(parseCoordinate(draft.rotation) ?? 0)
	};
}

export function buildDraftPreview(draft: PlaceDraft, allowEmptyDraft = false): PlaceRecord | null {
	if (!allowEmptyDraft && !draft.name.trim() && !draft.id.trim()) {
		return null;
	}
	const id = normalizeKey(draft.id || draft.name || 'draft-place');
	const name = draft.name.trim() || 'Untitled Place';
	const mapLayers = draft.mapLayers
		.map((layer) => draftMapLayerToRecord(layer))
		.filter((layer): layer is PlaceMapLayerRecord => Boolean(layer));
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
		mapRotation: primaryLayer?.rotation ?? normalizeRotationDegrees(parseCoordinate(draft.mapRotation) ?? 0),
		poiThemePreset: draft.poiThemePreset,
		mapLayers,
		pois: draft.pois.map((poi) => draftPoiToRecord(poi)).filter((poi): poi is PlacePoiRecord => Boolean(poi)),
		tags: splitCsvInput(draft.tags)
	};
}

export function formatMapPlaceMeta(place: PlaceRecord | null): string {
	if (!place) return 'No place selected';
	const parts: string[] = [];
	if (place.building) parts.push(place.building);
	if (place.floor) parts.push(`Floor ${place.floor}`);
	if (place.lat != null && place.lon != null) parts.push(`${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`);
	return parts.join(' - ') || `@${place.slug}`;
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
	if (poi.iconGlyph && poi.iconGlyph.trim()) {
		return poi.iconGlyph.trim();
	}
	switch (poi.iconPreset || 'pin') {
		case 'star':
			return '*';
		case 'door':
			return 'D';
		case 'food':
			return 'F';
		case 'meeting':
			return 'M';
		case 'warning':
			return '!';
		case 'vendor':
			return '$';
		case 'boss':
			return 'B';
		case 'info':
			return 'i';
		default:
			return '+';
	}
}

export function formatServerPoiTheme(
	poi: Pick<PlacePoiRecord, 'themePreset'>,
	defaultTheme: PlacePoiThemePreset
): string {
	if (poi.themePreset) {
		return formatPoiThemePreset(poi.themePreset);
	}
	return `Place default (${formatPoiThemePreset(defaultTheme)})`;
}

export function formatPoiDisplayPreference(mode: MapPoiDisplayPreference): string {
	if (mode === 'label') return 'Labels only';
	if (mode === 'pin') return 'Pins only';
	if (mode === 'both') return 'Labels + Pins';
	return 'Server default';
}
