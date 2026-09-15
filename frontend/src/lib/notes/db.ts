import { normalizeNoteTitle, parseNoteLinks, renameNoteLinks } from './links';
import { NotebookError, type NotebookNote, type NotebookLink, type NotebookOwner, type NotePatch, type RecoveredNoteDraft } from './types';
import { legacyNotesFingerprint, previewLegacyNotes } from './migration';
import { parseNotebookBackup, type NotebookBackup } from './backup';

const DATABASE = 'wabi-local-notes';
const VERSION = 3;
const STORES = ['notes', 'links'] as const;
let connection: Promise<IDBDatabase> | undefined;

function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		value.onsuccess = () => resolve(value.result);
		value.onerror = () => reject(value.error);
	});
}

/** Additive upgrades only. Incompatible future records must have a migration. */
export function openNotebookDatabase(): Promise<IDBDatabase> {
	if (connection) return connection;
	const pending = new Promise<IDBDatabase>((resolve, reject) => {
		if (typeof indexedDB === 'undefined') {
			reject(new NotebookError('unavailable', 'Local note storage is unavailable.'));
			return;
		}
		let abandoned = false;
		const opening = indexedDB.open(DATABASE, VERSION);
		opening.onupgradeneeded = () => {
			const db = opening.result;
			if (!db.objectStoreNames.contains('notes')) {
				const notes = db.createObjectStore('notes', { keyPath: ['scopeId', 'id'] });
				notes.createIndex('scope', 'scopeId');
				notes.createIndex('title', ['scopeId', 'normalizedTitle'], { unique: true });
			}
			if (!db.objectStoreNames.contains('links')) {
				const links = db.createObjectStore('links', { keyPath: ['scopeId', 'sourceId', 'normalizedTitle'] });
				links.createIndex('source', ['scopeId', 'sourceId']);
				links.createIndex('target', ['scopeId', 'targetId']);
				links.createIndex('title', ['scopeId', 'normalizedTitle']);
			}
			const recovery = db.objectStoreNames.contains('recovery') ? opening.transaction!.objectStore('recovery') : db.createObjectStore('recovery', { keyPath: 'id' });
			if (!recovery.indexNames.contains('scope')) recovery.createIndex('scope', 'scopeId');
			if (!db.objectStoreNames.contains('migrationReceipts')) db.createObjectStore('migrationReceipts', { keyPath: 'fingerprint' });
			if (!db.objectStoreNames.contains('profileNotes')) db.createObjectStore('profileNotes', { keyPath: ['scopeId', 'subjectId'] });
			if (!db.objectStoreNames.contains('notebookSettings')) db.createObjectStore('notebookSettings', { keyPath: 'scopeId' });
		};
		opening.onblocked = () => {
			abandoned = true;
			reject(new NotebookError('unavailable', 'Close other Wabi windows, then retry local note storage.'));
		};
		opening.onerror = () => reject(opening.error ?? new NotebookError('unavailable', 'Could not open local note storage.'));
		opening.onsuccess = () => {
			const db = opening.result;
			if (abandoned) { db.close(); return; }
			db.onversionchange = () => { db.close(); connection = undefined; };
			db.onclose = () => { connection = undefined; };
			resolve(db);
		};
	});
	connection = pending;
	void pending.catch(() => { if (connection === pending) connection = undefined; });
	return pending;
}

function assertOwner(owner: NotebookOwner): void {
	if (!owner.scopeId || !owner.isCurrent()) throw new NotebookError('retired', 'This notebook session has ended. Your draft belongs to the original account.');
}

async function transaction<T>(owner: NotebookOwner, mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>, extraStores: string[] = []): Promise<T> {
	assertOwner(owner);
	const db = await openNotebookDatabase();
	assertOwner(owner);
	const tx = db.transaction([...STORES, ...extraStores], mode);
	const complete = new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error ?? new NotebookError('unavailable', 'The local note transaction was interrupted.'));
		tx.onerror = () => { /* onabort is the final transaction outcome */ };
	});
	// Handle a rejected transaction even while the work is awaiting a request.
	void complete.catch(() => {});
	try {
		const result = await work(tx);
		assertOwner(owner);
		await complete;
		assertOwner(owner);
		return result;
	} catch (error) {
		try { tx.abort(); } catch { /* already completed/aborted */ }
		await complete.catch(() => {});
		throw error;
	}
}

function checkedTitle(title: string): { title: string; normalizedTitle: string } {
	const display = title.normalize('NFKC').replace(/\s+/gu, ' ').trim();
	if (!display || display.length > 200 || /[\[\]|\u0000-\u001f]/u.test(display)) {
		throw new NotebookError('invalid', 'Use a title of 1–200 characters without brackets, pipes or control characters.');
	}
	return { title: display, normalizedTitle: normalizeNoteTitle(display) };
}

function checkedText(text: string): string {
	if (typeof text !== 'string' || text.length > 2_000_000) throw new NotebookError('invalid', 'A note can contain up to two million characters.');
	return text;
}

async function syncLinks(tx: IDBTransaction, note: NotebookNote): Promise<void> {
	const links = tx.objectStore('links');
	const existing = await request(links.index('source').getAll([note.scopeId, note.id])) as NotebookLink[];
	const previous = new Map(existing.map(link => [link.normalizedTitle, link]));
	const titles = new Set(parseNoteLinks(note.text).map(link => link.normalizedTitle));
	for (const old of existing) {
		if (!titles.has(old.normalizedTitle)) await request(links.delete([old.scopeId, old.sourceId, old.normalizedTitle]));
	}
	for (const normalizedTitle of titles) {
		// Keep UUID bindings even after deletion and title reuse.
		if (previous.has(normalizedTitle)) continue;
		const target = await request(tx.objectStore('notes').index('title').get([note.scopeId, normalizedTitle])) as NotebookNote | undefined;
		await request(links.put({ scopeId: note.scopeId, sourceId: note.id, normalizedTitle, targetId: target?.id ?? null } satisfies NotebookLink));
	}
}

async function resolveNewTitle(tx: IDBTransaction, note: NotebookNote): Promise<void> {
	const links = tx.objectStore('links');
	const unresolved = await request(links.index('title').getAll([note.scopeId, note.normalizedTitle])) as NotebookLink[];
	for (const link of unresolved) if (link.targetId === null) await request(links.put({ ...link, targetId: note.id }));
}

async function requireRevision(tx: IDBTransaction, scopeId: string, id: string, revision: number): Promise<NotebookNote> {
	const note = await request(tx.objectStore('notes').get([scopeId, id])) as NotebookNote | undefined;
	if (!note) throw new NotebookError('missing', 'This note no longer exists. Save your draft as a new note.');
	if (note.revision !== revision) throw new NotebookError('conflict', 'Another editor changed this note. Your draft has been kept.');
	return note;
}

async function uniqueTitle(tx: IDBTransaction, scopeId: string, normalizedTitle: string, id: string): Promise<void> {
	const match = await request(tx.objectStore('notes').index('title').get([scopeId, normalizedTitle])) as NotebookNote | undefined;
	if (match && match.id !== id) throw new NotebookError('title-taken', 'A note already uses this title, including notes in Trash.');
}

/** Every write is scoped, revision-checked, and acknowledged only after commit. */
export class LocalNotebook {
	constructor(readonly owner: NotebookOwner) {}

	exportBackup(): Promise<NotebookBackup> {
		return transaction(this.owner, 'readonly', async tx => {
			const notes = await request(tx.objectStore('notes').index('scope').getAll(this.owner.scopeId)) as NotebookNote[];
			const links: NotebookLink[] = [];
			for (const note of notes) links.push(...await request(tx.objectStore('links').index('source').getAll([note.scopeId, note.id])));
			return { format: 'wabi-local-notebook', version: 1, sourceScopeId: this.owner.scopeId, exportedAt: Date.now(), notes, links };
		});
	}
	async importBackup(raw: string): Promise<{ noteIds: string[]; alreadyImported: boolean }> {
		const backup = parseNotebookBackup(raw);
		const fingerprint = `backup:${this.owner.scopeId}:${await legacyNotesFingerprint('notebook-backup:v1', raw)}`;
		return transaction(this.owner, 'readwrite', async tx => {
			const receipts = tx.objectStore('migrationReceipts');
			const previous = await request(receipts.get(fingerprint));
			if (previous) return { noteIds: previous.noteIds, alreadyImported: true };
			const scopeId = this.owner.scopeId, store = tx.objectStore('notes');
			const idMap = new Map<string, string>();
			const imported = new Map<string, NotebookNote>();
			const reservedIds = new Set(backup.notes.map(note => note.id));
			const freshId = () => { let id = crypto.randomUUID(); while (reservedIds.has(id)) id = crypto.randomUUID(); reservedIds.add(id); return id; };
			for (const source of backup.notes) {
				const id = await request(store.get([scopeId, source.id])) ? freshId() : source.id;
				idMap.set(source.id, id);
				let title = source.title, suffix = 2;
				while (await request(store.index('title').get([scopeId, normalizeNoteTitle(title)]))) title = `${source.title.slice(0, 180)} (${suffix++})`;
				const note: NotebookNote = { schemaVersion: 1, scopeId, id, ...checkedTitle(title), text: source.text, revision: 1, createdAt: source.createdAt, updatedAt: source.updatedAt, trashedAt: source.trashedAt, pinned: source.pinned, ...(source.color ? { color: source.color } : {}), ...(source.contextChannelId && backup.sourceScopeId === scopeId ? { contextChannelId: source.contextChannelId } : {}), importedFrom: { id: source.id, revision: source.revision, scopeId: backup.sourceScopeId } };
				await request(store.add(note)); imported.set(source.id, note);
			}
			for (const link of backup.links) {
				const source = imported.get(link.sourceId)!;
				const target = link.targetId ? imported.get(link.targetId) : undefined;
				let normalizedTitle = link.normalizedTitle;
				if (target && target.normalizedTitle !== normalizedTitle) {
					normalizedTitle = target.normalizedTitle;
				}
				if (link.targetId && !idMap.has(link.targetId)) idMap.set(link.targetId, freshId());
				// Missing UUIDs stay missing, even if another notebook has that UUID.
				const targetId = link.targetId ? idMap.get(link.targetId)! : null;
				const overlap = await request(tx.objectStore('links').get([scopeId, source.id, normalizedTitle])) as NotebookLink | undefined;
				if (overlap && overlap.targetId !== targetId) throw new NotebookError('invalid', 'Renaming imported titles would merge different link identities. Import into a separate notebook or rename the conflicting destination notes first.');
				await request(tx.objectStore('links').put({ scopeId, sourceId: source.id, normalizedTitle, targetId } satisfies NotebookLink));
			}
			for (const [originalId, note] of imported) {
				const targets = new Map(backup.links.filter(link => link.sourceId === originalId).map(link => [link.normalizedTitle, link.targetId ? imported.get(link.targetId) : undefined]));
				let position = 0;
				const pieces: string[] = [];
				for (const link of parseNoteLinks(note.text)) {
					const target = targets.get(link.normalizedTitle);
					if (!target || target.normalizedTitle === link.normalizedTitle) continue;
					pieces.push(note.text.slice(position, link.from), `[[${target.title}${link.label === undefined ? '' : `|${link.label}`}]]`);
					position = link.to;
				}
				pieces.push(note.text.slice(position)); note.text = pieces.join('');
				await request(store.put(note)); await resolveNewTitle(tx, note);
			}
			const noteIds = [...imported.values()].map(note => note.id);
			await request(receipts.add({ fingerprint, scopeId, noteIds, importedAt: Date.now(), schemaVersion: 1 }));
			return { noteIds, alreadyImported: false };
		}, ['migrationReceipts']);
	}

	keepDraft(draft: Omit<RecoveredNoteDraft, 'scopeId' | 'kind' | 'updatedAt'>): Promise<void> {
		return transaction(this.owner, 'readwrite', async tx => {
			await request(tx.objectStore('recovery').put({ ...draft, id: `draft:${this.owner.scopeId}:${draft.id}`, scopeId: this.owner.scopeId, kind: 'draft', text: checkedText(draft.text), updatedAt: Date.now() }));
		}, ['recovery']);
	}
	listRecoveredDrafts(): Promise<RecoveredNoteDraft[]> {
		return transaction(this.owner, 'readonly', async tx => {
			const rows = await request(tx.objectStore('recovery').index('scope').getAll(this.owner.scopeId));
			return rows.filter((row: { kind: string }) => row.kind === 'draft');
		}, ['recovery']);
	}
	removeRecoveredDraft(id: string): Promise<void> {
		return transaction(this.owner, 'readwrite', async tx => {
			const record = await request(tx.objectStore('recovery').get(id));
			if (record?.scopeId === this.owner.scopeId && record.kind === 'draft') await request(tx.objectStore('recovery').delete(id));
		}, ['recovery']);
	}

	getScratchpad(): Promise<NotebookNote> {
		return transaction(this.owner, 'readwrite', async tx => {
			const scopeId = this.owner.scopeId;
			const settings = tx.objectStore('notebookSettings');
			const saved = await request(settings.get(scopeId)) as { scratchpadId?: string } | undefined;
			const notes = tx.objectStore('notes');
			const previous = saved?.scratchpadId ? await request(notes.get([scopeId, saved.scratchpadId])) as NotebookNote | undefined : undefined;
			if (previous && previous.trashedAt === null) return previous;
			let title = 'Scratchpad', suffix = 2;
			while (await request(notes.index('title').get([scopeId, normalizeNoteTitle(title)]))) title = `Scratchpad ${suffix++}`;
			const note: NotebookNote = { schemaVersion: 1, scopeId, id: crypto.randomUUID(), ...checkedTitle(title), text: '', revision: 1, createdAt: Date.now(), updatedAt: Date.now(), trashedAt: null, pinned: false };
			await request(notes.add(note));
			await request(settings.put({ ...saved, scopeId, scratchpadId: note.id }));
			await resolveNewTitle(tx, note);
			return note;
		}, ['notebookSettings']);
	}

	/** Call only after the user explicitly chooses this destination notebook. */
	async importLegacy(key: string, raw: string): Promise<{ noteIds: string[]; alreadyImported: boolean; issues: string[] }> {
		assertOwner(this.owner);
		const preview = previewLegacyNotes(key, raw);
		if (preview.kind === 'profile') throw new NotebookError('invalid', 'Profile notes require a separate person mapping.');
		if (raw.length > 10_000_000) throw new NotebookError('invalid', preview.issues[0]);
		const fingerprint = await legacyNotesFingerprint(key, raw);
		return transaction(this.owner, 'readwrite', async tx => {
			const receipts = tx.objectStore('migrationReceipts');
			const previous = await request(receipts.get(fingerprint)) as { scopeId: string; noteIds: string[] } | undefined;
			if (previous) {
				if (previous.scopeId !== this.owner.scopeId) throw new NotebookError('conflict', 'This legacy source was already recovered into another notebook. Export from that notebook to transfer it explicitly.');
				return { noteIds: previous.noteIds, alreadyImported: true, issues: preview.issues };
			}
			await request(tx.objectStore('recovery').put({ id: `legacy:${fingerprint}`, scopeId: this.owner.scopeId, kind: 'legacy', key, raw, issues: preview.issues, createdAt: Date.now() }));
			const notes = tx.objectStore('notes');
			const noteIds: string[] = [];
			for (const row of preview.rows) {
				let title = row.title;
				let suffix = 2;
				while (await request(notes.index('title').get([this.owner.scopeId, normalizeNoteTitle(title)]))) title = `${row.title} (${suffix++})`;
				const now = Date.now();
				const note: NotebookNote = { schemaVersion: 1, scopeId: this.owner.scopeId, id: crypto.randomUUID(), ...checkedTitle(title), text: row.text, revision: 1, createdAt: row.createdAt ?? now, updatedAt: row.updatedAt ?? now, trashedAt: null, pinned: row.pinned ?? false, ...(row.color ? { color: row.color } : {}) };
				// Unknown legacy channel IDs deliberately remain detached.
				await request(notes.add(note));
				await syncLinks(tx, note);
				await resolveNewTitle(tx, note);
				noteIds.push(note.id);
			}
			await request(receipts.add({ fingerprint, scopeId: this.owner.scopeId, noteIds, importedAt: Date.now(), schemaVersion: 1 }));
			return { noteIds, alreadyImported: false, issues: preview.issues };
		}, ['recovery', 'migrationReceipts']);
	}

	list(): Promise<NotebookNote[]> {
		return transaction(this.owner, 'readonly', async tx => request(tx.objectStore('notes').index('scope').getAll(this.owner.scopeId)));
	}
	get(id: string): Promise<NotebookNote | undefined> {
		return transaction(this.owner, 'readonly', async tx => request(tx.objectStore('notes').get([this.owner.scopeId, id])));
	}
	outgoing(id: string): Promise<NotebookLink[]> {
		return transaction(this.owner, 'readonly', async tx => request(tx.objectStore('links').index('source').getAll([this.owner.scopeId, id])));
	}
	backlinks(id: string): Promise<NotebookLink[]> {
		return transaction(this.owner, 'readonly', async tx => request(tx.objectStore('links').index('target').getAll([this.owner.scopeId, id])));
	}
	create(title: string, text = '', contextChannelId?: string): Promise<NotebookNote> {
		const note: NotebookNote = { schemaVersion: 1, scopeId: this.owner.scopeId, id: crypto.randomUUID(), ...checkedTitle(title), text: checkedText(text), revision: 1, createdAt: Date.now(), updatedAt: Date.now(), trashedAt: null, pinned: false, ...(contextChannelId ? { contextChannelId } : {}) };
		return transaction(this.owner, 'readwrite', async tx => {
			await uniqueTitle(tx, note.scopeId, note.normalizedTitle, note.id);
			await request(tx.objectStore('notes').add(note));
			await syncLinks(tx, note);
			await resolveNewTitle(tx, note);
			return note;
		});
	}
	save(id: string, baseRevision: number, patch: NotePatch): Promise<NotebookNote> {
		return transaction(this.owner, 'readwrite', async tx => {
			const old = await requireRevision(tx, this.owner.scopeId, id, baseRevision);
			if (old.trashedAt !== null) throw new NotebookError('conflict', 'Restore this note from Trash before editing it.');
			const note = { ...old, ...(patch.title !== undefined ? checkedTitle(patch.title) : {}), ...(patch.text !== undefined ? { text: checkedText(patch.text) } : {}), ...(patch.pinned !== undefined ? { pinned: Boolean(patch.pinned) } : {}), ...('color' in patch ? { color: patch.color } : {}), revision: old.revision + 1, updatedAt: Date.now() };
			await uniqueTitle(tx, note.scopeId, note.normalizedTitle, id);
			if (note.title !== old.title) {
				const incoming = await request(tx.objectStore('links').index('target').getAll([note.scopeId, id])) as NotebookLink[];
				for (const sourceId of new Set(incoming.map(link => link.sourceId))) {
					const overlapping = await request(tx.objectStore('links').get([note.scopeId, sourceId, note.normalizedTitle])) as NotebookLink | undefined;
					if (overlapping?.targetId && overlapping.targetId !== id) throw new NotebookError('conflict', 'An incoming note already links this title to a deleted note. Relink that reference or choose another title before renaming.');
					const source = sourceId === id ? note : await request(tx.objectStore('notes').get([note.scopeId, sourceId])) as NotebookNote | undefined;
					if (!source) continue;
					// Rewrite only references actually bound to this UUID.
					for (const link of incoming.filter(item => item.sourceId === sourceId)) {
						source.text = renameNoteLinks(source.text, link.normalizedTitle, note.title);
						await request(tx.objectStore('links').delete([note.scopeId, sourceId, link.normalizedTitle]));
					}
					await request(tx.objectStore('links').put({ scopeId: note.scopeId, sourceId, normalizedTitle: note.normalizedTitle, targetId: id } satisfies NotebookLink));
					if (sourceId !== id) { source.revision++; source.updatedAt = note.updatedAt; await request(tx.objectStore('notes').put(source)); await syncLinks(tx, source); }
				}
			}
			await request(tx.objectStore('notes').put(note));
			await syncLinks(tx, note);
			await resolveNewTitle(tx, note);
			return note;
		});
	}
	setTrashed(id: string, baseRevision: number, trashed: boolean): Promise<NotebookNote> {
		return transaction(this.owner, 'readwrite', async tx => {
			const note = await requireRevision(tx, this.owner.scopeId, id, baseRevision);
			const next = { ...note, revision: note.revision + 1, updatedAt: Date.now(), trashedAt: trashed ? Date.now() : null };
			await request(tx.objectStore('notes').put(next));
			return next;
		});
	}
	permanentlyDelete(id: string, baseRevision: number): Promise<void> {
		return transaction(this.owner, 'readwrite', async tx => {
			const note = await requireRevision(tx, this.owner.scopeId, id, baseRevision);
			if (note.trashedAt === null) throw new NotebookError('invalid', 'Move the note to Trash before deleting it permanently.');
			await request(tx.objectStore('notes').delete([note.scopeId, id]));
			const outgoing = await request(tx.objectStore('links').index('source').getAll([note.scopeId, id])) as NotebookLink[];
			for (const link of outgoing) await request(tx.objectStore('links').delete([note.scopeId, id, link.normalizedTitle]));
		});
	}
	/** Retargeting a deleted UUID is always an explicit user action. */
	relink(sourceId: string, baseRevision: number, title: string, targetId: string): Promise<NotebookNote> {
		return transaction(this.owner, 'readwrite', async tx => {
			const source = await requireRevision(tx, this.owner.scopeId, sourceId, baseRevision);
			if (source.trashedAt !== null) throw new NotebookError('conflict', 'Restore this note before changing its links.');
			const normalizedTitle = normalizeNoteTitle(title);
			const target = await request(tx.objectStore('notes').get([this.owner.scopeId, targetId])) as NotebookNote | undefined;
			const link = await request(tx.objectStore('links').get([this.owner.scopeId, sourceId, normalizedTitle])) as NotebookLink | undefined;
			if (!target || target.trashedAt !== null || target.normalizedTitle !== normalizedTitle || !link) throw new NotebookError('invalid', 'Choose an existing note with the linked title.');
			await request(tx.objectStore('links').put({ ...link, targetId }));
			const next = { ...source, revision: source.revision + 1, updatedAt: Date.now() };
			await request(tx.objectStore('notes').put(next));
			return next;
		});
	}
}
