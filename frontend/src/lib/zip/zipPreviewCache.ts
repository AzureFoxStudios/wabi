import type { ZipPreviewMetadata as ZipPreviewCacheValue } from '$lib/zip/zipPreview';

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ITEMS = 120;

interface ZipPreviewCacheEntry {
	metadata: ZipPreviewCacheValue;
	cachedAt: number;
}

const previewCache = new Map<string, ZipPreviewCacheEntry>();

export function readPreviewCache(key: string): ZipPreviewCacheValue | null {
	const cacheEntry = previewCache.get(key);
	if (!cacheEntry) return null;
	if (Date.now() - cacheEntry.cachedAt > CACHE_TTL_MS) {
		previewCache.delete(key);
		return null;
	}
	previewCache.delete(key);
	previewCache.set(key, cacheEntry);
	return cacheEntry.metadata;
}

export function writePreviewCache(key: string, metadata: ZipPreviewCacheValue): void {
	if (previewCache.has(key)) previewCache.delete(key);
	previewCache.set(key, { metadata, cachedAt: Date.now() });
	while (previewCache.size > CACHE_MAX_ITEMS) {
		const oldestKey = previewCache.keys().next().value as string | undefined;
		if (!oldestKey) return;
		previewCache.delete(oldestKey);
	}
}
