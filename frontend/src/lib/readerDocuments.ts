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
const DB_VERSION = 3;
const LEGACY_STORE_NAME = 'documents';
const STORE_NAME = 'documents-v3';
const MIGRATION_STORE_NAME = 'migration-v3';
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
export const readerStorageError = writable<string | null>(null);
export const readerRecoveryAvailable = writable({ legacyDocuments: 0, localSources: 0 });

let hydratePromise: Promise<void> | null = null;
let hydratingScope = '';
let activeScopeId = '';
let scopeEpoch = 0;
let hydratingEpoch = -1;
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

function validScopedLegacyRecord(value: unknown): value is StoredReaderDocument {
	if (!value || typeof value !== 'object') return false;
	const row = value as StoredReaderDocument;
	return row.v === 1 && typeof row.scopeId === 'string' && !!row.scopeId.trim() && row.scopeId !== 'local-default' &&
		typeof row.documentId === 'string' && !!row.documentId && row.storageId === storageId(row.scopeId, row.documentId) &&
		typeof row.title === 'string' && typeof row.content === 'string' && typeof row.originalTitle === 'string' && typeof row.originalContent === 'string' &&
		typeof row.sourceDocKey === 'string' && ['markdown', 'html', 'text', 'code'].includes(row.format) &&
		['local-temp', 'pasted', 'generated', 'chat', 'notes', 'document'].includes(row.source) &&
		['working-copy', 'native'].includes(row.kind) && ['private', 'shared', 'live'].includes(row.shareState) &&
		Number.isSafeInteger(row.revision) && row.revision >= 0 && Number.isSafeInteger(row.storageRevision) && row.storageRevision >= 0 &&
		Number.isFinite(row.updatedAt) && Number.isFinite(row.createdAt) && Array.isArray(row.suggestions) && Array.isArray(row.comments);
}

function openReaderDocumentsDb(): Promise<IDBDatabase | null> {
	if (!browser || typeof indexedDB === 'undefined') {
		readerStorageError.set('Reader storage is unavailable. Keep or download your unsaved writing before leaving.');
		return Promise.resolve(null);
	}
	if (dbPromise) return dbPromise;
	const pending = new Promise<IDBDatabase | null>((resolve) => {
		let abandoned = false;
		const failed = (message: string) => { abandoned = true; readerStorageError.set(message); resolve(null); };
		try {
			const request = indexedDB.open(DB_NAME, DB_VERSION);
			request.onupgradeneeded = (event) => {
				const db = request.result;
				// Never delete or reinterpret the original store: v1 ownership is ambiguous.
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					const migration = db.createObjectStore(MIGRATION_STORE_NAME, { keyPath: 'id' });
					migration.add({ id: 'source-version', version: event.oldVersion });
					const store = db.createObjectStore(STORE_NAME, { keyPath: 'storageId' });
					store.createIndex('scopeId', 'scopeId', { unique: false });
					store.createIndex('sourceDocKey', 'sourceDocKey', { unique: false });
					if (event.oldVersion >= 2 && db.objectStoreNames.contains(LEGACY_STORE_NAME)) {
						const cursor = request.transaction!.objectStore(LEGACY_STORE_NAME).openCursor();
						cursor.onsuccess = () => {
							const entry = cursor.result;
							if (!entry) return;
							if (validScopedLegacyRecord(entry.value)) store.add(entry.value);
							entry.continue();
						};
					}
				}
			};
			request.onsuccess = () => {
				const db = request.result;
				if (abandoned) { db.close(); return; }
				db.onversionchange = () => { db.close(); if (dbPromise === pending) dbPromise = null; };
				db.onclose = () => { if (dbPromise === pending) dbPromise = null; };
				resolve(db);
			};
			request.onerror = () => failed('Reader storage could not be opened. Retry or download recovery sources.');
			request.onblocked = () => failed('Close other Wabi windows, then retry Reader storage. Your older documents remain intact.');
		} catch { failed('Reader storage is unavailable. Download your writing before leaving.'); }
	});
	dbPromise = pending;
	void pending.then(db => { if (!db && dbPromise === pending) dbPromise = null; });
	return pending;
}

async function idbGetScope(scopeId: string): Promise<ReaderLocalDocument[]> {
	const db = await openReaderDocumentsDb();
	if (!db) throw new Error('Reader storage is unavailable. Retry or download your writing before leaving.');
	return new Promise((resolve, reject) => {
		try {
			const tx = db.transaction(STORE_NAME, 'readonly');
			const request = tx.objectStore(STORE_NAME).index('scopeId').getAll(scopeId);
			let rows: ReaderLocalDocument[] = [];
			request.onsuccess = () => { rows = (request.result || []).map(record => fromStored(record as StoredReaderDocument)); };
			tx.oncomplete = () => resolve(rows);
			tx.onerror = tx.onabort = () => reject(new Error('Reader documents could not be read. Your existing writing has been kept.'));
		} catch (error) { reject(error); }
	});
}

/** Raw legacy material is exposed only through an explicit recovery/download action. */
export async function exportReaderRecoverySources(): Promise<string> {
	const capturedScope = activeScopeId, capturedEpoch = scopeEpoch;
	const db = await openReaderDocumentsDb();
	const legacyDocuments = await new Promise<unknown[]>((resolve, reject) => {
		if (!db || !db.objectStoreNames.contains(LEGACY_STORE_NAME)) { resolve([]); return; }
		const hasMetadata = db.objectStoreNames.contains(MIGRATION_STORE_NAME);
		const tx = db.transaction(hasMetadata ? [LEGACY_STORE_NAME, MIGRATION_STORE_NAME] : [LEGACY_STORE_NAME], 'readonly');
		let migratedFrom = 0;
		if (hasMetadata) {
			const metadata = tx.objectStore(MIGRATION_STORE_NAME).get('source-version');
			metadata.onsuccess = () => { migratedFrom = metadata.result?.version ?? 0; };
		}
		const request = tx.objectStore(LEGACY_STORE_NAME).getAll();
		let rows: unknown[] = [];
		request.onsuccess = () => {
			rows = request.result.filter((row: unknown) => {
				if (!row || typeof row !== 'object') return true;
				const owner = (row as { scopeId?: unknown }).scopeId;
				if (typeof owner === 'string' && owner && owner !== 'local-default' && owner !== capturedScope) return false;
				// Valid scoped v2 records were copied atomically; they need no recovery notice.
				return migratedFrom < 2 || !validScopedLegacyRecord(row);
			});
		};
		tx.oncomplete = () => resolve(rows);
		tx.onerror = tx.onabort = () => reject(new Error('Could not read preserved Reader documents.'));
	});
	const localSources: { key: string; raw: string }[] = [];
	// Include earlier key versions too; do not assign their contents to an account.
	for (let index = 0; index < localStorage.length; index++) {
		const key = localStorage.key(index);
		if (!key || !/^wabi:reader:document(?:-recovery)?:v\d+:/.test(key)) continue;
		if (/^wabi:reader:document(?:-recovery)?:v2:/.test(key) && !key.startsWith(`${FALLBACK_PREFIX}${encodeURIComponent(capturedScope)}:`) && !key.startsWith(`${RECOVERY_PREFIX}${encodeURIComponent(capturedScope)}:`)) continue;
		const raw = localStorage.getItem(key);
		if (raw !== null) {
			try {
				const owner = JSON.parse(raw)?.scopeId;
				if (typeof owner === 'string' && owner && owner !== 'local-default' && owner !== capturedScope) continue;
			} catch { /* Malformed source bytes remain available for explicit recovery. */ }
			localSources.push({ key, raw });
		}
	}
	if (capturedScope !== activeScopeId || capturedEpoch !== scopeEpoch) throw new Error('The Reader account changed. Reopen recovery in the intended account.');
	readerRecoveryAvailable.set({ legacyDocuments: legacyDocuments.length, localSources: localSources.length });
	return JSON.stringify({ format: 'wabi-reader-recovery', version: 1, databaseUnavailable: !db, legacyDocuments, localSources }, null, 2);
}

async function refreshRecoveryAvailability(): Promise<void> {
	try { await exportReaderRecoverySources(); } catch { /* The storage error remains visible; no source is removed. */ }
}

export async function retryReaderDocumentStorage(): Promise<void> {
	if (activeScopeId) await hydrateScope(activeScopeId);
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
	readerRecoveryAvailable.set({ legacyDocuments: 0, localSources: 0 });
	readerStorageError.set(null);
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
	const epoch = scopeEpoch;
	if (hydratingScope === scopeId && hydratingEpoch === epoch && hydratePromise) return hydratePromise;
	hydratingScope = scopeId;
	hydratingEpoch = epoch;
	hydratePromise = (async () => {
		const indexed = await idbGetScope(scopeId);
		if (scopeId !== activeScopeId || epoch !== scopeEpoch) return;
		const runtimeStates = get(readerDocumentSaveState);
		const runtimeDrafts = Object.values(get(readerDocuments)).filter(record => record.scopeId === scopeId && ['dirty', 'saving', 'error'].includes(runtimeStates[record.documentId]));
		const runtimeIds = new Set(runtimeDrafts.map(record => record.documentId));
		const recovery = [...Object.values(mergeNewest(readLocalDocuments(RECOVERY_PREFIX, scopeId))), ...runtimeDrafts];
		const committed = mergeNewest(indexed);
		// Old fallback writes were not atomic. They remain available through explicit recovery export, never overlaid on durable documents.
		const merged = { ...committed };
		const recoveredIds = new Set<string>();
		const conflictedIds = new Set<string>();
		for (const pending of recovery) {
			const durable = committed[pending.documentId];
			if (runtimeIds.has(pending.documentId) || !durable || pending.updatedAt >= durable.updatedAt) {
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
		readerStorageError.set(null);
		void refreshRecoveryAvailability();
		void requestReaderPersistentStorage();
	})();
	try {
		await hydratePromise;
	} catch (error) {
		if (scopeId === activeScopeId && epoch === scopeEpoch) {
			readerStorageError.set(get(readerStorageError) || (error instanceof Error ? error.message : 'Reader storage could not be read.'));
			void refreshRecoveryAvailability();
		}
	} finally {
		if (hydratingScope === scopeId && hydratingEpoch === epoch) {
			hydratingScope = '';
			hydratePromise = null;
		}
	}
}

export async function activateReaderDocumentScope(scopeId: string): Promise<void> {
	const normalized = normalizeScopeId(scopeId);
	if (normalized === activeScopeId && get(readerDocumentsHydrated)) return;
	if (activeScopeId !== normalized) {
		scopeEpoch++;
		activeScopeId = normalized;
		readerDocumentScope.set(normalized);
		clearScopeRuntimeState();
		setupBroadcastChannel(normalized);
	}
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

	const result = await idbCompareAndPut(candidate);
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
	// Preserve previous non-atomic fallback sources for explicit recovery.
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
		if (!durableDeleted) {
			setSaveState(documentId, 'error', record.scopeId);
			throw new Error('The document could not be discarded. Its draft and recovery copy were kept.');
		}
		if (record.scopeId !== activeScopeId) return;
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
		if (durableDeleted) broadcastDeleted(record.scopeId, documentId);
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
