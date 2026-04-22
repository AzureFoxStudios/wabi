import type { IncomingMessage, ServerResponse } from 'http';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { basename, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { DATA_DIR, UPLOADS_DIR } from '../constants.js';
import {
	isInvalidJsonBodyError,
	isRequestBodyTooLargeError,
	readJsonObjectBody
} from '../utils/requestBodies.js';

export interface PlaceRecord {
	id: string;
	name: string;
	aliases: string[];
	description?: string;
	building?: string;
	floor?: string;
	lat?: number;
	lon?: number;
	modelUrl?: string;
	mapImageUrl?: string;
	mapRotation?: number;
	poiThemePreset?: PlacePoiThemePreset;
	mapLayers?: PlaceMapLayerRecord[];
	pois?: PlacePoiRecord[];
	tags?: string[];
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
	layerId?: string;
	description?: string;
	renderMode: PlacePoiRenderMode;
	themePreset?: PlacePoiThemePreset;
	iconPreset?: PlacePoiIconPreset;
	iconGlyph?: string;
	iconColor?: string;
}

type RawPlaceRecord = Partial<PlaceRecord> & {
	id?: unknown;
	name?: unknown;
	aliases?: unknown;
	description?: unknown;
	building?: unknown;
	floor?: unknown;
	lat?: unknown;
	lon?: unknown;
	modelUrl?: unknown;
	mapImageUrl?: unknown;
	mapRotation?: unknown;
	poiThemePreset?: unknown;
	poi_theme_preset?: unknown;
	mapLayers?: unknown;
	pois?: unknown;
	tags?: unknown;
};

const bundledRegistryPath = fileURLToPath(new URL('../config/place-registry.json', import.meta.url));
const dataRegistryPath = join(DATA_DIR, 'place-registry.json');
type PlaceRegistrySource = 'data' | 'bundled' | 'empty';
const MAX_PLACE_BODY_BYTES = Math.max(
	1024,
	Math.min(512 * 1024, Number(process.env.PLACE_MAX_BODY_BYTES || 64 * 1024))
);

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
	res.writeHead(statusCode, {
		'Content-Type': 'application/json',
		'Cache-Control': 'no-store'
	});
	res.end(JSON.stringify(payload));
}

function slugifyPlaceId(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function normalizeStringArray(input: unknown): string[] {
	if (!Array.isArray(input)) return [];
	return Array.from(
		new Set(
			input
				.map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
				.filter(Boolean)
		)
	);
}

function toFiniteNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function clampNormalizedCoordinate(value: unknown): number | undefined {
	const parsed = toFiniteNumber(value);
	if (parsed == null) return undefined;
	return Math.max(0, Math.min(1, parsed));
}

function normalizeRotationDegrees(value: unknown): number | undefined {
	const parsed = toFiniteNumber(value);
	if (parsed == null) return undefined;
	const normalized = ((parsed % 360) + 360) % 360;
	return Number(normalized.toFixed(3));
}

function normalizePoiRenderMode(value: unknown): PlacePoiRenderMode {
	if (value === 'pin') return 'pin';
	if (value === 'both') return 'both';
	return 'label';
}

function normalizePoiThemePreset(value: unknown): PlacePoiThemePreset {
	if (value === 'campus' || value === 'quest' || value === 'terminal') return value;
	return 'classic';
}

function normalizePoiIconPreset(value: unknown): PlacePoiIconPreset {
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

function normalizeMapLayer(input: unknown): PlaceMapLayerRecord | null {
	if (!input || typeof input !== 'object') return null;
	const record = input as Record<string, unknown>;
	const imageUrl =
		(typeof record.imageUrl === 'string' && record.imageUrl.trim()) ||
		(typeof record.image_url === 'string' && record.image_url.trim()) ||
		(typeof record.mapImageUrl === 'string' && record.mapImageUrl.trim()) ||
		(typeof record.map_image_url === 'string' && record.map_image_url.trim()) ||
		'';
	if (!imageUrl) return null;
	const name =
		(typeof record.name === 'string' && record.name.trim()) ||
		(typeof record.label === 'string' && record.label.trim()) ||
		(typeof record.floor === 'string' && record.floor.trim()) ||
		'Map Layer';
	const id = slugifyPlaceId((typeof record.id === 'string' && record.id) || name);
	if (!id) return null;
	return {
		id,
		name,
		floor: typeof record.floor === 'string' && record.floor.trim() ? record.floor.trim() : undefined,
		imageUrl,
		rotation: normalizeRotationDegrees(record.rotation || record.mapRotation || record.map_rotation) ?? 0
	};
}

function normalizePlacePoi(input: unknown): PlacePoiRecord | null {
	if (!input || typeof input !== 'object') return null;
	const record = input as Record<string, unknown>;
	const name = typeof record.name === 'string' ? record.name.trim() : '';
	const idSource = typeof record.id === 'string' ? record.id : name;
	const id = slugifyPlaceId(idSource);
	const x = clampNormalizedCoordinate(record.x);
	const y = clampNormalizedCoordinate(record.y);
	if (!id || !name || x == null || y == null) return null;
	const normalized: PlacePoiRecord = {
		id,
		name,
		x,
		y,
		layerId:
			typeof record.layerId === 'string' && record.layerId.trim()
				? slugifyPlaceId(record.layerId)
				: typeof record.layer_id === 'string' && record.layer_id.trim()
					? slugifyPlaceId(record.layer_id)
					: undefined,
		renderMode: normalizePoiRenderMode(record.renderMode || record.render_mode),
		themePreset:
			(typeof record.themePreset === 'string' && record.themePreset.trim()) ||
			(typeof record.theme_preset === 'string' && record.theme_preset.trim())
				? normalizePoiThemePreset(record.themePreset || record.theme_preset)
				: undefined,
		iconPreset:
			(typeof record.iconPreset === 'string' && record.iconPreset.trim()) ||
			(typeof record.icon_preset === 'string' && record.icon_preset.trim())
				? normalizePoiIconPreset(record.iconPreset || record.icon_preset)
				: undefined
	};
	if (typeof record.description === 'string' && record.description.trim()) {
		normalized.description = record.description.trim();
	}
	if (typeof record.iconGlyph === 'string' && record.iconGlyph.trim()) {
		normalized.iconGlyph = record.iconGlyph.trim();
	} else if (typeof record.icon === 'string' && record.icon.trim()) {
		normalized.iconGlyph = record.icon.trim();
	}
	if (typeof record.iconColor === 'string' && record.iconColor.trim()) {
		normalized.iconColor = record.iconColor.trim();
	} else if (typeof record.icon_color === 'string' && record.icon_color.trim()) {
		normalized.iconColor = record.icon_color.trim();
	}
	return normalized;
}

function normalizePlaceRecord(input: RawPlaceRecord): PlaceRecord | null {
	const name = typeof input.name === 'string' ? input.name.trim() : '';
	const idSource = typeof input.id === 'string' ? input.id : name;
	const id = slugifyPlaceId(idSource);
	if (!id || !name) return null;

	const aliases = normalizeStringArray(input.aliases)
		.map((alias) => alias.replace(/^@+/, '').trim())
		.filter(Boolean);
	const topLevelRotation = normalizeRotationDegrees(input.mapRotation) ?? 0;
	const explicitLayers = Array.from(
		new Map(
			(Array.isArray(input.mapLayers) ? input.mapLayers : [])
				.map((entry) => normalizeMapLayer(entry))
				.filter((entry): entry is PlaceMapLayerRecord => Boolean(entry))
				.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
				.map((entry) => [entry.id, entry] as const)
		).values()
	);
	const legacyMapImageUrl = typeof input.mapImageUrl === 'string' && input.mapImageUrl.trim() ? input.mapImageUrl.trim() : undefined;
	const mapLayers =
		explicitLayers.length > 0
			? explicitLayers
			: legacyMapImageUrl
				? [
						{
							id: 'main-map',
							name: typeof input.floor === 'string' && input.floor.trim() ? `Floor ${input.floor.trim()}` : 'Main Map',
							floor: typeof input.floor === 'string' && input.floor.trim() ? input.floor.trim() : undefined,
							imageUrl: legacyMapImageUrl,
							rotation: topLevelRotation
						}
					]
				: [];

	const normalized: PlaceRecord = {
		id,
		name,
		aliases: Array.from(new Set([id, ...aliases])),
		mapRotation: mapLayers[0]?.rotation ?? topLevelRotation,
		poiThemePreset: normalizePoiThemePreset(input.poiThemePreset ?? input.poi_theme_preset),
		mapLayers,
		pois: Array.from(
			new Map(
				(Array.isArray(input.pois) ? input.pois : [])
					.map((entry) => normalizePlacePoi(entry))
					.filter((entry): entry is PlacePoiRecord => Boolean(entry))
					.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
					.map((entry) => [entry.id, entry] as const)
			).values()
		)
	};

	if (typeof input.description === 'string' && input.description.trim()) {
		normalized.description = input.description.trim();
	}
	if (typeof input.building === 'string' && input.building.trim()) {
		normalized.building = input.building.trim();
	}
	if (typeof input.floor === 'string' && input.floor.trim()) {
		normalized.floor = input.floor.trim();
	}
	const lat = toFiniteNumber(input.lat);
	const lon = toFiniteNumber(input.lon);
	if (lat != null) normalized.lat = lat;
	if (lon != null) normalized.lon = lon;
	if (typeof input.modelUrl === 'string' && input.modelUrl.trim()) {
		normalized.modelUrl = input.modelUrl.trim();
	}
	if (mapLayers[0]?.imageUrl) {
		normalized.mapImageUrl = mapLayers[0].imageUrl;
	} else if (legacyMapImageUrl) {
		normalized.mapImageUrl = legacyMapImageUrl;
	}
	const tags = normalizeStringArray(input.tags);
	if (tags.length > 0) normalized.tags = tags;
	return normalized;
}

function sortPlaces(places: PlaceRecord[]): PlaceRecord[] {
	return places.slice().sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function loadPlaceRegistryFile(): { places: PlaceRecord[]; source: PlaceRegistrySource } {
	const candidates: Array<{ path: string; source: 'data' | 'bundled' }> = [
		{ path: dataRegistryPath, source: 'data' },
		{ path: bundledRegistryPath, source: 'bundled' }
	];

	for (const candidate of candidates) {
		if (!existsSync(candidate.path)) continue;
		try {
			const raw = JSON.parse(readFileSync(candidate.path, 'utf8')) as unknown;
			if (!Array.isArray(raw)) continue;
			const places = raw
				.map((entry) => normalizePlaceRecord((entry || {}) as RawPlaceRecord))
				.filter((entry): entry is PlaceRecord => Boolean(entry));
			return { places: sortPlaces(places), source: candidate.source };
		} catch (error) {
			console.error(`[Places] Failed to load registry from ${candidate.path}:`, error);
		}
	}

	return { places: [], source: 'empty' };
}

function savePlaceRegistryFile(places: PlaceRecord[]): void {
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(dataRegistryPath, `${JSON.stringify(sortPlaces(places), null, 2)}\n`, 'utf8');
}

function extractPayloadPlace(input: unknown): RawPlaceRecord {
	if (!input || typeof input !== 'object') return {};
	const root = input as Record<string, unknown>;
	if (root.place && typeof root.place === 'object') {
		return root.place as RawPlaceRecord;
	}
	return root as RawPlaceRecord;
}

function getUploadFileIdFromUrl(fileUrl: string | undefined): string | null {
	if (typeof fileUrl !== 'string' || !fileUrl.startsWith('/uploads/')) return null;
	const rawSegment = fileUrl.slice('/uploads/'.length).split(/[?#]/, 1)[0] || '';
	const safeId = basename(rawSegment);
	if (!safeId || safeId !== rawSegment) return null;
	return safeId;
}

function deleteUploadIfLocal(fileUrl: string | undefined): void {
	const fileId = getUploadFileIdFromUrl(fileUrl);
	if (!fileId) return;
	try {
		const uploadsRoot = resolve(UPLOADS_DIR);
		const candidate = resolve(uploadsRoot, fileId);
		if (candidate !== uploadsRoot && !candidate.startsWith(`${uploadsRoot}${sep}`)) {
			return;
		}
		if (existsSync(candidate)) {
			unlinkSync(candidate);
		}
	} catch (error) {
		console.warn('[Places] Failed to delete local map upload:', error);
	}
}

function getPlaceUploadUrls(place: PlaceRecord | null | undefined): string[] {
	if (!place) return [];
	const urls = new Set<string>();
	if (place.mapImageUrl) urls.add(place.mapImageUrl);
	for (const layer of place.mapLayers || []) {
		if (layer.imageUrl) urls.add(layer.imageUrl);
	}
	return Array.from(urls);
}

function upsertPlaceRecord(existingPlaces: PlaceRecord[], place: PlaceRecord): PlaceRecord[] {
	const nextPlaces = existingPlaces.slice();
	const existingIndex = nextPlaces.findIndex((entry) => entry.id === place.id);
	if (existingIndex >= 0) {
		const existing = nextPlaces[existingIndex];
		const nextUrls = new Set(getPlaceUploadUrls(place));
		for (const fileUrl of getPlaceUploadUrls(existing)) {
			if (!nextUrls.has(fileUrl)) {
				deleteUploadIfLocal(fileUrl);
			}
		}
		nextPlaces[existingIndex] = place;
		return sortPlaces(nextPlaces);
	}
	nextPlaces.push(place);
	return sortPlaces(nextPlaces);
}

function removePlaceRecord(existingPlaces: PlaceRecord[], placeId: string): { places: PlaceRecord[]; deleted: PlaceRecord | null } {
	const normalizedId = slugifyPlaceId(placeId);
	const existingIndex = existingPlaces.findIndex((entry) => entry.id === normalizedId);
	if (existingIndex < 0) {
		return { places: sortPlaces(existingPlaces), deleted: null };
	}
	const nextPlaces = existingPlaces.slice();
	const [deleted] = nextPlaces.splice(existingIndex, 1);
	for (const fileUrl of getPlaceUploadUrls(deleted)) {
		deleteUploadIfLocal(fileUrl);
	}
	return { places: sortPlaces(nextPlaces), deleted: deleted || null };
}

export function getPlaceRegistry(): { places: PlaceRecord[]; source: PlaceRegistrySource } {
	return loadPlaceRegistryFile();
}

export function isKnownPlaceId(placeId: string): boolean {
	const normalized = slugifyPlaceId(placeId);
	if (!normalized) return false;
	return getPlaceRegistry().places.some((place) => place.id === normalized);
}

export function getPlaceRecordById(placeId: string): PlaceRecord | null {
	const normalized = slugifyPlaceId(placeId);
	if (!normalized) return null;
	return getPlaceRegistry().places.find((place) => place.id === normalized) || null;
}

export async function handleGetPlaces(_req: IncomingMessage, res: ServerResponse): Promise<void> {
	const registry = getPlaceRegistry();
	sendJson(res, 200, {
		experimental: true,
		source: registry.source,
		places: registry.places
	});
}

export async function handleUpsertPlace(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const body = await readJsonObjectBody(req, MAX_PLACE_BODY_BYTES);
		const normalized = normalizePlaceRecord(extractPayloadPlace(body));
		if (!normalized) {
			sendJson(res, 400, { success: false, error: 'Invalid place payload' });
			return;
		}

		const registry = getPlaceRegistry();
		const places = upsertPlaceRecord(registry.places, normalized);
		savePlaceRegistryFile(places);
		sendJson(res, 200, {
			success: true,
			experimental: true,
			source: 'data',
			place: normalized,
			places
		});
	} catch (error) {
		if (isRequestBodyTooLargeError(error)) {
			sendJson(res, 413, { success: false, error: 'Place payload too large' });
			return;
		}
		if (isInvalidJsonBodyError(error)) {
			sendJson(res, 400, { success: false, error: 'Invalid JSON in place payload' });
			return;
		}
		console.error('[Places] Failed to save place:', error);
		sendJson(res, 500, { success: false, error: 'Failed to save place' });
	}
}

export async function handleDeletePlace(_req: IncomingMessage, res: ServerResponse, placeId: string): Promise<void> {
	try {
		const registry = getPlaceRegistry();
		const result = removePlaceRecord(registry.places, placeId);
		if (!result.deleted) {
			sendJson(res, 404, { success: false, error: 'Place not found' });
			return;
		}
		savePlaceRegistryFile(result.places);
		sendJson(res, 200, {
			success: true,
			experimental: true,
			source: 'data',
			deletedPlaceId: result.deleted.id,
			places: result.places
		});
	} catch (error) {
		console.error('[Places] Failed to delete place:', error);
		sendJson(res, 500, { success: false, error: 'Failed to delete place' });
	}
}
