import { browser } from '$app/environment';
import { get } from 'svelte/store';
import { writable } from 'svelte/store';
import { getAuthToken } from './authSession';
import { getServerUrl } from './serverUrl';

export interface PlaceRecord {
	id: string;
	slug: string;
	name: string;
	aliases: string[];
	building?: string;
	floor?: string;
	lat: number | null;
	lon: number | null;
	description?: string;
	modelUrl?: string | null;
	mapImageUrl?: string | null;
	mapRotation: number;
	poiThemePreset: PlacePoiThemePreset;
	mapLayers: PlaceMapLayerRecord[];
	pois: PlacePoiRecord[];
	tags: string[];
}

export type PlacePoiRenderMode = 'label' | 'pin' | 'both';
export type PlacePoiThemePreset = 'classic' | 'campus' | 'quest' | 'terminal';
export type PlacePoiIconPreset = 'pin' | 'star' | 'door' | 'food' | 'meeting' | 'warning' | 'vendor' | 'boss' | 'info';

export interface PlaceMapLayerRecord {
	id: string;
	name: string;
	floor?: string;
	imageUrl: string;
	rotation: number;
}

export interface PlacePoiRecord {
	id: string;
	name: string;
	x: number;
	y: number;
	layerId?: string | null;
	description?: string;
	renderMode: PlacePoiRenderMode;
	themePreset?: PlacePoiThemePreset | null;
	iconPreset?: PlacePoiIconPreset | null;
	iconGlyph?: string | null;
	iconColor?: string | null;
}

export interface PlaceDraft {
	id: string;
	name: string;
	aliases: string;
	building: string;
	floor: string;
	lat: string;
	lon: string;
	description: string;
	modelUrl: string;
	mapImageUrl: string;
	mapRotation: string;
	poiThemePreset: PlacePoiThemePreset;
	mapLayers: PlaceMapLayerDraft[];
	pois: PlacePoiDraft[];
	tags: string;
}

export interface PlaceMapLayerDraft {
	id: string;
	name: string;
	floor: string;
	imageUrl: string;
	rotation: string;
}

export interface PlacePoiDraft {
	id: string;
	name: string;
	x: string;
	y: string;
	layerId: string;
	description: string;
	renderMode: PlacePoiRenderMode;
	themePreset: PlacePoiThemePreset | '';
	iconPreset: PlacePoiIconPreset;
	iconGlyph: string;
	iconColor: string;
}

export interface PlaceMessageEntity {
	kind: 'place';
	start: number;
	end: number;
	placeId: string;
	layerId?: string;
	poiId?: string;
	label: string;
	displayText?: string;
}

export type MessageEntity = PlaceMessageEntity;

export interface PlaceMentionSuggestion {
	key: string;
	label: string;
	value: string;
	detail: string;
	place: PlaceRecord;
	poi?: PlacePoiRecord;
}

export interface PlaceResolution {
	place: PlaceRecord;
	poi?: PlacePoiRecord;
}

export const placeRegistry = writable<PlaceRecord[]>([]);
export const placeRegistryLoaded = writable(false);
export const placeRegistryLoading = writable(false);

let loadPromise: Promise<PlaceRecord[]> | null = null;

function normalizeKey(value: unknown): string {
	return String(value || '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function safeString(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function safeStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((entry) => safeString(entry))
		.filter((entry): entry is string => Boolean(entry));
}

function safeCoordinate(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function clampNormalizedCoordinate(value: unknown): number | null {
	const parsed = safeCoordinate(value);
	if (parsed == null) return null;
	return Math.max(0, Math.min(1, parsed));
}

function normalizeRotationDegrees(value: unknown): number | null {
	const parsed = safeCoordinate(value);
	if (parsed == null) return null;
	const normalized = ((parsed % 360) + 360) % 360;
	return Number(normalized.toFixed(3));
}

function normalizePoiRenderMode(value: unknown): PlacePoiRenderMode {
	if (value === 'pin') return 'pin';
	if (value === 'both') return 'both';
	return 'label';
}

export function normalizePoiThemePreset(value: unknown): PlacePoiThemePreset {
	if (value === 'campus' || value === 'quest' || value === 'terminal') return value;
	return 'classic';
}

export function normalizePoiIconPreset(value: unknown): PlacePoiIconPreset {
	if (
		value === 'star' ||
		value === 'door' ||
		value === 'food' ||
		value === 'meeting' ||
		value === 'warning' ||
		value === 'vendor' ||
		value === 'boss' ||
		value === 'info'
	) {
		return value;
	}
	return 'pin';
}

function normalizeMapLayerRecord(raw: unknown): PlaceMapLayerRecord | null {
	if (!raw || typeof raw !== 'object') return null;
	const record = raw as Record<string, unknown>;
	const imageUrl = safeString(record.imageUrl || record.image_url || record.mapImageUrl || record.map_image_url);
	if (!imageUrl) return null;
	const name = safeString(record.name) || safeString(record.label) || safeString(record.floor) || 'Map Layer';
	const id = normalizeKey(record.id || name || imageUrl);
	if (!id) return null;
	return {
		id,
		name,
		floor: safeString(record.floor),
		imageUrl,
		rotation: normalizeRotationDegrees(record.rotation || record.mapRotation || record.map_rotation) ?? 0
	};
}

function normalizePoiRecord(raw: unknown): PlacePoiRecord | null {
	if (!raw || typeof raw !== 'object') return null;
	const record = raw as Record<string, unknown>;
	const name = safeString(record.name) || safeString(record.label) || '';
	const id = normalizeKey(record.id || name);
	const x = clampNormalizedCoordinate(record.x);
	const y = clampNormalizedCoordinate(record.y);
	if (!id || !name || x == null || y == null) return null;
	return {
		id,
		name,
		x,
		y,
		layerId: safeString(record.layerId || record.layer_id) || null,
		description: safeString(record.description),
		renderMode: normalizePoiRenderMode(record.renderMode || record.render_mode),
		themePreset:
			safeString(record.themePreset || record.theme_preset) != null
				? normalizePoiThemePreset(record.themePreset || record.theme_preset)
				: null,
		iconPreset:
			safeString(record.iconPreset || record.icon_preset) != null
				? normalizePoiIconPreset(record.iconPreset || record.icon_preset)
				: null,
		iconGlyph: safeString(record.iconGlyph || record.icon || record.icon_glyph) || null,
		iconColor: safeString(record.iconColor || record.icon_color) || null
	};
}

function normalizePlaceRecord(raw: unknown): PlaceRecord | null {
	if (!raw || typeof raw !== 'object') return null;
	const record = raw as Record<string, unknown>;
	const slug = normalizeKey(record.slug || record.id || record.name);
	const name = safeString(record.name) || safeString(record.displayName) || slug;
	if (!slug || !name) return null;
	const mapRotation = normalizeRotationDegrees(record.mapRotation || record.map_rotation) ?? 0;
	const rawMapLayers = Array.isArray(record.mapLayers)
		? record.mapLayers
		: Array.isArray(record.map_layers)
			? record.map_layers
			: [];
	const normalizedLayers = Array.from(
		new Map(
			rawMapLayers
				.map((entry) => normalizeMapLayerRecord(entry))
				.filter((entry): entry is PlaceMapLayerRecord => Boolean(entry))
				.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
				.map((entry) => [entry.id, entry] as const)
		).values()
	);
	const fallbackMapImageUrl = safeString(record.mapImageUrl || record.map_image_url) || null;
	const mapLayers =
		normalizedLayers.length > 0
			? normalizedLayers
			: fallbackMapImageUrl
				? [
						{
							id: 'main-map',
							name: safeString(record.floor) ? `Floor ${safeString(record.floor)}` : 'Main Map',
							floor: safeString(record.floor),
							imageUrl: fallbackMapImageUrl,
							rotation: mapRotation
						}
					]
				: [];
	return {
		id: normalizeKey(record.id || slug),
		slug,
		name,
		aliases: Array.from(new Set(safeStringList(record.aliases).map((entry) => normalizeKey(entry)).filter(Boolean))),
		building: safeString(record.building),
		floor: safeString(record.floor),
		lat: safeCoordinate(record.lat),
		lon: safeCoordinate(record.lon),
		description: safeString(record.description),
		modelUrl: safeString(record.modelUrl || record.model_url) || null,
		mapImageUrl: mapLayers[0]?.imageUrl || fallbackMapImageUrl,
		mapRotation: mapLayers[0]?.rotation ?? mapRotation,
		poiThemePreset: normalizePoiThemePreset(record.poiThemePreset || record.poi_theme_preset),
		mapLayers,
		pois: Array.from(
			new Map(
				(Array.isArray(record.pois) ? record.pois : [])
					.map((entry) => normalizePoiRecord(entry))
					.filter((entry): entry is PlacePoiRecord => Boolean(entry))
					.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
					.map((entry) => [entry.id, entry] as const)
			).values()
		),
		tags: Array.from(new Set(safeStringList(record.tags).map((entry) => entry.toLowerCase())))
	};
}

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
			const normalized = rows
				.map((entry) => normalizePlaceRecord(entry))
				.filter((entry): entry is PlaceRecord => Boolean(entry));
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

export function getPlaceById(placeId: string): PlaceRecord | undefined {
	const normalized = normalizeKey(placeId);
	return get(placeRegistry).find((place) => place.id === normalized || place.slug === normalized);
}

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

export function buildPlaceDisplayText(place: Pick<PlaceRecord, 'slug'>): string {
	return `@${place.slug}`;
}

function getPlaceSearchTerms(place: PlaceRecord): string[] {
	return [place.slug, place.id, place.name, ...place.aliases, ...place.tags]
		.map((entry) => entry.toLowerCase())
		.filter(Boolean);
}

export function searchPlaces(query: string, limit = 8): PlaceRecord[] {
	const normalizedQuery = normalizeKey(query);
	if (!normalizedQuery) {
		return get(placeRegistry)
			.slice()
			.sort((a, b) => a.name.localeCompare(b.name))
			.slice(0, limit);
	}
	return get(placeRegistry)
		.filter((place) => getPlaceSearchTerms(place).some((term) => term.startsWith(normalizedQuery) || term.includes(normalizedQuery)))
		.sort((a, b) => a.name.localeCompare(b.name))
		.slice(0, limit);
}

export function buildPlaceSuggestionDetail(place: PlaceRecord): string {
	const parts = [place.name];
	if (place.building) parts.push(place.building);
	if (place.floor) parts.push(`Floor ${place.floor}`);
	return parts.join(' | ');
}

function buildPoiMentionValue(place: PlaceRecord, poi: PlacePoiRecord): string {
	return `${place.slug}/${normalizeKey(poi.id || poi.name || 'poi')}`;
}

function buildPoiSuggestionDetail(place: PlaceRecord, poi: PlacePoiRecord): string {
	const parts = [poi.name, place.name];
	const poiLayer =
		(poi.layerId && place.mapLayers.find((layer) => layer.id === poi.layerId)?.name) ||
		(poi.layerId && place.mapLayers.find((layer) => layer.id === poi.layerId)?.floor
			? `Floor ${place.mapLayers.find((layer) => layer.id === poi.layerId)?.floor}`
			: null);
	if (poiLayer) parts.push(poiLayer);
	return parts.join(' | ');
}

function matchesPlaceExact(place: PlaceRecord, needle: string): boolean {
	return getPlaceSearchTerms(place).map((entry) => normalizeKey(entry)).includes(needle);
}

function matchesPoiExact(poi: PlacePoiRecord, needle: string): boolean {
	return [poi.id, poi.name, poi.description || '', poi.layerId || '']
		.map((entry) => normalizeKey(entry))
		.filter(Boolean)
		.includes(needle);
}

export function buildPlaceDirectionsLabel(target: PlaceResolution): string {
	if (target.poi) {
		return `@${buildPoiMentionValue(target.place, target.poi)}`;
	}
	return buildPlaceDisplayText(target.place);
}

export function resolvePlaceReference(query: string): PlaceResolution | null {
	const normalizedQuery = normalizeKey(query.replace(/^@+/, ''));
	if (!normalizedQuery) return null;

	const slashIndex = normalizedQuery.indexOf('/');
	const placeQuery = slashIndex >= 0 ? normalizedQuery.slice(0, slashIndex) : normalizedQuery;
	const poiQuery = slashIndex >= 0 ? normalizedQuery.slice(slashIndex + 1) : '';
	const places = get(placeRegistry);
	const matchedPlace =
		places.find((place) => matchesPlaceExact(place, placeQuery)) ||
		places.find((place) => place.slug === placeQuery || place.id === placeQuery);
	if (!matchedPlace) return null;
	if (!poiQuery) return { place: matchedPlace };

	const matchedPoi =
		matchedPlace.pois.find((poi) => normalizeKey(poi.id || poi.name || '') === poiQuery) ||
		matchedPlace.pois.find((poi) => matchesPoiExact(poi, poiQuery)) ||
		matchedPlace.pois.find((poi) => buildPoiMentionValue(matchedPlace, poi) === normalizedQuery);

	return matchedPoi ? { place: matchedPlace, poi: matchedPoi } : { place: matchedPlace };
}

export function searchPlaceMentionSuggestions(query: string, limit = 8): PlaceMentionSuggestion[] {
	const normalizedQuery = normalizeKey(query);
	if (!normalizedQuery) {
		return searchPlaces('', limit).map((place) => ({
			key: `place-${place.id}`,
			label: `@${place.slug}`,
			value: place.slug,
			detail: buildPlaceSuggestionDetail(place),
			place
		}));
	}

	const slashIndex = normalizedQuery.indexOf('/');
	const placeQuery = slashIndex >= 0 ? normalizedQuery.slice(0, slashIndex) : normalizedQuery;
	const poiQuery = slashIndex >= 0 ? normalizedQuery.slice(slashIndex + 1) : '';
	const basePlaces = slashIndex >= 0 ? searchPlaces(placeQuery, Math.max(limit, 12)) : searchPlaces(normalizedQuery, limit);

	const suggestions: PlaceMentionSuggestion[] = basePlaces.map((place) => ({
		key: `place-${place.id}`,
		label: `@${place.slug}`,
		value: place.slug,
		detail: buildPlaceSuggestionDetail(place),
		place
	}));

	const poiSuggestions = get(placeRegistry)
		.flatMap((place) =>
			place.pois
				.filter((poi) => {
					const poiNeedle = [poi.id, poi.name, poi.description || '', poi.layerId || '']
						.join(' ')
						.toLowerCase();
					if (slashIndex >= 0) {
						const placeMatches = place.slug.includes(placeQuery) || place.id.includes(placeQuery);
						const poiMatches =
							!poiQuery ||
							poiNeedle.includes(poiQuery) ||
							buildPoiMentionValue(place, poi).toLowerCase().includes(normalizedQuery);
						return placeMatches && poiMatches;
					}
					return poiNeedle.includes(normalizedQuery) || buildPoiMentionValue(place, poi).toLowerCase().includes(normalizedQuery);
				})
				.map((poi) => ({
					key: `poi-${place.id}-${poi.id}`,
					label: `@${buildPoiMentionValue(place, poi)}`,
					value: buildPoiMentionValue(place, poi),
					detail: buildPoiSuggestionDetail(place, poi),
					place,
					poi
				}))
		)
		.slice(0, limit);

	const deduped = new Map<string, PlaceMentionSuggestion>();
	for (const entry of [...suggestions, ...poiSuggestions]) {
		if (!deduped.has(entry.key)) {
			deduped.set(entry.key, entry);
		}
		if (deduped.size >= limit) break;
	}

	return Array.from(deduped.values()).slice(0, limit);
}

export function buildPlaceMessageEntity(
	place: PlaceRecord,
	start: number,
	end: number,
	options: { poi?: PlacePoiRecord | null; displayText?: string } = {}
): PlaceMessageEntity {
	return {
		kind: 'place',
		start,
		end,
		placeId: place.id,
		layerId: options.poi?.layerId || undefined,
		poiId: options.poi?.id || undefined,
		label: options.poi?.name || place.name,
		displayText: options.displayText || (options.poi ? `@${buildPoiMentionValue(place, options.poi)}` : buildPlaceDisplayText(place))
	};
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

function splitCsvInput(value: string): string[] {
	return value
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
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
		themePreset: draft.themePreset ? normalizePoiThemePreset(draft.themePreset) : undefined,
		iconPreset: normalizePoiIconPreset(draft.iconPreset),
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
		poiThemePreset: normalizePoiThemePreset(draft.poiThemePreset),
		mapImageUrl: (primaryLayer?.imageUrl as string | undefined) || draft.mapImageUrl.trim() || undefined,
		pois: draft.pois
			.map((poi) => serializePoiDraft(poi))
			.filter((poi): poi is Record<string, unknown> => Boolean(poi)),
		tags: splitCsvInput(draft.tags),
		mapLayers
	};

	const lat = safeCoordinate(draft.lat);
	const lon = safeCoordinate(draft.lon);
	const mapRotation =
		(typeof primaryLayer?.rotation === 'number' ? primaryLayer.rotation : null) ??
		normalizeRotationDegrees(draft.mapRotation);
	if (lat != null) payload.lat = lat;
	if (lon != null) payload.lon = lon;
	if (mapRotation != null) payload.mapRotation = mapRotation;
	return payload;
}

function normalizeRegistryPayload(rows: unknown): PlaceRecord[] {
	return (Array.isArray(rows) ? rows : [])
		.map((entry) => normalizePlaceRecord(entry))
		.filter((entry): entry is PlaceRecord => Boolean(entry));
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

export function reconcileMessageEntities(
	previousText: string,
	nextText: string,
	entities: MessageEntity[]
): MessageEntity[] {
	if (previousText === nextText || entities.length === 0) {
		return entities.map((entity) => ({ ...entity }));
	}

	let prefix = 0;
	const maxPrefix = Math.min(previousText.length, nextText.length);
	while (prefix < maxPrefix && previousText[prefix] === nextText[prefix]) {
		prefix += 1;
	}

	let previousSuffix = previousText.length;
	let nextSuffix = nextText.length;
	while (
		previousSuffix > prefix &&
		nextSuffix > prefix &&
		previousText[previousSuffix - 1] === nextText[nextSuffix - 1]
	) {
		previousSuffix -= 1;
		nextSuffix -= 1;
	}

	const delta = nextText.length - previousText.length;
	return entities
		.filter((entity) => entity.end <= prefix || entity.start >= previousSuffix)
		.map((entity) => {
			if (entity.end <= prefix) {
				return { ...entity };
			}
			return {
				...entity,
				start: entity.start + delta,
				end: entity.end + delta
			};
		});
}

export function rebaseMessageEntitiesForText(text: string, entities: MessageEntity[]): MessageEntity[] {
	if (!text || entities.length === 0) return [];
	const sorted = [...entities].sort((a, b) => a.start - b.start || a.end - b.end);
	let searchStart = 0;
	const loweredText = text.toLowerCase();
	const rebased: MessageEntity[] = [];

	for (const entity of sorted) {
		const token = entity.displayText || text.slice(entity.start, entity.end);
		if (!token) continue;
		const nextIndex = loweredText.indexOf(token.toLowerCase(), searchStart);
		if (nextIndex < 0) continue;
		rebased.push({
			...entity,
			start: nextIndex,
			end: nextIndex + token.length,
			displayText: token
		});
		searchStart = nextIndex + token.length;
	}

	return rebased;
}

export function splitEntitiesForChunks(
	fullText: string,
	chunks: string[],
	entities: MessageEntity[]
): MessageEntity[][] {
	if (chunks.length === 0) return [];
	let searchStart = 0;
	return chunks.map((chunk) => {
		const chunkStart = fullText.indexOf(chunk, searchStart);
		if (chunkStart < 0) return [];
		const chunkEnd = chunkStart + chunk.length;
		searchStart = chunkEnd;
		return entities
			.filter((entity) => entity.start >= chunkStart && entity.end <= chunkEnd)
			.map((entity) => ({
				...entity,
				start: entity.start - chunkStart,
				end: entity.end - chunkStart
			}));
	});
}
