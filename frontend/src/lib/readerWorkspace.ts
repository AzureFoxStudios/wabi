import { browser } from '$app/environment';
import { writable } from 'svelte/store';
import { mobileTabQueue } from '$lib/mobileTabQueue';

export const READER_ADDON_ID = 'reader';

const READER_PREFS_STORAGE_KEY = 'wabi:reader:prefs:v1';
const READER_PROGRESS_STORAGE_KEY = 'wabi:reader:progress:v1';
const MAX_READER_HISTORY = 10;

export type ReaderDocumentFormat = 'markdown' | 'html' | 'text';
export type ReaderDocumentSource = 'local-temp' | 'pasted' | 'generated' | 'chat' | 'notes';
export type ReaderTheme = 'paper' | 'sepia' | 'night';
export type ReaderFontFamily = 'serif' | 'sans';
export type ReaderContentWidth = 'narrow' | 'medium' | 'wide';

export interface ReaderDocumentSelection {
	id: string;
	docKey: string;
	title: string;
	content: string;
	format: ReaderDocumentFormat;
	updatedAt: number;
	source: ReaderDocumentSource;
}

export interface ReaderPreferences {
	theme: ReaderTheme;
	fontFamily: ReaderFontFamily;
	fontSize: number;
	lineHeight: number;
	contentWidth: ReaderContentWidth;
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
	return value === 'sepia' || value === 'night' ? value : 'paper';
}

function normalizeFontFamily(value: string | undefined): ReaderFontFamily {
	return value === 'sans' ? 'sans' : 'serif';
}

function normalizeContentWidth(value: string | undefined): ReaderContentWidth {
	return value === 'narrow' || value === 'wide' ? value : 'medium';
}

function normalizePreferences(input: Partial<ReaderPreferences> | null | undefined): ReaderPreferences {
	return {
		theme: normalizeTheme(input?.theme),
		fontFamily: normalizeFontFamily(input?.fontFamily),
		fontSize: clamp(Number(input?.fontSize) || 18, 14, 28),
		lineHeight: clamp(Number(input?.lineHeight) || 1.7, 1.35, 2.3),
		contentWidth: normalizeContentWidth(input?.contentWidth)
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
	format: ReaderDocumentFormat
): string {
	const seed = `${format}:${title.trim().toLowerCase()}:${content.length}:${content.slice(0, 256)}`;
	return `rdoc-${hashString(seed)}`;
}

function inferReaderFormat(fileName: string): ReaderDocumentFormat {
	const normalized = fileName.toLowerCase();
	if (normalized.endsWith('.md') || normalized.endsWith('.markdown')) return 'markdown';
	if (normalized.endsWith('.html') || normalized.endsWith('.htm')) return 'html';
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
	source: ReaderDocumentSource = 'generated'
): void {
	const normalizedTitle = title.trim() || 'Untitled Document';
	const normalizedContent = content.replace(/\r\n/g, '\n');
	const entry: ReaderDocumentSelection = {
		id: makeReaderId(),
		docKey: computeDocumentKey(normalizedTitle, normalizedContent, format),
		title: normalizedTitle,
		content: normalizedContent,
		format,
		updatedAt: Date.now(),
		source
	};
	openReaderSelection(entry);
}

export async function openTemporaryReaderFile(file: File): Promise<void> {
	const content = await file.text();
	openReaderDocument(file.name || 'Imported Document', content, inferReaderFormat(file.name), 'local-temp');
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
