import { writable, get, type Writable } from 'svelte/store';
import { LocalNotebook } from './db';
import { NotebookError, type NotebookNote, type NotePatch } from './types';

export interface NoteDraft {
	note: NotebookNote;
	title: string;
	text: string;
	dirty: boolean;
	status: 'saved' | 'unsaved' | 'saving' | 'conflict' | 'failed';
	error: string | null;
}

// Editors keep independent drafts. Only committed changes are broadcast.
const localChanges = new EventTarget();
const retained = new Map<string, NoteEditor>();
let channel: BroadcastChannel | null | undefined;
function notifications(): BroadcastChannel | null {
	if (channel !== undefined) return channel;
	channel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('wabi-local-notes-changed') : null;
	channel?.addEventListener('message', event => {
		if (event.data && typeof event.data.scopeId === 'string') localChanges.dispatchEvent(new CustomEvent('commit', { detail: event.data }));
	});
	return channel;
}

export function announceNotebookChange(scopeId: string): void {
	localChanges.dispatchEvent(new CustomEvent('commit', { detail: { scopeId } }));
	notifications()?.postMessage({ scopeId });
}

export function subscribeNotebookChanges(scopeId: string, listener: () => void): () => void {
	notifications();
	const receive = (event: Event) => { if ((event as CustomEvent).detail.scopeId === scopeId) listener(); };
	localChanges.addEventListener('commit', receive);
	return () => localChanges.removeEventListener('commit', receive);
}

/** Runtime recovery is deliberately scoped; it does not promise crash survival. */
export function retainedNoteEditors(book: LocalNotebook): NoteEditor[] {
	if (!book.owner.isCurrent()) return [];
	return [...retained.values()].filter(editor => editor.book.owner.scopeId === book.owner.scopeId && get(editor.state).dirty);
}

export class NoteEditor {
	readonly id = crypto.randomUUID();
	readonly state: Writable<NoteDraft>;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private saving: Promise<boolean> | undefined;
	private editVersion = 0;
	private durableRecovery = false;
	private disposed = false;
	private unsubscribe: () => void;
	private beforeUnload = (event: BeforeUnloadEvent) => {
		if (get(this.state).dirty) { event.preventDefault(); event.returnValue = ''; }
	};

	constructor(readonly book: LocalNotebook, note: NotebookNote) {
		if (note.scopeId !== book.owner.scopeId) throw new NotebookError('invalid', 'This draft belongs to a different notebook.');
		this.state = writable<NoteDraft>({ note, title: note.title, text: note.text, dirty: false, status: 'saved', error: null });
		this.unsubscribe = subscribeNotebookChanges(note.scopeId, () => { void this.refresh(); });
		if (typeof window !== 'undefined') window.addEventListener('beforeunload', this.beforeUnload);
	}

	update(patch: Pick<NotePatch, 'title' | 'text'>): void {
		if (!this.book.owner.isCurrent() || this.disposed) return;
		this.editVersion++;
		this.state.update(draft => ({ ...draft, ...patch, dirty: true, status: draft.status === 'conflict' ? 'conflict' : 'unsaved', error: draft.status === 'conflict' ? draft.error : null }));
		retained.set(this.id, this);
		clearTimeout(this.timer);
		this.timer = setTimeout(() => { if (get(this.state).status === 'conflict') void this.preserveRecovery(); else void this.save(); }, 450);
	}

	async save(): Promise<boolean> {
		clearTimeout(this.timer);
		if (this.saving) return this.saving;
		const draft = get(this.state);
		if (!draft.dirty) return true;
		if (draft.status === 'conflict') return false;
		const version = this.editVersion;
		this.state.update(value => ({ ...value, status: 'saving', error: null }));
		this.saving = (async () => {
			try {
				const note = await this.book.save(draft.note.id, draft.note.revision, { title: draft.title, text: draft.text });
				const moreEdits = version !== this.editVersion;
				if (moreEdits && note.text !== draft.text) {
					this.state.update(value => ({ ...value, dirty: true, status: 'conflict', error: 'Renaming updated links while you were typing. Your draft is preserved; compare the saved version or save a recovery copy.' }));
					await this.preserveRecovery();
					announceNotebookChange(note.scopeId);
					return false;
				}
				this.state.update(value => ({ ...value, note, ...(moreEdits ? {} : { title: note.title, text: note.text }), dirty: moreEdits, status: moreEdits ? 'unsaved' : 'saved', error: null }));
				if (!moreEdits) retained.delete(this.id);
				if (!moreEdits && this.durableRecovery) await this.clearRecovery();
				announceNotebookChange(note.scopeId);
				return !moreEdits;
			} catch (error) {
				this.state.update(value => ({ ...value, dirty: true, status: error instanceof NotebookError && (error.code === 'conflict' || error.code === 'missing') ? 'conflict' : 'failed', error: error instanceof Error ? error.message : 'Could not save this note. Download your draft before leaving.' }));
				retained.set(this.id, this);
				await this.preserveRecovery();
				announceNotebookChange(this.book.owner.scopeId);
				return false;
			} finally {
				this.saving = undefined;
				if (get(this.state).status === 'unsaved') this.timer = setTimeout(() => { void this.save(); }, 0);
				if (this.disposed && !get(this.state).dirty) this.release();
			}
		})();
		return this.saving;
	}

	async refresh(): Promise<void> {
		if (this.saving || !this.book.owner.isCurrent()) return;
		const before = get(this.state);
		try {
			const note = await this.book.get(before.note.id);
			if (this.saving || !this.book.owner.isCurrent()) return;
			const current = get(this.state);
			if (note && note.revision < current.note.revision) return;
			if (!note || note.revision !== current.note.revision) {
				if (current.dirty) {
					clearTimeout(this.timer);
					this.state.update(value => ({ ...value, status: 'conflict', error: 'Another editor changed or deleted this note. Your draft is still here; save a recovery copy or compare the saved version.' }));
					await this.preserveRecovery();
				} else if (note) {
					this.state.set({ note, title: note.title, text: note.text, dirty: false, status: 'saved', error: null });
				} else {
					this.state.update(value => ({ ...value, status: 'conflict', error: 'This note was permanently deleted in another editor.' }));
				}
			}
		} catch { /* Reads never turn an existing draft into an empty editor. */ }
	}

	async saveRecoveryCopy(title: string, destination = this.book): Promise<NotebookNote> {
		if (destination.owner.scopeId !== this.book.owner.scopeId) throw new NotebookError('invalid', 'Recover this draft in its original notebook.');
		const draft = get(this.state);
		const version = this.editVersion;
		const note = await destination.create(title, draft.text, draft.note.contextChannelId);
		// The original draft is released only after its copy is committed.
		const moreEdits = version !== this.editVersion;
		this.state.update(current => ({ note, title: note.title, text: moreEdits ? current.text : note.text, dirty: moreEdits, status: moreEdits ? 'unsaved' : 'saved', error: null }));
		if (!moreEdits) retained.delete(this.id);
		else this.timer = setTimeout(() => { void this.save(); }, 0);
		if (!moreEdits) await this.clearRecovery(destination);
		announceNotebookChange(note.scopeId);
		if (this.disposed && !moreEdits) this.release();
		return note;
	}

	downloadText(): string {
		const draft = get(this.state);
		return `# ${draft.title}\n\n${draft.text}`;
	}

	/** Explicit discard only; callers must offer recovery/download first. */
	async useSavedVersion(): Promise<void> {
		const version = this.editVersion;
		const note = await this.book.get(get(this.state).note.id);
		if (!note) throw new NotebookError('missing', 'The saved note no longer exists. Save a recovery copy instead.');
		clearTimeout(this.timer);
		if (this.saving) throw new NotebookError('conflict', 'Wait for the pending save before replacing your draft.');
		if (version !== this.editVersion) throw new NotebookError('conflict', 'The draft changed while loading the saved note. Your latest writing is still here.');
		this.state.set({ note, title: note.title, text: note.text, dirty: false, status: 'saved', error: null });
		retained.delete(this.id);
		await this.clearRecovery();
	}
	private async preserveRecovery(): Promise<void> {
		const draft = get(this.state);
		try {
			await this.book.keepDraft({ id: this.id, noteId: draft.note.id, baseRevision: draft.note.revision, title: draft.title, text: draft.text });
			this.durableRecovery = true;
		} catch { /* Runtime draft and before-leave warning remain when storage fails. */ }
	}
	private async clearRecovery(destination = this.book): Promise<void> {
		try {
			await destination.removeRecoveredDraft(`draft:${this.book.owner.scopeId}:${this.id}`);
			this.durableRecovery = false;
		} catch { /* A stale recovery copy is safer than deleting unverified writing. */ }
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribe();
		clearTimeout(this.timer);
		if (get(this.state).dirty) {
			if (get(this.state).status === 'conflict') void this.preserveRecovery();
			else void this.save();
		}
		else this.release();
	}
	private release(): void {
		this.unsubscribe();
		if (typeof window !== 'undefined') window.removeEventListener('beforeunload', this.beforeUnload);
	}
}
