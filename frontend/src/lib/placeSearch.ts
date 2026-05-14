import { get } from 'svelte/store';
import { placeRegistry } from './placeStore';
import type { PlaceRecord, PlacePoiRecord } from './placeRegistry';
import { normalizeKey } from './placeNormalization';

function getPlaceSearchTerms(place: PlaceRecord): string[] {
	return [place.slug, place.id, place.name, ...place.aliases, ...place.tags]
		.map((entry) => entry.toLowerCase())
		.filter(Boolean);
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

export function getPlaceById(placeId: string): PlaceRecord | undefined {
	const normalized = normalizeKey(placeId);
	return get(placeRegistry).find((place) => place.id === normalized || place.slug === normalized);
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

export function buildPlaceDisplayText(place: Pick<PlaceRecord, 'slug'>): string {
	return `@${place.slug}`;
}

export function buildPlaceSuggestionDetail(place: PlaceRecord): string {
	const parts = [place.name];
	if (place.building) parts.push(place.building);
	if (place.floor) parts.push(`Floor ${place.floor}`);
	return parts.join(' | ');
}

export function buildPlaceDirectionsLabel(target: { place: PlaceRecord; poi?: PlacePoiRecord }): string {
	if (target.poi) {
		return `@${normalizeKey(target.place.slug)}/${normalizeKey(target.poi.id || target.poi.name || 'poi')}`;
	}
	return buildPlaceDisplayText(target.place);
}

export function resolvePlaceReference(query: string): { place: PlaceRecord; poi?: PlacePoiRecord } | null {
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
		matchedPlace.pois.find((poi) => matchesPoiExact(poi, poiQuery));

	return matchedPoi ? { place: matchedPlace, poi: matchedPoi } : { place: matchedPlace };
}
