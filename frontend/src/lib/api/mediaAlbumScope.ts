// MediaAlbumScopeType - Extracted from api.ts to eliminate duplication
export type MediaAlbumScopeType = 'channel' | 'dm';

// Re-export the albums API functions to maintain backward compatibility
export * from './albums';