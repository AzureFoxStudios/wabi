import { browser } from '$app/environment';
import { writable } from 'svelte/store';
import { mobileTabQueue } from '$lib/mobileTabQueue';
import { inferReaderCodeLanguage, isReaderCodeFile } from '$lib/readerCode';

export const READER_ADDON_ID = 'reader';

const READER_PREFS_STORAGE_KEY = 'wabi:reader:prefs:v1';
const READER_PROGRESS_STORAGE_KEY = 'wabi:reader:progress:v1';
const MAX_READER_HISTORY = 10;

/*
 * Reader Types
 *
 * These types mirror wabi-core Rust definitions for the web client.
 * Future: Import from @wabi/core when wabi-core is published and
 * TypeScript bindings are generated. Keep in sync with:
 *   - crates/wabi-core/src/reader.rs (future)
 *
 * Types that should eventually live in wabi-core:
 * - ReaderDocumentFormat, ReaderDocumentSource, ReaderTheme
 * - ReaderFontFamily, ReaderContentWidth, ReaderContentType
 * - ImageFitMode, ReadingDirection, ImagePage
 * - ReaderDocumentSelection, ReaderPreferences
 */

export type ReaderDocumentFormat = 'markdown' | 'html' | 'text' | 'code';
export type ReaderDocumentSource = 'local-temp' | 'pasted' | 'generated' | 'chat' | 'notes' | 'document';
export type ReaderTheme = 'auto' | 'paper' | 'sepia' | 'night';
export type ReaderFontFamily = 'serif' | 'sans';
export type ReaderContentWidth = 'narrow' | 'medium' | 'wide';
export type ReaderContentType = 'text' | 'images';
export type ImageFitMode = 'width' | 'height' | 'original';
export type ReadingDirection = 'ltr' | 'rtl' | 'horizontal';

export interface ImagePage {
	url: string;
	alt: string;
	width?: number;
	height?: number;
}

export interface ReaderDocumentSelection {
	id: string;
	docKey: string;
	title: string;
	content: string;
	format: ReaderDocumentFormat;
	updatedAt: number;
	source: ReaderDocumentSource;
	contentType: ReaderContentType;
	language?: string;
	images?: ImagePage[];
	/** Stable native Wabi document identity, when this selection is document-backed. */
	documentId?: string;
	/** Stable identity of the source entity (message/note/etc.) for local working copies. */
	sourceDocKey?: string;
}

export interface ReaderStableDocumentInput {
	documentId: string;
	title: string;
	content: string;
	format: ReaderDocumentFormat;
	language?: string;
	sourceDocKey?: string;
}

export interface ReaderPreferences {
	theme: ReaderTheme;
	fontFamily: ReaderFontFamily;
	fontSize: number;
	lineHeight: number;
	contentWidth: ReaderContentWidth;
	contentType: ReaderContentType;
	imageFit: ImageFitMode;
	readingDirection: ReadingDirection;
}

function makeReaderId(): string {
	return `reader-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function readJson<T>(key: string, fallback: T): T {
	if (!browser) return fallback;
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return fallback;
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

function writeJson<T>(key: string, value: T): void {
	if (!browser) return;
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Best effort only.
	}
}

function normalizeTheme(value: string | undefined): ReaderTheme {
	return value === 'paper' || value === 'sepia' || value === 'night' ? value : 'auto';
}

function normalizeFontFamily(value: string | undefined): ReaderFontFamily {
	return value === 'sans' ? 'sans' : 'serif';
}

function normalizeContentWidth(value: string | undefined): ReaderContentWidth {
	return value === 'narrow' || value === 'wide' ? value : 'medium';
}

function normalizeContentType(value: string | undefined): ReaderContentType {
	return value === 'images' ? 'images' : 'text';
}

function normalizeImageFit(value: string | undefined): ImageFitMode {
	if (value === 'height' || value === 'original') return value;
	return 'width';
}

function normalizeReadingDirection(value: string | undefined): ReadingDirection {
	if (value === 'rtl') return 'rtl';
	if (value === 'horizontal') return 'horizontal';
	return 'ltr';
}

function normalizePreferences(input: Partial<ReaderPreferences> | null | undefined): ReaderPreferences {
	return {
		theme: normalizeTheme(input?.theme),
		fontFamily: normalizeFontFamily(input?.fontFamily),
		fontSize: clamp(Number(input?.fontSize) || 18, 14, 28),
		lineHeight: clamp(Number(input?.lineHeight) || 1.7, 1.35, 2.3),
		contentWidth: normalizeContentWidth(input?.contentWidth),
		contentType: normalizeContentType(input?.contentType),
		imageFit: normalizeImageFit(input?.imageFit),
		readingDirection: normalizeReadingDirection(input?.readingDirection)
	};
}

function hashString(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

function computeDocumentKey(
	title: string,
	content: string,
	format: ReaderDocumentFormat,
	language = ''
): string {
	// Preserve the pre-code Reader key shape for existing Markdown/HTML/text/image
	// documents so saved progress, bookmarks, and notes survive the upgrade.
	const legacySeed = `${format}:${title.trim().toLowerCase()}:${content.length}:${content.slice(0, 256)}`;
	const seed = language ? `${format}:${language}:${title.trim().toLowerCase()}:${content.length}:${content.slice(0, 256)}` : legacySeed;
	return `rdoc-${hashString(seed)}`;
}

export function readerSourceDocumentKey(
	source: ReaderDocumentSource,
	sourceId: string | null | undefined,
	fallbackDocKey: string
): string {
	const stableId = String(sourceId || '').trim();
	return stableId ? `${source}:${stableId}` : fallbackDocKey;
}

function inferReaderFormat(fileName: string): ReaderDocumentFormat {
	const normalized = fileName.toLowerCase();
	if (normalized.endsWith('.md') || normalized.endsWith('.markdown')) return 'markdown';
	if (normalized.endsWith('.html') || normalized.endsWith('.htm')) return 'html';
	if (isReaderCodeFile(fileName)) return 'code';
	return 'text';
}

const readerSelection = writable<ReaderDocumentSelection | null>(null);
const readerHistory = writable<ReaderDocumentSelection[]>([]);
const readerPreferences = writable<ReaderPreferences>(
	normalizePreferences(readJson<Partial<ReaderPreferences> | null>(READER_PREFS_STORAGE_KEY, null))
);
const readerProgressByDocument = writable<Record<string, number>>(
	readJson<Record<string, number>>(READER_PROGRESS_STORAGE_KEY, {})
);

readerPreferences.subscribe((value) => {
	writeJson(READER_PREFS_STORAGE_KEY, value);
});

readerProgressByDocument.subscribe((value) => {
	writeJson(READER_PROGRESS_STORAGE_KEY, value);
});

function pushReaderHistory(entry: ReaderDocumentSelection): void {
	readerHistory.update((entries) => {
		const filtered = entries.filter((item) => item.docKey !== entry.docKey);
		return [entry, ...filtered].slice(0, MAX_READER_HISTORY);
	});
}

function openReaderSelection(next: ReaderDocumentSelection): void {
	readerSelection.set(next);
	pushReaderHistory(next);
	mobileTabQueue.openAddonTab(READER_ADDON_ID);
}

export function openReaderSurface(): void {
	mobileTabQueue.openAddonTab(READER_ADDON_ID);
}

export function clearReaderSelection(): void {
	readerSelection.set(null);
}

export function openReaderDocument(
	title: string,
	content: string,
	format: ReaderDocumentFormat = 'markdown',
	source: ReaderDocumentSource = 'generated',
	language?: string,
	sourceId?: string
): void {
	const normalizedTitle = title.trim() || 'Untitled Document';
	const normalizedContent = content.replace(/\r\n/g, '\n');
	const resolvedLanguage = format === 'code' ? (language || inferReaderCodeLanguage(normalizedTitle)) : language;
	const docKey = computeDocumentKey(normalizedTitle, normalizedContent, format, resolvedLanguage);
	const entry: ReaderDocumentSelection = {
		id: makeReaderId(),
		docKey,
		sourceDocKey: readerSourceDocumentKey(source, sourceId, docKey),
		title: normalizedTitle,
		content: normalizedContent,
		format,
		updatedAt: Date.now(),
		source,
		contentType: 'text',
		...(resolvedLanguage ? { language: resolvedLanguage } : {})
	};
	openReaderSelection(entry);
}

export function openReaderStableDocument(input: ReaderStableDocumentInput): void {
	const documentId = input.documentId.trim();
	if (!documentId) return;
	const title = input.title.trim() || 'Untitled Document';
	const content = input.content.replace(/\r\n/g, '\n');
	const language = input.format === 'code'
		? (input.language || inferReaderCodeLanguage(title))
		: input.language;
	openReaderSelection({
		id: makeReaderId(),
		docKey: `wdoc-${documentId}`,
		documentId,
		sourceDocKey: input.sourceDocKey,
		title,
		content,
		format: input.format,
		updatedAt: Date.now(),
		source: 'document',
		contentType: 'text',
		...(language ? { language } : {})
	});
}

/**
 * Update the currently open Reader selection without recomputing its docKey.
 * Editable documents therefore keep one stable identity while their title and
 * content change, and Reader's existing progress/annotation state stays attached.
 */
export function updateReaderSelectionDocument(patch: { title?: string; content?: string }): void {
	let nextSelection: ReaderDocumentSelection | null = null;
	readerSelection.update((current) => {
		if (!current || current.contentType === 'images') return current;
		const title = patch.title ?? current.title;
		const content = patch.content !== undefined ? patch.content.replace(/\r\n/g, '\n') : current.content;
		if (title === current.title && content === current.content) return current;
		nextSelection = { ...current, title, content, updatedAt: Date.now() };
		return nextSelection;
	});
	if (nextSelection) pushReaderHistory(nextSelection);
}

export async function openTemporaryReaderFile(file: File): Promise<void> {
	const content = await file.text();
	const format = inferReaderFormat(file.name);
	openReaderDocument(
		file.name || 'Imported Document',
		content,
		format,
		'local-temp',
		format === 'code' ? inferReaderCodeLanguage(file.name) : undefined
	);
}

export function openReaderImageDocument(
	title: string,
	images: ImagePage[],
	source: ReaderDocumentSource = 'local-temp'
): void {
	const normalizedTitle = title.trim() || 'Untitled Gallery';
	const content = `Gallery: ${images.length} images`;
	const entry: ReaderDocumentSelection = {
		id: makeReaderId(),
		docKey: computeDocumentKey(normalizedTitle, content, 'text'),
		title: normalizedTitle,
		content,
		format: 'text',
		updatedAt: Date.now(),
		source,
		contentType: 'images',
		images
	};
	openReaderSelection(entry);
}

export async function openReaderImagesFromFiles(title: string, files: FileList): Promise<void> {
	const images: ImagePage[] = [];
	const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		const ext = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
		if (imageExtensions.includes(ext)) {
			const url = URL.createObjectURL(file);
			images.push({
				url,
				alt: file.name,
				width: undefined,
				height: undefined
			});
		}
	}

	if (images.length > 0) {
		updateReaderPreferences({ readingDirection: 'horizontal' });
		openReaderImageDocument(title || 'Image Gallery', images, 'local-temp');
	}
	return;
}

export function openReaderHistoryEntry(entryId: string): void {
	if (!entryId) return;
	let next: ReaderDocumentSelection | null = null;
	readerHistory.update((entries) => {
		const found = entries.find((entry) => entry.id === entryId) || null;
		if (!found) return entries;
		next = { ...found, updatedAt: Date.now() };
		const remaining = entries.filter((entry) => entry.id !== found.id);
		return next ? [next, ...remaining] : entries;
	});
	if (next) {
		readerSelection.set(next);
		mobileTabQueue.openAddonTab(READER_ADDON_ID);
	}
}

export function updateReaderPreferences(next: Partial<ReaderPreferences>): void {
	readerPreferences.update((current) => normalizePreferences({ ...current, ...next }));
}

export function setReaderDocumentProgress(docKey: string, progress: number): void {
	if (!docKey) return;
	const normalized = clamp(Number(progress) || 0, 0, 1);
	readerProgressByDocument.update((current) => {
		if (Math.abs((current[docKey] ?? 0) - normalized) < 0.0025) return current;
		return {
			...current,
			[docKey]: normalized
		};
	});
}

export {
	readerHistory,
	readerPreferences,
	readerProgressByDocument,
	readerSelection
};
