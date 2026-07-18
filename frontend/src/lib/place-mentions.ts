import { get } from 'svelte/store';
import type {
	PlaceRecord,
	PlacePoiRecord,
	PlaceMessageEntity,
	MessageEntity,
	PlaceMentionSuggestion
} from './placeRegistry';
import { placeRegistry } from './placeStore';
import { searchPlaces } from './placeSearch';

function normalizeKey(value: unknown): string {
	return String(value || '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '');
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

function matchesPoiExact(poi: PlacePoiRecord, needle: string): boolean {
	return [poi.id, poi.name, poi.description || '', poi.layerId || '']
		.map((entry) => normalizeKey(entry))
		.filter(Boolean)
		.includes(needle);
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
		targetId: place.id,
		layerId: options.poi?.layerId || undefined,
		poiId: options.poi?.id || undefined,
		label: options.poi?.name || place.name,
		displayText: options.displayText || (options.poi ? `@${buildPoiMentionValue(place, options.poi)}` : `@${place.slug}`)
	};
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

// Helper for buildPlaceSuggestionDetail (used by searchPlaceMentionSuggestions)
function buildPlaceSuggestionDetail(place: PlaceRecord): string {
	const parts = [place.name];
	if (place.building) parts.push(place.building);
	if (place.floor) parts.push(`Floor ${place.floor}`);
	return parts.join(' | ');
}
