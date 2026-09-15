import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';
import type {
	ReaderDocumentFormat,
	ReaderDocumentSelection,
	ReaderDocumentSource
} from '$lib/readerWorkspace';

export type ReaderWorkMode = 'read' | 'edit' | 'suggest' | 'comment';
export type ReaderDocumentKind = 'working-copy' | 'native';
export type ReaderShareState = 'private' | 'shared' | 'live';
export type ReaderLocalSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
export type ReaderSuggestionStatus = 'open' | 'accepted' | 'rejected';

export interface ReaderSuggestion {
	id: string;
	baseRevision: number;
	title: string;
	content: string;
	status: ReaderSuggestionStatus;
	createdAt: number;
	updatedAt: number;
}

export interface ReaderDocumentComment {
	id: string;
	body: string;
	resolved: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface ReaderLocalDocument {
	v: 1;
	documentId: string;
	kind: ReaderDocumentKind;
	/** Reader/source key this local document was derived from. */
	sourceDocKey: string;
	source: ReaderDocumentSource | 'document';
	originalTitle: string;
	originalContent: string;
	title: string;
	content: string;
	format: ReaderDocumentFormat;
	language?: string;
	shareState: ReaderShareState;
	revision: number;
	createdAt: number;
	updatedAt: number;
	lastLocalSaveAt?: number;
	suggestions: ReaderSuggestion[];
	comments: ReaderDocumentComment[];
}

const DB_NAME = 'wabi-reader-documents';
const DB_VERSION = 1;
const STORE_NAME = 'documents';
const FALLBACK_PREFIX = 'wabi:reader:document:v1:';
const RECOVERY_PREFIX = 'wabi:reader:document-recovery:v1:';
const SAVE_DEBOUNCE_MS = 120;

export const readerDocuments = writable<Record<string, ReaderLocalDocument>>({});
export const readerDocumentsHydrated = writable(false);
export const readerDocumentSaveState = writable<Record<string, ReaderLocalSaveState>>({});
export const readerStoragePersistent = writable<boolean | null>(null);

let hydratePromise: Promise<void> | null = null;
let dbPromise: Promise<IDBDatabase | null> | null = null;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function now(): number {
	return Date.now();
}

function randomId(prefix: string): string {
	const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
		? crypto.randomUUID()
		: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	return `${prefix}-${uuid}`;
}

function normalizeDocument(record: ReaderLocalDocument): ReaderLocalDocument {
	return {
		...record,
		v: 1,
		kind: record.kind === 'native' ? 'native' : 'working-copy',
		shareState: record.shareState === 'shared' || record.shareState === 'live' ? record.shareState : 'private',
		revision: Number.isFinite(record.revision) ? Math.max(0, record.revision) : 0,
		suggestions: Array.isArray(record.suggestions) ? record.suggestions : [],
		comments: Array.isArray(record.comments) ? record.comments : []
	};
}

function setSaveState(documentId: string, state: ReaderLocalSaveState): void {
	readerDocumentSaveState.update((current) => ({ ...current, [documentId]: state }));
}

function storageKey(prefix: string, documentId: string): string {
	return `${prefix}${documentId}`;
}

function safeLocalSet(key: string, value: string): void {
	if (!browser) return;
	try {
		localStorage.setItem(key, value);
	} catch {
		// IndexedDB remains the primary store. Recovery mirroring is best-effort.
	}
}

function safeLocalRemove(key: string): void {
	if (!browser) return;
	try {
		localStorage.removeItem(key);
	} catch {
		// Best-effort cleanup.
	}
}

function readLocalDocuments(prefix: string): ReaderLocalDocument[] {
	if (!browser) return [];
	const records: ReaderLocalDocument[] = [];
	try {
		for (let index = 0; index < localStorage.length; index += 1) {
			const key = localStorage.key(index);
			if (!key?.startsWith(prefix)) continue;
			const raw = localStorage.getItem(key);
			if (!raw) continue;
			try {
				const parsed = JSON.parse(raw) as ReaderLocalDocument;
				if (parsed?.documentId && parsed?.v === 1) records.push(normalizeDocument(parsed));
			} catch {
				// Ignore one malformed recovery entry rather than losing the rest.
			}
		}
	} catch {
		return [];
	}
	return records;
}

function openReaderDocumentsDb(): Promise<IDBDatabase | null> {
	if (!browser || typeof indexedDB === 'undefined') return Promise.resolve(null);
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve) => {
		try {
			const request = indexedDB.open(DB_NAME, DB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					const store = db.createObjectStore(STORE_NAME, { keyPath: 'documentId' });
					store.createIndex('sourceDocKey', 'sourceDocKey', { unique: false });
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => resolve(null);
			request.onblocked = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
	return dbPromise;
}

async function idbGetAll(): Promise<ReaderLocalDocument[]> {
	const db = await openReaderDocumentsDb();
	if (!db) return [];
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(STORE_NAME, 'readonly');
			const request = tx.objectStore(STORE_NAME).getAll();
			request.onsuccess = () => resolve((request.result || []).map((record) => normalizeDocument(record as ReaderLocalDocument)));
			request.onerror = () => resolve([]);
		} catch {
			resolve([]);
		}
	});
}

async function idbPut(record: ReaderLocalDocument): Promise<boolean> {
	const db = await openReaderDocumentsDb();
	if (!db) return false;
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(STORE_NAME, 'readwrite');
			tx.objectStore(STORE_NAME).put(record);
			tx.oncomplete = () => resolve(true);
			tx.onerror = () => resolve(false);
			tx.onabort = () => resolve(false);
		} catch {
			resolve(false);
		}
	});
}

async function idbDelete(documentId: string): Promise<void> {
	const db = await openReaderDocumentsDb();
	if (!db) return;
	await new Promise<void>((resolve) => {
		try {
			const tx = db.transaction(STORE_NAME, 'readwrite');
			tx.objectStore(STORE_NAME).delete(documentId);
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
			tx.onabort = () => resolve();
		} catch {
			resolve();
		}
	});
}

function mergeNewest(records: ReaderLocalDocument[]): Record<string, ReaderLocalDocument> {
	const merged: Record<string, ReaderLocalDocument> = {};
	for (const record of records) {
		const normalized = normalizeDocument(record);
		const existing = merged[normalized.documentId];
		if (!existing || normalized.updatedAt >= existing.updatedAt) merged[normalized.documentId] = normalized;
	}
	return merged;
}

export async function requestReaderPersistentStorage(): Promise<boolean | null> {
	if (!browser || !navigator.storage?.persist) {
		readerStoragePersistent.set(null);
		return null;
	}
	try {
		const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
		const result = persisted || await navigator.storage.persist();
		readerStoragePersistent.set(result);
		return result;
	} catch {
		readerStoragePersistent.set(null);
		return null;
	}
}

export async function hydrateReaderDocuments(): Promise<void> {
	if (get(readerDocumentsHydrated)) return;
	if (hydratePromise) return hydratePromise;
	hydratePromise = (async () => {
		const [indexed, fallback] = await Promise.all([
			idbGetAll(),
			Promise.resolve(readLocalDocuments(FALLBACK_PREFIX))
		]);
		const recovery = readLocalDocuments(RECOVERY_PREFIX);
		const merged = mergeNewest([...indexed, ...fallback, ...recovery]);
		readerDocuments.set(merged);
		readerDocumentsHydrated.set(true);
		void requestReaderPersistentStorage();
	})();
	try {
		await hydratePromise;
	} finally {
		hydratePromise = null;
	}
}

export function createReaderDocumentRecord(
	selection: ReaderDocumentSelection,
	documentId = randomId('wdoc'),
	createdAt = now()
): ReaderLocalDocument {
	return {
		v: 1,
		documentId,
		kind: selection.source === 'document' ? 'native' : 'working-copy',
		sourceDocKey: selection.sourceDocKey || selection.docKey,
		source: selection.source,
		originalTitle: selection.title,
		originalContent: selection.content,
		title: selection.title,
		content: selection.content,
		format: selection.format,
		...(selection.language ? { language: selection.language } : {}),
		shareState: 'private',
		revision: 0,
		createdAt,
		updatedAt: createdAt,
		suggestions: [],
		comments: []
	};
}

export function findReaderDocumentForSelection(selection: ReaderDocumentSelection | null): ReaderLocalDocument | null {
	if (!selection) return null;
	const documents = Object.values(get(readerDocuments));
	if (selection.documentId) {
		const direct = documents.find((document) => document.documentId === selection.documentId);
		if (direct) return direct;
	}
	const sourceDocKey = selection.sourceDocKey || selection.docKey;
	return documents.find((document) => document.sourceDocKey === sourceDocKey) || null;
}

async function persistNow(record: ReaderLocalDocument): Promise<void> {
	setSaveState(record.documentId, 'saving');
	const saved = { ...record, lastLocalSaveAt: now() };
	readerDocuments.update((current) => ({ ...current, [saved.documentId]: saved }));
	const idbSaved = await idbPut(saved);
	if (!idbSaved) safeLocalSet(storageKey(FALLBACK_PREFIX, saved.documentId), JSON.stringify(saved));
	else safeLocalRemove(storageKey(FALLBACK_PREFIX, saved.documentId));
	safeLocalRemove(storageKey(RECOVERY_PREFIX, saved.documentId));
	setSaveState(saved.documentId, 'saved');
}

function schedulePersist(record: ReaderLocalDocument): void {
	// Synchronous recovery mirror first: a crash between this keystroke and the
	// IndexedDB transaction can still be recovered on the next launch.
	safeLocalSet(storageKey(RECOVERY_PREFIX, record.documentId), JSON.stringify(record));
	setSaveState(record.documentId, 'dirty');
	const existing = saveTimers.get(record.documentId);
	if (existing) clearTimeout(existing);
	saveTimers.set(record.documentId, setTimeout(() => {
		saveTimers.delete(record.documentId);
		void persistNow(record).catch(() => setSaveState(record.documentId, 'error'));
	}, SAVE_DEBOUNCE_MS));
}

export async function flushReaderDocument(documentId: string): Promise<void> {
	const timer = saveTimers.get(documentId);
	if (timer) {
		clearTimeout(timer);
		saveTimers.delete(documentId);
	}
	const record = get(readerDocuments)[documentId];
	if (!record) return;
	try {
		await persistNow(record);
	} catch {
		setSaveState(documentId, 'error');
	}
}

export async function flushAllReaderDocuments(): Promise<void> {
	await Promise.all(Object.keys(get(readerDocuments)).map((documentId) => flushReaderDocument(documentId)));
}

export async function ensureReaderDocument(selection: ReaderDocumentSelection): Promise<ReaderLocalDocument> {
	await hydrateReaderDocuments();
	const existing = findReaderDocumentForSelection(selection);
	if (existing) return existing;
	const document = createReaderDocumentRecord(
		selection,
		selection.documentId || randomId('wdoc')
	);
	readerDocuments.update((current) => ({ ...current, [document.documentId]: document }));
	safeLocalSet(storageKey(RECOVERY_PREFIX, document.documentId), JSON.stringify(document));
	await persistNow(document);
	return get(readerDocuments)[document.documentId] || document;
}

export function applyReaderDocumentEdit(
	record: ReaderLocalDocument,
	patch: { title?: string; content?: string },
	updatedAt = now()
): ReaderLocalDocument {
	const title = patch.title ?? record.title;
	const content = patch.content ?? record.content;
	if (title === record.title && content === record.content) return record;
	return {
		...record,
		title,
		content,
		revision: record.revision + 1,
		updatedAt
	};
}

export function updateReaderDocument(
	documentId: string,
	patch: { title?: string; content?: string }
): ReaderLocalDocument | null {
	const record = get(readerDocuments)[documentId];
	if (!record) return null;
	const next = applyReaderDocumentEdit(record, patch);
	if (next === record) return record;
	readerDocuments.update((current) => ({ ...current, [documentId]: next }));
	schedulePersist(next);
	return next;
}

export function promoteReaderDocument(documentId: string): ReaderLocalDocument | null {
	const record = get(readerDocuments)[documentId];
	if (!record) return null;
	if (record.kind === 'native') return record;
	const next: ReaderLocalDocument = { ...record, kind: 'native', updatedAt: now() };
	readerDocuments.update((current) => ({ ...current, [documentId]: next }));
	schedulePersist(next);
	return next;
}

export function createOrUpdateReaderSuggestion(
	record: ReaderLocalDocument,
	suggestionId: string | null,
	patch: { title?: string; content?: string },
	updatedAt = now()
): { document: ReaderLocalDocument; suggestion: ReaderSuggestion } {
	const existing = suggestionId
		? record.suggestions.find((suggestion) => suggestion.id === suggestionId && suggestion.status === 'open')
		: undefined;
	const suggestion: ReaderSuggestion = existing
		? {
			...existing,
			title: patch.title ?? existing.title,
			content: patch.content ?? existing.content,
			updatedAt
		}
		: {
			id: randomId('suggestion'),
			baseRevision: record.revision,
			title: patch.title ?? record.title,
			content: patch.content ?? record.content,
			status: 'open',
			createdAt: updatedAt,
			updatedAt
		};
	const suggestions = existing
		? record.suggestions.map((item) => item.id === suggestion.id ? suggestion : item)
		: [...record.suggestions, suggestion];
	return {
		document: { ...record, suggestions, updatedAt },
		suggestion
	};
}

export function updateReaderSuggestion(
	documentId: string,
	suggestionId: string | null,
	patch: { title?: string; content?: string }
): ReaderSuggestion | null {
	const record = get(readerDocuments)[documentId];
	if (!record) return null;
	const result = createOrUpdateReaderSuggestion(record, suggestionId, patch);
	readerDocuments.update((current) => ({ ...current, [documentId]: result.document }));
	schedulePersist(result.document);
	return result.suggestion;
}

export function acceptReaderSuggestion(documentId: string, suggestionId: string): ReaderLocalDocument | null {
	const record = get(readerDocuments)[documentId];
	const suggestion = record?.suggestions.find((item) => item.id === suggestionId && item.status === 'open');
	if (!record || !suggestion) return null;
	const timestamp = now();
	const suggestions = record.suggestions.map((item) => item.id === suggestionId
		? { ...item, status: 'accepted' as const, updatedAt: timestamp }
		: item);
	const next: ReaderLocalDocument = {
		...record,
		title: suggestion.title,
		content: suggestion.content,
		suggestions,
		revision: record.revision + 1,
		updatedAt: timestamp
	};
	readerDocuments.update((current) => ({ ...current, [documentId]: next }));
	schedulePersist(next);
	return next;
}

export function rejectReaderSuggestion(documentId: string, suggestionId: string): ReaderLocalDocument | null {
	const record = get(readerDocuments)[documentId];
	if (!record) return null;
	const timestamp = now();
	const suggestions = record.suggestions.map((item) => item.id === suggestionId && item.status === 'open'
		? { ...item, status: 'rejected' as const, updatedAt: timestamp }
		: item);
	const next: ReaderLocalDocument = { ...record, suggestions, updatedAt: timestamp };
	readerDocuments.update((current) => ({ ...current, [documentId]: next }));
	schedulePersist(next);
	return next;
}

export function addReaderDocumentComment(documentId: string, body: string): ReaderDocumentComment | null {
	const record = get(readerDocuments)[documentId];
	const normalized = body.trim();
	if (!record || !normalized) return null;
	const timestamp = now();
	const comment: ReaderDocumentComment = {
		id: randomId('comment'),
		body: normalized,
		resolved: false,
		createdAt: timestamp,
		updatedAt: timestamp
	};
	const next: ReaderLocalDocument = {
		...record,
		comments: [...record.comments, comment],
		updatedAt: timestamp
	};
	readerDocuments.update((current) => ({ ...current, [documentId]: next }));
	schedulePersist(next);
	return comment;
}

export function setReaderDocumentCommentResolved(documentId: string, commentId: string, resolved: boolean): void {
	const record = get(readerDocuments)[documentId];
	if (!record) return;
	const timestamp = now();
	const comments = record.comments.map((comment) => comment.id === commentId
		? { ...comment, resolved, updatedAt: timestamp }
		: comment);
	const next = { ...record, comments, updatedAt: timestamp };
	readerDocuments.update((current) => ({ ...current, [documentId]: next }));
	schedulePersist(next);
}

export function removeReaderDocumentComment(documentId: string, commentId: string): void {
	const record = get(readerDocuments)[documentId];
	if (!record) return;
	const next = {
		...record,
		comments: record.comments.filter((comment) => comment.id !== commentId),
		updatedAt: now()
	};
	readerDocuments.update((current) => ({ ...current, [documentId]: next }));
	schedulePersist(next);
}

export async function discardReaderDocument(documentId: string): Promise<void> {
	const timer = saveTimers.get(documentId);
	if (timer) {
		clearTimeout(timer);
		saveTimers.delete(documentId);
	}
	readerDocuments.update((current) => {
		const next = { ...current };
		delete next[documentId];
		return next;
	});
	readerDocumentSaveState.update((current) => {
		const next = { ...current };
		delete next[documentId];
		return next;
	});
	safeLocalRemove(storageKey(FALLBACK_PREFIX, documentId));
	safeLocalRemove(storageKey(RECOVERY_PREFIX, documentId));
	await idbDelete(documentId);
}

export function isReaderDocumentChanged(record: ReaderLocalDocument): boolean {
	return record.title !== record.originalTitle || record.content !== record.originalContent;
}

export function readerDocumentList(): ReaderLocalDocument[] {
	return Object.values(get(readerDocuments)).sort((a, b) => b.updatedAt - a.updatedAt);
}
