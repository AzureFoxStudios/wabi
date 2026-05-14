import type { PlaceRecord, PlaceMapLayerRecord, PlacePoiRecord, PlacePoiRenderMode, PlacePoiThemePreset } from './placeRegistry';

export type PlacePoiIconPreset = 'star' | 'door' | 'food' | 'meeting' | 'warning' | 'vendor' | 'boss' | 'info' | 'pin';

export function normalizeKey(value: unknown): string {
	return String(value || '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export function safeString(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function safeStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((entry) => safeString(entry))
		.filter((entry): entry is string => Boolean(entry));
}

export function safeCoordinate(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

export function clampNormalizedCoordinate(value: unknown): number | null {
	const parsed = safeCoordinate(value);
	if (parsed == null) return null;
	return Math.max(0, Math.min(1, parsed));
}

export function normalizeRotationDegrees(value: unknown): number | null {
	const parsed = safeCoordinate(value);
	if (parsed == null) return null;
	const normalized = ((parsed % 360) + 360) % 360;
	return Number(normalized.toFixed(3));
}

export function normalizePoiRenderMode(value: unknown): PlacePoiRenderMode {
	if (value === 'pin') return 'pin';
	if (value === 'both') return 'both';
	return 'label';
}

export function normalizePoiThemePreset(value: unknown): PlacePoiThemePreset {
	if (value === 'campus' || value === 'quest' || value === 'terminal') return value;
	return 'classic';
}

export function normalizePoiIconPreset(value: unknown): PlacePoiIconPreset {
	const iconPreset = value as string;
	if (
		iconPreset === 'star' ||
		iconPreset === 'door' ||
		iconPreset === 'food' ||
		iconPreset === 'meeting' ||
		iconPreset === 'warning' ||
		iconPreset === 'vendor' ||
		iconPreset === 'boss' ||
		iconPreset === 'info'
	) {
		return iconPreset as PlacePoiIconPreset;
	}
	return 'pin';
}

export function normalizeMapLayerRecord(raw: unknown): PlaceMapLayerRecord | null {
	if (!raw || typeof raw !== 'object') return null;
	const record = raw as Record<string, unknown>;
	const imageUrl = safeString(record.imageUrl || record.image_url || record.mapImageUrl || record.map_image_url);
	if (!imageUrl) return null;
	const name = safeString(record.name) || safeString(record.label) || safeString(record.floor) || 'Map Layer';
	const id = normalizeKey(record.id || record.name || record.floor || 'map-layer');
	const rotation = normalizeRotationDegrees(record.rotation) ?? 0;
	return { id, name, floor: safeString(record.floor), imageUrl, rotation };
}

export function normalizePoiRecord(raw: unknown): PlacePoiRecord | null {
	if (!raw || typeof raw !== 'object') return null;
	const record = raw as Record<string, unknown>;
	const id = normalizeKey(record.id || record.name || 'poi');
	const name = safeString(record.name) || 'Unnamed POI';
	const x = clampNormalizedCoordinate(record.x) ?? 0.5;
	const y = clampNormalizedCoordinate(record.y) ?? 0.5;
	return {
		id,
		name,
		x,
		y,
		layerId: safeString(record.layerId) || null,
		description: safeString(record.description),
		renderMode: normalizePoiRenderMode(record.renderMode),
		themePreset: safeString(record.themePreset),
		iconPreset: safeString(record.iconPreset),
		iconGlyph: safeString(record.iconGlyph),
		iconColor: safeString(record.iconColor)
	};
}

export function normalizePlaceRecord(raw: unknown): PlaceRecord | null {
	if (!raw || typeof raw !== 'object') return null;
	const record = raw as Record<string, unknown>;
	const slug = normalizeKey(record.slug || record.id || record.name || '');
	if (!slug) return null;
	const id = normalizeKey(record.id || slug);
	const name = safeString(record.name) || slug;
	return {
		id,
		slug,
		name,
		aliases: safeStringList(record.aliases || []),
		building: safeString(record.building),
		floor: safeString(record.floor),
		lat: safeCoordinate(record.lat),
		lon: safeCoordinate(record.lon),
		description: safeString(record.description),
		modelUrl: safeString(record.modelUrl) || null,
		mapImageUrl: safeString(record.mapImageUrl) || null,
		mapRotation: normalizeRotationDegrees(record.mapRotation) ?? 0,
		poiThemePreset: (safeString(record.poiThemePreset) as PlacePoiThemePreset) || 'classic',
		mapLayers: safeStringList(record.mapLayers).map((entry) => normalizeMapLayerRecord(entry)).filter((entry): entry is PlaceMapLayerRecord => Boolean(entry)),
		pois: safeStringList(record.pois).map((entry) => normalizePoiRecord(entry)).filter((entry): entry is PlacePoiRecord => Boolean(entry)),
		tags: Array.from(new Set(safeStringList(record.tags).map((entry) => entry.toLowerCase())))
	};
}

export function normalizeRegistryPayload(rows: unknown): PlaceRecord[] {
	return (Array.isArray(rows) ? rows : [])
		.map((entry) => normalizePlaceRecord(entry))
		.filter((entry): entry is PlaceRecord => Boolean(entry));
}
