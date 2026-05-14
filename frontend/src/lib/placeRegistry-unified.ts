/**
 * placeRegistry.ts (unified re-export)
 * Maintains 100% backward compatibility
 *
 * Re-exports from:
 * - place-search.ts: Search, lookup, and place management
 * - place-mentions.ts: Mention extraction and entity handling
 */

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type {
	PlaceRecord,
	PlacePoiRenderMode,
	PlacePoiThemePreset,
	PlacePoiIconPreset,
	PlaceMapLayerRecord,
	PlacePoiRecord,
	PlaceDraft,
	PlaceMapLayerDraft,
	PlacePoiDraft,
	PlaceMessageEntity,
	MessageEntity,
	PlaceMentionSuggestion,
	PlaceResolution
} from './placeRegistry';

// ============================================================================
// STORE EXPORTS (place-search.ts)
// ============================================================================

export { placeRegistry, placeRegistryLoaded, placeRegistryLoading } from './place-search';

// ============================================================================
// PLACE SEARCH FUNCTIONS
// ============================================================================

export {
	loadPlaceRegistry,
	getPlaceById,
	resolvePlaceAssetUrl,
	buildPlaceDisplayText,
	searchPlaces,
	buildPlaceSuggestionDetail,
	buildPlaceDirectionsLabel,
	resolvePlaceReference
} from './place-search';

// ============================================================================
// PLACE DRAFT FUNCTIONS
// ============================================================================

export {
	createEmptyPlaceDraft,
	createPlaceDraft,
	createEmptyPoiDraft,
	createEmptyMapLayerDraft,
	serializePlaceDraft,
	savePlaceDraft,
	deletePlace
} from './place-search';

// ============================================================================
// PLACE MENTION FUNCTIONS
// ============================================================================

export {
	searchPlaceMentionSuggestions,
	buildPlaceMessageEntity,
	reconcileMessageEntities,
	rebaseMessageEntitiesForText,
	splitEntitiesForChunks
} from './place-mentions';

// ============================================================================
// NORMALIZATION EXPORTS
// ============================================================================

// Re-export from original if they exist, otherwise stub them
export { normalizePoiThemePreset, normalizePoiIconPreset } from './placeRegistry';
