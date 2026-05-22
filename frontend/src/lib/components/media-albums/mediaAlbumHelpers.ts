import { getServerUrl } from '$lib/serverUrl';
import { MediaAlbumApiError, type MediaAlbum, type MediaAlbumItem } from '$lib/api/albums';

export type AlbumItemSortMode = 'manual' | 'newest' | 'oldest' | 'name';
export type AlbumItemViewMode = 'list' | 'grid';

interface AlbumViewPrefs {
	sortMode: AlbumItemSortMode;
	viewMode: AlbumItemViewMode;
}

const ALBUM_VIEW_PREFS_KEY = 'wabi.mediaAlbums.viewPrefs.v1';

export function sanitizeAlbumSortMode(value: unknown): AlbumItemSortMode {
	if (value === 'manual') return 'manual';
	if (value === 'oldest') return 'oldest';
	if (value === 'name') return 'name';
	return 'newest';
}

export function sanitizeAlbumViewMode(value: unknown): AlbumItemViewMode {
	if (value === 'list') return 'list';
	return 'grid';
}

function safeReadAlbumViewPrefsMap(): Record<string, AlbumViewPrefs> {
	if (typeof window === 'undefined') return {};
	try {
		const raw = window.localStorage.getItem(ALBUM_VIEW_PREFS_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as Record<string, Partial<AlbumViewPrefs>>;
		const sanitized: Record<string, AlbumViewPrefs> = {};
		for (const [key, value] of Object.entries(parsed || {})) {
			if (!key) continue;
			sanitized[key] = {
				sortMode: sanitizeAlbumSortMode(value?.sortMode),
				viewMode: sanitizeAlbumViewMode(value?.viewMode)
			};
		}
		return sanitized;
	} catch {
		return {};
	}
}

function safeWriteAlbumViewPrefsMap(map: Record<string, AlbumViewPrefs>): void {
	if (typeof window === 'undefined') return;
	try {
		window.localStorage.setItem(ALBUM_VIEW_PREFS_KEY, JSON.stringify(map));
	} catch {
		// best-effort persistence
	}
}

export function readScopeViewPreferences(scopeKey: string): AlbumViewPrefs | null {
	if (!scopeKey) return null;
	return safeReadAlbumViewPrefsMap()[scopeKey] || null;
}

export function writeScopeViewPreferences(scopeKey: string, prefs: AlbumViewPrefs): void {
	if (!scopeKey) return;
	const map = safeReadAlbumViewPrefsMap();
	map[scopeKey] = {
		sortMode: sanitizeAlbumSortMode(prefs.sortMode),
		viewMode: sanitizeAlbumViewMode(prefs.viewMode)
	};
	safeWriteAlbumViewPrefsMap(map);
}

export function sortAlbumsForDisplay(nextAlbums: MediaAlbum[]): MediaAlbum[] {
	return nextAlbums
		.slice()
		.sort((a, b) => {
			if (a.isFeatured !== b.isFeatured) {
				return a.isFeatured ? -1 : 1;
			}
			return b.updatedAt - a.updatedAt;
		});
}

export function formatTimestamp(timestamp: number | null | undefined): string {
	if (!timestamp) return 'unknown';
	try {
		return new Date(timestamp).toLocaleString();
	} catch {
		return 'unknown';
	}
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function resolveAlbumAssetUrl(attachmentUrl: string): string {
	if (!attachmentUrl) return '';
	if (attachmentUrl.startsWith('data:')) return attachmentUrl;
	if (attachmentUrl.startsWith('http://') || attachmentUrl.startsWith('https://')) {
		try {
			const absoluteUrl = new URL(attachmentUrl);
			const isLocalAsset =
				(absoluteUrl.hostname === 'localhost' || absoluteUrl.hostname === '127.0.0.1') &&
				(
					absoluteUrl.pathname.startsWith('/uploads/') ||
					/^\/api\/whiteboard\/boards\/[^/]+\/files\//.test(absoluteUrl.pathname)
				);
			if (isLocalAsset) {
				return `${getServerUrl()}${absoluteUrl.pathname}${absoluteUrl.search}${absoluteUrl.hash}`;
			}
		} catch {
			// fall through to original URL
		}
		return attachmentUrl;
	}
	const normalizedPath = attachmentUrl.startsWith('/') ? attachmentUrl : `/${attachmentUrl}`;
	return `${getServerUrl()}${normalizedPath}`;
}

export function isImageAlbumItem(item: MediaAlbumItem): boolean {
	const mime = (item.attachmentMime || '').toLowerCase();
	return mime.startsWith('image/') || /\.(avif|bmp|gif|heic|jpe?g|png|svg|webp)$/i.test(item.attachmentName);
}

export function isVideoAlbumItem(item: MediaAlbumItem): boolean {
	const mime = (item.attachmentMime || '').toLowerCase();
	return mime.startsWith('video/') || /\.(m4v|mov|mp4|ogv|webm)$/i.test(item.attachmentName);
}

export function albumItemKindLabel(item: MediaAlbumItem): string {
	if (isImageAlbumItem(item)) return 'Image';
	if (isVideoAlbumItem(item)) return 'Video';
	if ((item.attachmentMime || '').startsWith('audio/')) return 'Audio';
	const extension = item.attachmentName.split('.').pop()?.trim();
	return extension ? extension.toUpperCase() : 'FILE';
}

export function formatAlbumActionError(
	error: unknown,
	fallback: string,
	context: { mode: 'upload' | 'url' }
): string {
	if (error instanceof MediaAlbumApiError) {
		if (error.code === 'ALBUM_UPLOAD_SIZE_LIMIT') {
			const maxBytes = typeof error.details?.maxBytes === 'number' ? error.details.maxBytes : null;
			if (maxBytes !== null) {
				return `Album item exceeds your role size limit (${formatBytes(maxBytes)} max).`;
			}
			return 'Album item exceeds your role size limit.';
		}
		if (error.code === 'ALBUM_UPLOAD_RATE_LIMIT_USER') {
			const retry = error.retryAfterSeconds ?? 60;
			return `You reached the album upload limit for this minute. Try again in ${retry}s.`;
		}
		if (error.code === 'ALBUM_UPLOAD_RATE_LIMIT_SCOPE') {
			const retry = error.retryAfterSeconds ?? 60;
			return `This channel/DM album scope is currently rate-limited. Try again in ${retry}s.`;
		}
	}
	if (error instanceof Error && error.message.trim()) return error.message;
	return context.mode === 'upload' ? 'Failed to upload album file' : fallback;
}
