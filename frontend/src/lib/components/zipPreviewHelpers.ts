const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ITEMS = 120;

export interface ZipPreviewCacheEntry {
	metadata: import('$lib/zip/zipPreview').ZipPreviewMetadata;
	cachedAt: number;
}

const previewCache = new Map<string, ZipPreviewCacheEntry>();

export function readPreviewCache(key: string): import('$lib/zip/zipPreview').ZipPreviewMetadata | null {
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

export function writePreviewCache(key: string, metadata: import('$lib/zip/zipPreview').ZipPreviewMetadata): void {
	if (previewCache.has(key)) {
		previewCache.delete(key);
	}
	previewCache.set(key, { metadata, cachedAt: Date.now() });
	while (previewCache.size > CACHE_MAX_ITEMS) {
		const oldestKey = previewCache.keys().next().value as string | undefined;
		if (!oldestKey) return;
		previewCache.delete(oldestKey);
	}
}

export function clearPreviewCache(): void {
	previewCache.clear();
}

export function cacheKey(fileUrl: string, fileName: string, fileSize: number | undefined): string {
	return `${fileUrl}::${fileName || 'unnamed'}::${fileSize ?? 'unknown'}`;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getPathExtension(path: string): string {
	const slashIndex = path.lastIndexOf('/');
	const name = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
	const dotIndex = name.lastIndexOf('.');
	if (dotIndex < 0) return '';
	return name.slice(dotIndex + 1).toLowerCase();
}

export function getEntrySortName(path: string): string {
	const slashIndex = path.lastIndexOf('/');
	return (slashIndex >= 0 ? path.slice(slashIndex + 1) : path).toLowerCase();
}

export function sortEntries(
	entries: import('$lib/zip/zipPreview').ZipPreviewEntry[],
	mode: import('$lib/zip/zipPreviewSettings').ZipPreviewSortMode
): import('$lib/zip/zipPreview').ZipPreviewEntry[] {
	const sorted = entries.slice();
	sorted.sort((a, b) => {
		if (mode === 'name_desc') {
			const byName = getEntrySortName(b.path).localeCompare(getEntrySortName(a.path));
			if (byName !== 0) return byName;
			return b.path.localeCompare(a.path);
		}
		if (mode === 'size_desc') {
			const bySize = b.uncompressedSize - a.uncompressedSize;
			if (bySize !== 0) return bySize;
			return a.path.localeCompare(b.path);
		}
		if (mode === 'size_asc') {
			const bySize = a.uncompressedSize - b.uncompressedSize;
			if (bySize !== 0) return bySize;
			return a.path.localeCompare(b.path);
		}
		const byName = getEntrySortName(a.path).localeCompare(getEntrySortName(b.path));
		if (byName !== 0) return byName;
		return a.path.localeCompare(b.path);
	});
	return sorted;
}

export function getEntryIcon(entry: import('$lib/zip/zipPreview').ZipPreviewEntry): string {
	if (entry.isDirectory) return 'DIR';
	const ext = getPathExtension(entry.path);
	const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
	const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'csv', 'tsv', 'xml', 'html', 'log', 'yml', 'yaml', 'ini']);
	if (IMAGE_EXTENSIONS.has(ext)) return 'IMG';
	if (TEXT_EXTENSIONS.has(ext)) return 'TXT';
	if (ext === 'zip' || ext === 'rar' || ext === '7z' || ext === 'tar' || ext === 'gz') return 'ARC';
	if (ext === 'pdf' || ext === 'doc' || ext === 'docx') return 'DOC';
	if (ext === 'mp4' || ext === 'mov' || ext === 'webm' || ext === 'mkv') return 'VID';
	if (ext === 'mp3' || ext === 'wav' || ext === 'flac' || ext === 'ogg') return 'AUD';
	return 'FILE';
}

export function describeCompression(method: number, t: (key: string, values?: Record<string, unknown>) => string): string {
	if (method === 0) return t('messages.zip_preview.method_store');
	if (method === 8) return t('messages.zip_preview.method_deflate');
	return t('messages.zip_preview.method_other', { method });
}

export function imageMimeFromPath(path: string): string {
	const ext = getPathExtension(path);
	if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
	if (ext === 'gif') return 'image/gif';
	if (ext === 'webp') return 'image/webp';
	return 'image/png';
}
