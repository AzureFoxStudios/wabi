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
	/** Server + account/device boundary. Documents never cross this scope. */
	scopeId: string;
	/** Monotonic durable-store revision used for cross-window compare-and-swap. */
	storageRevision: number;
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

interface StoredReaderDocument extends ReaderLocalDocument {
	storageId: string;
}

interface PersistSaved {
	status: 'saved';
	record: ReaderLocalDocument;
}

interface PersistConflict {
	status: 'conflict';
	current: ReaderLocalDocument | null;
}

interface PersistUnavailable {
	status: 'unavailable';
}

type PersistResult = PersistSaved | PersistConflict | PersistUnavailable;

const DB_NAME = 'wabi-reader-documents';
const DB_VERSION = 2;
const STORE_NAME = 'documents';
const FALLBACK_PREFIX = 'wabi:reader:document:v2:';
const RECOVERY_PREFIX = 'wabi:reader:document-recovery:v2:';
const SAVE_DEBOUNCE_MS = 120;
const browser = typeof window !== 'undefined';

export const readerDocuments = writable<Record<string, ReaderLocalDocument>>({});
export const readerDocumentsHydrated = writable(false);
export const readerDocumentSaveState = writable<Record<string, ReaderLocalSaveState>>({});
export const readerDocumentConflicts = writable<Record<string, number>>({});
export const readerStoragePersistent = writable<boolean | null>(null);
export const readerDocumentScope = writable('');

let hydratePromise: Promise<void> | null = null;
let hydratingScope = '';
let activeScopeId = '';
let dbPromise: Promise<IDBDatabase | null> | null = null;
let lastTimestamp = 0;
let broadcastChannel: BroadcastChannel | null = null;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const persistChains = new Map<string, Promise<void>>();
const discardingDocuments = new Set<string>();

/** Monotonic per-tab timestamps make newest-write checks deterministic inside one millisecond. */
function now(): number {
	lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
	return lastTimestamp;
}

function randomId(prefix: string): string {
	const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
		? crypto.randomUUID()
		: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	return `${prefix}-${uuid}`;
}

const writerId = randomId('writer');

function normalizeScopeId(scopeId: string | null | undefined): string {
	return String(scopeId || '').trim() || 'local-default';
}

function normalizeDocument(record: ReaderLocalDocument): ReaderLocalDocument {
	return {
		...record,
		v: 1,
		scopeId: normalizeScopeId(record.scopeId),
		storageRevision: Number.isFinite(record.storageRevision) ? Math.max(0, Math.floor(record.storageRevision)) : 0,
		kind: record.kind === 'native' ? 'native' : 'working-copy',
		shareState: record.shareState === 'shared' || record.shareState === 'live' ? record.shareState : 'private',
		revision: Number.isFinite(record.revision) ? Math.max(0, record.revision) : 0,
		suggestions: Array.isArray(record.suggestions) ? record.suggestions : [],
		comments: Array.isArray(record.comments) ? record.comments : []
	};
}

function storageId(scopeId: string, documentId: string): string {
	return `${encodeURIComponent(scopeId)}::${documentId}`;
}

function runtimeKey(scopeId: string, documentId: string): string {
	return `${scopeId}\u0000${documentId}`;
}

function storageKey(prefix: string, scopeId: string, documentId: string): string {
	return `${prefix}${encodeURIComponent(scopeId)}:${documentId}`;
}

function recoveryStorageKey(scopeId: string, documentId: string): string {
	return `${RECOVERY_PREFIX}${encodeURIComponent(scopeId)}:${documentId}:${writerId}`;
}

function toStored(record: ReaderLocalDocument): StoredReaderDocument {
	return { ...record, storageId: storageId(record.scopeId, record.documentId) };
}

function fromStored(record: StoredReaderDocument | ReaderLocalDocument): ReaderLocalDocument {
	const { storageId: _storageId, ...document } = record as StoredReaderDocument;
	return normalizeDocument(document);
}

function setSaveState(documentId: string, state: ReaderLocalSaveState, scopeId = activeScopeId): void {
	if (scopeId !== activeScopeId) return;
	readerDocumentSaveState.update((current) => ({ ...current, [documentId]: state }));
}

function setConflict(documentId: string, remoteRevision: number | null, scopeId = activeScopeId): void {
	if (scopeId !== activeScopeId) return;
	readerDocumentConflicts.update((current) => {
		const next = { ...current };
		if (remoteRevision === null) delete next[documentId];
		else next[documentId] = remoteRevision;
		return next;
	});
}

function safeLocalGet(key: string): string | null {
	if (!browser) return null;
	try { return localStorage.getItem(key); }
	catch { return null; }
}

function safeLocalSet(key: string, value: string): boolean {
	if (!browser) return false;
	try {
		localStorage.setItem(key, value);
		return true;
	} catch {
		return false;
	}
}

function safeLocalRemove(key: string): void {
	if (!browser) return;
	try { localStorage.removeItem(key); }
	catch { /* best effort */ }
}

function readLocalDocuments(prefix: string, scopeId: string): ReaderLocalDocument[] {
	if (!browser) return [];
	const records: ReaderLocalDocument[] = [];
	const scopedPrefix = `${prefix}${encodeURIComponent(scopeId)}:`;
	try {
		for (let index = 0; index < localStorage.length; index += 1) {
			const key = localStorage.key(index);
			if (!key?.startsWith(scopedPrefix)) continue;
			const raw = localStorage.getItem(key);
			if (!raw) continue;
			try {
				const parsed = normalizeDocument(JSON.parse(raw) as ReaderLocalDocument);
				if (parsed.documentId && parsed.scopeId === scopeId) records.push(parsed);
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
				if (db.objectStoreNames.contains(STORE_NAME)) db.deleteObjectStore(STORE_NAME);
				const store = db.createObjectStore(STORE_NAME, { keyPath: 'storageId' });
				store.createIndex('scopeId', 'scopeId', { unique: false });
				store.createIndex('sourceDocKey', 'sourceDocKey', { unique: false });
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

async function idbGetScope(scopeId: string): Promise<ReaderLocalDocument[]> {
	const db = await openReaderDocumentsDb();
	if (!db) return [];
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(STORE_NAME, 'readonly');
			const store = tx.objectStore(STORE_NAME);
			const index = store.index('scopeId');
			const request = index.getAll(scopeId);
			request.onsuccess = () => resolve((request.result || []).map((record) => fromStored(record as StoredReaderDocument)));
			request.onerror = () => resolve([]);
		} catch {
			resolve([]);
		}
	});
}

async function idbCompareAndPut(record: ReaderLocalDocument): Promise<PersistResult> {
	const db = await openReaderDocumentsDb();
	if (!db) return { status: 'unavailable' };
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(STORE_NAME, 'readwrite');
			const store = tx.objectStore(STORE_NAME);
			const id = storageId(record.scopeId, record.documentId);
			let outcome: PersistResult = { status: 'unavailable' };
			const request = store.get(id);
			request.onsuccess = () => {
				const current = request.result ? fromStored(request.result as StoredReaderDocument) : null;
				const currentRevision = current?.storageRevision ?? 0;
				const exists = Boolean(current);
				if ((exists && currentRevision !== record.storageRevision) || (!exists && record.storageRevision !== 0)) {
					outcome = { status: 'conflict', current };
					return;
				}
				const saved: ReaderLocalDocument = {
					...record,
					storageRevision: currentRevision + 1,
					lastLocalSaveAt: now()
				};
				outcome = { status: 'saved', record: saved };
				store.put(toStored(saved));
			};
			tx.oncomplete = () => resolve(outcome);
			tx.onerror = () => resolve({ status: 'unavailable' });
			tx.onabort = () => resolve({ status: 'unavailable' });
		} catch {
			resolve({ status: 'unavailable' });
		}
	});
}

async function idbCompareAndDelete(record: ReaderLocalDocument): Promise<boolean> {
	const db = await openReaderDocumentsDb();
	if (!db) return false;
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(STORE_NAME, 'readwrite');
			const store = tx.objectStore(STORE_NAME);
			const id = storageId(record.scopeId, record.documentId);
			let deleted = false;
			const request = store.get(id);
			request.onsuccess = () => {
				const current = request.result ? fromStored(request.result as StoredReaderDocument) : null;
				if (!current) {
					deleted = true;
					return;
				}
				if (current.storageRevision !== record.storageRevision) return;
				store.delete(id);
				deleted = true;
			};
			tx.oncomplete = () => resolve(deleted);
			tx.onerror = () => resolve(false);
			tx.onabort = () => resolve(false);
		} catch {
			resolve(false);
		}
	});
}

function fallbackCompareAndPut(record: ReaderLocalDocument): PersistResult {
	const key = storageKey(FALLBACK_PREFIX, record.scopeId, record.documentId);
	const raw = safeLocalGet(key);
	let current: ReaderLocalDocument | null = null;
	if (raw) {
		try { current = normalizeDocument(JSON.parse(raw) as ReaderLocalDocument); }
		catch { current = null; }
	}
	const currentRevision = current?.storageRevision ?? 0;
	if ((current && currentRevision !== record.storageRevision) || (!current && record.storageRevision !== 0)) {
		return { status: 'conflict', current };
	}
	const saved: ReaderLocalDocument = {
		...record,
		storageRevision: currentRevision + 1,
		lastLocalSaveAt: now()
	};
	return safeLocalSet(key, JSON.stringify(saved))
		? { status: 'saved', record: saved }
		: { status: 'unavailable' };
}

function fallbackCompareAndDelete(record: ReaderLocalDocument): boolean {
	const key = storageKey(FALLBACK_PREFIX, record.scopeId, record.documentId);
	const raw = safeLocalGet(key);
	if (!raw) return true;
	try {
		const current = normalizeDocument(JSON.parse(raw) as ReaderLocalDocument);
		if (current.storageRevision !== record.storageRevision) return false;
	} catch {
		return false;
	}
	safeLocalRemove(key);
	return true;
}

function mergeNewest(records: ReaderLocalDocument[]): Record<string, ReaderLocalDocument> {
	const merged: Record<string, ReaderLocalDocument> = {};
	for (const record of records) {
		const normalized = normalizeDocument(record);
		const existing = merged[normalized.documentId];
		if (!existing || normalized.updatedAt > existing.updatedAt ||
			(normalized.updatedAt === existing.updatedAt && normalized.storageRevision > existing.storageRevision)) {
			merged[normalized.documentId] = normalized;
		}
	}
	return merged;
}

export function shouldFinalizeReaderDocumentSave(
	current: ReaderLocalDocument | null | undefined,
	persisted: ReaderLocalDocument
): boolean {
	return Boolean(current && current.documentId === persisted.documentId && current.updatedAt === persisted.updatedAt);
}

export function hasReaderDocumentWriteConflict(
	currentStorageRevision: number | null | undefined,
	candidateStorageRevision: number
): boolean {
	return currentStorageRevision !== null && currentStorageRevision !== undefined &&
		currentStorageRevision !== candidateStorageRevision;
}

function closeBroadcastChannel(): void {
	try { broadcastChannel?.close(); }
	catch { /* best effort */ }
	broadcastChannel = null;
}

function setupBroadcastChannel(scopeId: string): void {
	closeBroadcastChannel();
	if (!browser || typeof BroadcastChannel === 'undefined') return;
	try {
		broadcastChannel = new BroadcastChannel(`wabi-reader-documents:${scopeId}`);
		broadcastChannel.onmessage = (event: MessageEvent) => {
			const payload = event.data as { type?: string; scopeId?: string; record?: ReaderLocalDocument; documentId?: string };
			if (payload?.scopeId !== activeScopeId) return;
			if (payload.type === 'saved' && payload.record) {
				const incoming = normalizeDocument(payload.record);
				const local = get(readerDocuments)[incoming.documentId];
				const state = get(readerDocumentSaveState)[incoming.documentId];
				if (state === 'dirty' || state === 'saving' || state === 'error') return;
				if (!local || incoming.storageRevision > local.storageRevision) {
					readerDocuments.update((documents) => ({ ...documents, [incoming.documentId]: incoming }));
					setSaveState(incoming.documentId, 'saved');
					setConflict(incoming.documentId, null);
				}
			}
			if (payload.type === 'deleted' && payload.documentId) {
				const state = get(readerDocumentSaveState)[payload.documentId];
				if (state === 'dirty' || state === 'saving' || state === 'error') return;
				readerDocuments.update((documents) => {
					const next = { ...documents };
					delete next[payload.documentId!];
					return next;
				});
			}
		};
	} catch {
		broadcastChannel = null;
	}
}

function broadcastSaved(record: ReaderLocalDocument): void {
	try { broadcastChannel?.postMessage({ type: 'saved', scopeId: record.scopeId, record }); }
	catch { /* best effort */ }
}

function broadcastDeleted(scopeId: string, documentId: string): void {
	try { broadcastChannel?.postMessage({ type: 'deleted', scopeId, documentId }); }
	catch { /* best effort */ }
}

function clearScopeRuntimeState(): void {
	for (const timer of saveTimers.values()) clearTimeout(timer);
	saveTimers.clear();
	readerDocuments.set({});
	readerDocumentSaveState.set({});
	readerDocumentConflicts.set({});
	readerDocumentsHydrated.set(false);
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

async function hydrateScope(scopeId: string): Promise<void> {
	if (hydratingScope === scopeId && hydratePromise) return hydratePromise;
	hydratingScope = scopeId;
	hydratePromise = (async () => {
		const [indexed, fallback] = await Promise.all([
			idbGetScope(scopeId),
			Promise.resolve(readLocalDocuments(FALLBACK_PREFIX, scopeId))
		]);
		if (scopeId !== activeScopeId) return;
		const recovery = Object.values(mergeNewest(readLocalDocuments(RECOVERY_PREFIX, scopeId)));
		const committed = mergeNewest([...indexed, ...fallback]);
		const merged = { ...committed };
		const recoveredIds = new Set<string>();
		const conflictedIds = new Set<string>();
		for (const pending of recovery) {
			const durable = committed[pending.documentId];
			if (!durable || pending.updatedAt >= durable.updatedAt) {
				merged[pending.documentId] = pending;
				recoveredIds.add(pending.documentId);
				if (durable && pending.storageRevision !== durable.storageRevision) conflictedIds.add(pending.documentId);
			}
		}
		readerDocuments.set(merged);
		const states: Record<string, ReaderLocalSaveState> = {};
		const conflicts: Record<string, number> = {};
		for (const document of Object.values(merged)) {
			states[document.documentId] = recoveredIds.has(document.documentId)
				? (conflictedIds.has(document.documentId) ? 'error' : 'dirty')
				: 'saved';
			if (conflictedIds.has(document.documentId)) conflicts[document.documentId] = committed[document.documentId]?.storageRevision || 0;
		}
		readerDocumentSaveState.set(states);
		readerDocumentConflicts.set(conflicts);
		readerDocumentsHydrated.set(true);
		void requestReaderPersistentStorage();
	})();
	try {
		await hydratePromise;
	} finally {
		if (hydratingScope === scopeId) {
			hydratingScope = '';
			hydratePromise = null;
		}
	}
}

export async function activateReaderDocumentScope(scopeId: string): Promise<void> {
	const normalized = normalizeScopeId(scopeId);
	if (normalized === activeScopeId && get(readerDocumentsHydrated)) return;
	activeScopeId = normalized;
	readerDocumentScope.set(normalized);
	clearScopeRuntimeState();
	setupBroadcastChannel(normalized);
	await hydrateScope(normalized);
}

export async function hydrateReaderDocuments(): Promise<void> {
	if (!activeScopeId) await activateReaderDocumentScope('local-default');
	else if (!get(readerDocumentsHydrated)) await hydrateScope(activeScopeId);
}

export function readerWorkingCopyDocumentId(selection: ReaderDocumentSelection): string {
	const sourceDocKey = selection.sourceDocKey || selection.docKey;
	return `wdoc-local-${encodeURIComponent(sourceDocKey)}`;
}

export function createReaderDocumentRecord(
	selection: ReaderDocumentSelection,
	documentId = randomId('wdoc'),
	createdAt = now(),
	scopeId = activeScopeId || 'local-default'
): ReaderLocalDocument {
	return {
		v: 1,
		scopeId: normalizeScopeId(scopeId),
		storageRevision: 0,
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

async function persistSnapshot(record: ReaderLocalDocument): Promise<void> {
	const key = runtimeKey(record.scopeId, record.documentId);
	if (discardingDocuments.has(key)) return;
	const live = record.scopeId === activeScopeId ? get(readerDocuments)[record.documentId] : null;
	const expectedRevision = live && live.updatedAt >= record.updatedAt
		? Math.max(record.storageRevision, live.storageRevision)
		: record.storageRevision;
	const candidate: ReaderLocalDocument = { ...record, storageRevision: expectedRevision };
	if (live && live.updatedAt <= record.updatedAt) setSaveState(record.documentId, 'saving', record.scopeId);

	let result = await idbCompareAndPut(candidate);
	if (result.status === 'unavailable') result = fallbackCompareAndPut(candidate);
	if (discardingDocuments.has(key)) return;

	if (result.status === 'conflict') {
		setSaveState(record.documentId, 'error', record.scopeId);
		setConflict(record.documentId, result.current?.storageRevision ?? 0, record.scopeId);
		return;
	}
	if (result.status !== 'saved') {
		setSaveState(record.documentId, 'error', record.scopeId);
		return;
	}

	const saved = result.record;
	safeLocalRemove(storageKey(FALLBACK_PREFIX, saved.scopeId, saved.documentId));
	broadcastSaved(saved);
	if (saved.scopeId !== activeScopeId) return;
	const current = get(readerDocuments)[saved.documentId];
	if (!shouldFinalizeReaderDocumentSave(current, record)) {
		if (current) {
			readerDocuments.update((documents) => {
				const latest = documents[saved.documentId];
				if (!latest || latest.updatedAt < record.updatedAt) return documents;
				return {
					...documents,
					[saved.documentId]: {
						...latest,
						storageRevision: Math.max(latest.storageRevision, saved.storageRevision),
						lastLocalSaveAt: saved.lastLocalSaveAt
					}
				};
			});
			setSaveState(saved.documentId, 'dirty');
		}
		return;
	}
	readerDocuments.update((documents) => {
		const latest = documents[saved.documentId];
		if (!shouldFinalizeReaderDocumentSave(latest, record)) return documents;
		return { ...documents, [saved.documentId]: saved };
	});
	safeLocalRemove(recoveryStorageKey(saved.scopeId, saved.documentId));
	setConflict(saved.documentId, null);
	setSaveState(saved.documentId, 'saved');
}

function enqueuePersist(record: ReaderLocalDocument): Promise<void> {
	const key = runtimeKey(record.scopeId, record.documentId);
	const previous = persistChains.get(key) || Promise.resolve();
	const next = previous.catch(() => {}).then(() => persistSnapshot(record));
	persistChains.set(key, next);
	void next.finally(() => {
		if (persistChains.get(key) === next) persistChains.delete(key);
	});
	return next;
}

function schedulePersist(record: ReaderLocalDocument): void {
	const key = runtimeKey(record.scopeId, record.documentId);
	if (discardingDocuments.has(key)) return;
	const mirrored = safeLocalSet(recoveryStorageKey(record.scopeId, record.documentId), JSON.stringify(record));
	setSaveState(record.documentId, mirrored || typeof indexedDB !== 'undefined' ? 'dirty' : 'error', record.scopeId);
	const existing = saveTimers.get(key);
	if (existing) clearTimeout(existing);
	saveTimers.set(key, setTimeout(() => {
		saveTimers.delete(key);
		void enqueuePersist(record).catch(() => setSaveState(record.documentId, 'error', record.scopeId));
	}, SAVE_DEBOUNCE_MS));
}

export async function flushReaderDocument(documentId: string): Promise<void> {
	const record = get(readerDocuments)[documentId];
	if (!record) return;
	const key = runtimeKey(record.scopeId, documentId);
	const timer = saveTimers.get(key);
	if (timer) {
		clearTimeout(timer);
		saveTimers.delete(key);
	}
	if (discardingDocuments.has(key)) return;
	safeLocalSet(recoveryStorageKey(record.scopeId, documentId), JSON.stringify(record));
	try {
		await enqueuePersist(record);
	} catch {
		setSaveState(documentId, 'error', record.scopeId);
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
		selection.documentId || readerWorkingCopyDocumentId(selection)
	);
	readerDocuments.update((current) => ({ ...current, [document.documentId]: document }));
	safeLocalSet(recoveryStorageKey(document.scopeId, document.documentId), JSON.stringify(document));
	await enqueuePersist(document);
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
	const next: ReaderLocalDocument = { ...record, comments, updatedAt: timestamp };
	readerDocuments.update((current) => ({ ...current, [documentId]: next }));
	schedulePersist(next);
}

export function removeReaderDocumentComment(documentId: string, commentId: string): void {
	const record = get(readerDocuments)[documentId];
	if (!record) return;
	const next: ReaderLocalDocument = {
		...record,
		comments: record.comments.filter((comment) => comment.id !== commentId),
		updatedAt: now()
	};
	readerDocuments.update((current) => ({ ...current, [documentId]: next }));
	schedulePersist(next);
}

export async function discardReaderDocument(documentId: string): Promise<void> {
	const record = get(readerDocuments)[documentId];
	if (!record) return;
	const key = runtimeKey(record.scopeId, documentId);
	const timer = saveTimers.get(key);
	if (timer) {
		clearTimeout(timer);
		saveTimers.delete(key);
	}
	discardingDocuments.add(key);
	try {
		const inFlight = persistChains.get(key);
		if (inFlight) await inFlight.catch(() => {});
		const durableDeleted = await idbCompareAndDelete(record);
		const fallbackDeleted = fallbackCompareAndDelete(record);
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
		setConflict(documentId, null, record.scopeId);
		safeLocalRemove(recoveryStorageKey(record.scopeId, documentId));
		if (durableDeleted || fallbackDeleted) broadcastDeleted(record.scopeId, documentId);
	} finally {
		discardingDocuments.delete(key);
		persistChains.delete(key);
	}
}

export function isReaderDocumentChanged(record: ReaderLocalDocument): boolean {
	return record.title !== record.originalTitle || record.content !== record.originalContent;
}

export function readerDocumentList(): ReaderLocalDocument[] {
	return Object.values(get(readerDocuments)).sort((a, b) => b.updatedAt - a.updatedAt);
}
