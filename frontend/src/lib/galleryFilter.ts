import type { GalleryItem } from './galleryStore';

export type GalleryMediaTypeFilter = 'all' | 'image' | 'video' | 'document' | 'model';
export type GalleryMediaKind = 'image' | 'video' | 'document' | 'model' | 'unknown';

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
/** Things with pages: they get a cover card and open in their own viewer, like a poster beside photos. */
export const DOCUMENT_EXTENSIONS = new Set(['pdf', 'md', 'txt']);
export const MODEL_EXTENSIONS = new Set(['glb', 'gltf', 'obj', 'stl']);

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
	if (normalized === 'application/pdf') return 'document';
	if (normalized.startsWith('model/')) return 'model';
	const ext = extensionOf(name);
	if (ext && IMAGE_EXTENSIONS.has(ext)) return 'image';
	if (ext && VIDEO_EXTENSIONS.has(ext)) return 'video';
	if (ext && DOCUMENT_EXTENSIONS.has(ext)) return 'document';
	if (ext && MODEL_EXTENSIONS.has(ext)) return 'model';
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

/** Keep every matching work, grouped by stable uploader even when identity is unavailable. */
export function orderGalleryByUploader(items: GalleryItem[]): GalleryItem[] {
 return [...items].sort((a, b) => a.uploadedBy - b.uploadedBy || b.uploadedAt - a.uploadedAt);
}
