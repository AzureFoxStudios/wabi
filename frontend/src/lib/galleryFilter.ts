import type { GalleryItem } from './galleryStore';

export type GalleryMediaTypeFilter = 'all' | 'image' | 'video';
export type GalleryMediaKind = 'image' | 'video' | 'unknown';

export interface GalleryFilterState {
	query: string;
	type: GalleryMediaTypeFilter;
	/** Stable uploader id (uploadedBy), never the resolved creator object. */
	uploaderId: number | null;
}

export type GalleryViewState = 'empty' | 'no-match' | 'results';

const IMAGE_EXTENSIONS = new Set([
	'avif',
	'bmp',
	'gif',
	'jpeg',
	'jpg',
	'png',
	'svg',
	'tif',
	'tiff',
	'webp'
]);
const VIDEO_EXTENSIONS = new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'ogv', 'webm']);

function extensionOf(name: string): string | null {
	const trimmed = (name || '').trim().toLowerCase();
	const dot = trimmed.lastIndexOf('.');
	if (dot < 0 || dot === trimmed.length - 1) return null;
	const ext = trimmed.slice(dot + 1);
	return /^[a-z0-9]{2,5}$/.test(ext) ? ext : null;
}

/** Media kind with MIME first and file-extension fallback for missing/odd types. */
export function guessGalleryMediaKind(mime: string | null, name: string): GalleryMediaKind {
	const normalized = (mime || '').trim().toLowerCase();
	if (normalized.startsWith('image/')) return 'image';
	if (normalized.startsWith('video/')) return 'video';
	const ext = extensionOf(name);
	if (ext && IMAGE_EXTENSIONS.has(ext)) return 'image';
	if (ext && VIDEO_EXTENSIONS.has(ext)) return 'video';
	return 'unknown';
}

/**
 * Apply search, media-type and uploader filters to the FULL item list.
 * Callers must filter first and only then split into recent/older sections,
 * so every section honors the active filters.
 */
export function filterGalleryItems(
	items: GalleryItem[],
	filter: GalleryFilterState
): GalleryItem[] {
	const query = filter.query.trim().toLowerCase();
	return items.filter((item) => {
		if (filter.type !== 'all' && guessGalleryMediaKind(item.attachmentMime, item.attachmentName) !== filter.type) {
			return false;
		}
		// Stable uploader identity: items whose creator never resolved
		// (offline/unknown users) remain filterable through uploadedBy.
		if (filter.uploaderId !== null && item.uploadedBy !== filter.uploaderId) return false;
		if (query) {
			const creatorName = (item.creator?.username || '').toLowerCase();
			const caption = (item.caption || '').toLowerCase();
			const name = item.attachmentName.toLowerCase();
			if (!creatorName.includes(query) && !caption.includes(query) && !name.includes(query)) {
				return false;
			}
		}
		return true;
	});
}

/** Split an already-filtered list into recent + older sections. */
export function splitGallerySections<T>(items: T[], recentCount: number): { recent: T[]; older: T[] } {
	return { recent: items.slice(0, recentCount), older: items.slice(recentCount) };
}

/** Distinguish "nothing uploaded yet" from "filters match nothing". */
export function galleryViewState(totalCount: number, filteredCount: number): GalleryViewState {
	if (totalCount === 0) return 'empty';
	if (filteredCount === 0) return 'no-match';
	return 'results';
}
