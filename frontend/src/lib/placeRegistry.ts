/**
 * placeRegistry.ts (unified re-export)
 * Maintains 100% backward compatibility
 *
 * Re-exports from:
 * - placeStore.ts: Store definitions and registry loading
 * - placeSearch.ts: Search, lookup, and reference resolution
 * - placeDraft.ts: Draft creation, serialization, and API operations
 * - placeNormalization.ts: Normalization utilities
 * - place-mentions.ts: Mention extraction and entity handling
 */

// ============================================================================
// TYPE DEFINITIONS (from original placeRegistry.ts)
// ============================================================================

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
	targetId: string;
	layerId?: string;
	poiId?: string;
	label: string;
	displayText?: string;
}

// Single source of truth: the protocol MessageEntity (regenerated from Rust wabi-core).
// PlaceMessageEntity above is a place-only alias kept for callers that build place refs.
export type { MessageEntity } from '$lib/socket-types';

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

// ============================================================================
// STORE & FUNCTION EXPORTS (placeStore.ts)
// ============================================================================

export {
	placeRegistry,
	placeRegistryLoaded,
	placeRegistryLoading,
	loadPlaceRegistry
} from './placeStore';

// ============================================================================
// SEARCH & LOOKUP EXPORTS (placeSearch.ts)
// ============================================================================

export {
	getPlaceById,
	searchPlaces,
	buildPlaceDisplayText,
	buildPlaceSuggestionDetail,
	buildPlaceDirectionsLabel,
	resolvePlaceReference
} from './placeSearch';

// ============================================================================
// DRAFT & ASSET EXPORTS (placeDraft.ts)
// ============================================================================

export {
	resolvePlaceAssetUrl,
	createEmptyPlaceDraft,
	createPlaceDraft,
	createEmptyPoiDraft,
	createEmptyMapLayerDraft,
	serializePlaceDraft,
	savePlaceDraft,
	deletePlace,
	draftPoiToRecord,
	draftMapLayerToRecord,
	buildDraftPreview,
	buildDraftValidationIssues
} from './placeDraft';

// ============================================================================
// NORMALIZATION EXPORTS (placeNormalization.ts)
// ============================================================================

export {
	normalizeKey,
	normalizePoiThemePreset,
	normalizePoiIconPreset
} from './placeNormalization';

// ============================================================================
// MENTION & ENTITY EXPORTS (place-mentions.ts)
// ============================================================================

export {
	searchPlaceMentionSuggestions,
	buildPlaceMessageEntity,
	reconcileMessageEntities,
	rebaseMessageEntitiesForText,
	splitEntitiesForChunks
} from './place-mentions';
export { splitMessageForSending } from './composerEnhancements';
