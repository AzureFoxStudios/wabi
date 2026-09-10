import { browser } from '$app/environment';
import { writable } from 'svelte/store';
import { clampReaderProgress, type ReaderAnchor } from './components/readerDocumentTools';

export interface ReaderBookmark {
	id: string;
	label: string;
	anchor: ReaderAnchor;
	createdAt: number;
}
export interface ReaderNote {
	id: string;
	text: string;
	anchor: ReaderAnchor;
	createdAt: number;
}
export interface ReaderReadingRecord {
	anchor?: ReaderAnchor;
	bookmarks: ReaderBookmark[];
	notes: ReaderNote[];
}

const STORAGE_KEY = 'wabi:reader:library:v1';
const MAX_ITEMS = 200;
export const readerStorageNotice = writable('');

export function normalizeReaderAnchor(value: unknown): ReaderAnchor | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const anchor = value as Partial<ReaderAnchor>;
	if (!Number.isInteger(anchor.block) || (anchor.block as number) < -1) return undefined;
	return {
		block: anchor.block as number,
		offset: clampReaderProgress(Number(anchor.offset)),
		progress: clampReaderProgress(Number(anchor.progress))
	};
}

function readLibrary(): Record<string, ReaderReadingRecord> {
	if (!browser) return {};
	try {
		const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
		const records: Record<string, ReaderReadingRecord> = {};
		for (const [key, value] of Object.entries(raw)) {
			if (!key.startsWith('rdoc-') || !value || typeof value !== 'object') continue;
			const entry = value as Partial<ReaderReadingRecord>;
			const bookmarks: ReaderBookmark[] = [];
			const notes: ReaderNote[] = [];
			for (const mark of Array.isArray(entry.bookmarks) ? entry.bookmarks.slice(0, MAX_ITEMS) : []) {
				const anchor = normalizeReaderAnchor(mark?.anchor);
				if (anchor && typeof mark.id === 'string' && typeof mark.label === 'string') {
					bookmarks.push({ id: mark.id, label: mark.label.slice(0, 160), anchor, createdAt: Number(mark.createdAt) || 0 });
				}
			}
			for (const note of Array.isArray(entry.notes) ? entry.notes.slice(0, MAX_ITEMS) : []) {
				const anchor = normalizeReaderAnchor(note?.anchor);
				if (anchor && typeof note.id === 'string' && typeof note.text === 'string') {
					notes.push({ id: note.id, text: note.text.slice(0, 10000), anchor, createdAt: Number(note.createdAt) || 0 });
				}
			}
			records[key] = { anchor: normalizeReaderAnchor(entry.anchor), bookmarks, notes };
		}
		return records;
	} catch {
		return {};
	}
}

export const readerLibrary = writable<Record<string, ReaderReadingRecord>>(readLibrary());
readerLibrary.subscribe((records) => {
	if (!browser) return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
		readerStorageNotice.set('');
	} catch {
		readerStorageNotice.set('Browser storage is unavailable or full. Reading changes are kept for this session only.');
	}
});

// Bookmark IDs are local record keys, not authentication tokens. The fallback
// keeps self-hosted HTTP installations working where randomUUID is unavailable.
function makeReaderItemId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
	return `reader-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function editRecord(key: string, edit: (record: ReaderReadingRecord) => ReaderReadingRecord): void {
	if (!key) return;
	readerLibrary.update((records) => ({ ...records, [key]: edit(records[key] || { bookmarks: [], notes: [] }) }));
}

export function saveReaderAnchor(key: string, anchor: ReaderAnchor): void {
	editRecord(key, (record) => ({ ...record, anchor }));
}

export function addReaderBookmark(key: string, label: string, anchor: ReaderAnchor): void {
	editRecord(key, (record) => ({
		...record,
		bookmarks: [...record.bookmarks, {
			id: makeReaderItemId(), label: label.trim().slice(0, 160) || 'Saved place', anchor, createdAt: Date.now()
		}].slice(-MAX_ITEMS)
	}));
}

export function removeReaderBookmark(key: string, id: string): void {
	editRecord(key, (record) => ({ ...record, bookmarks: record.bookmarks.filter((mark) => mark.id !== id) }));
}

export function addReaderNote(key: string, text: string, anchor: ReaderAnchor): void {
	if (!text.trim()) return;
	editRecord(key, (record) => ({
		...record,
		notes: [...record.notes, { id: makeReaderItemId(), text: text.trim().slice(0, 10000), anchor, createdAt: Date.now() }].slice(-MAX_ITEMS)
	}));
}

export function removeReaderNote(key: string, id: string): void {
	editRecord(key, (record) => ({ ...record, notes: record.notes.filter((note) => note.id !== id) }));
}
