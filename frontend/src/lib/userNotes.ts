import { openNotebookDatabase } from './notes/db';
import { NotebookError, type NotebookOwner } from './notes/types';

/** Legacy bytes remain untouched until the user explicitly maps owner and subject. */
export const USER_NOTES_STORAGE_KEY = 'wabi.userNotes.byUserId';
export const MAX_USER_NOTE_LENGTH = 400;
export interface UserNote { scopeId: string; subjectId: string; text: string; revision: number; updatedAt: number }
export interface UserNoteDraft { text: string; baseRevision: number }
const drafts = new Map<string, UserNoteDraft>();
const draftKey = (owner: NotebookOwner, subjectId: string) => JSON.stringify([owner.scopeId, subjectId]);
export function retainUserNoteDraft(owner: NotebookOwner, subjectId: string, draft: UserNoteDraft): void { drafts.set(draftKey(owner, subjectId), { ...draft }); }
export function getUserNoteDraft(owner: NotebookOwner, subjectId: string): UserNoteDraft | undefined { return drafts.get(draftKey(owner, subjectId)); }
export function forgetUserNoteDraft(owner: NotebookOwner, subjectId: string): void { drafts.delete(draftKey(owner, subjectId)); }
export function hasLegacyUserNotes(): boolean {
	try { return typeof window !== 'undefined' && window.localStorage.getItem(USER_NOTES_STORAGE_KEY) !== null; } catch { return false; }
}
export function stableUserNoteSubject(value: unknown): string | null {
	if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
	return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : null;
}
function assertOwner(owner: NotebookOwner): void {
	if (!owner.scopeId || !owner.isCurrent()) throw new NotebookError('retired', 'Your account changed. This draft stays with the original account.');
}
async function access(owner: NotebookOwner, subjectId: string, write?: { text: string; baseRevision: number }): Promise<UserNote> {
	assertOwner(owner);
	if (!stableUserNoteSubject(subjectId)) throw new NotebookError('invalid', 'This profile has no stable account identity.');
	if (write && (typeof write.text !== 'string' || write.text.length > MAX_USER_NOTE_LENGTH || !Number.isSafeInteger(write.baseRevision) || write.baseRevision < 0)) throw new NotebookError('invalid', 'The profile note is invalid.');
	const db = await openNotebookDatabase();
	assertOwner(owner);
	const tx = db.transaction('profileNotes', write ? 'readwrite' : 'readonly');
	const complete = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new NotebookError('unavailable', 'The profile note could not be saved.')); tx.onerror = () => {}; });
	void complete.catch(() => {});
	try {
		const store = tx.objectStore('profileNotes');
		const record = await new Promise<UserNote | undefined>((resolve, reject) => { const request = store.get([owner.scopeId, subjectId]); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
		assertOwner(owner);
		let result = record ?? { scopeId: owner.scopeId, subjectId, text: '', revision: 0, updatedAt: 0 };
		if (write) {
			if (result.revision !== write.baseRevision) throw new NotebookError('conflict', 'This note changed in another editor. Your draft is retained; download it before reloading the saved note.');
			// Empty notes remain revision tombstones so a stale editor cannot recreate them.
			result = { scopeId: owner.scopeId, subjectId, text: write.text, revision: result.revision + 1, updatedAt: Date.now() };
			store.put(result);
		}
		await complete;
		assertOwner(owner);
		return result;
	} catch (error) {
		try { tx.abort(); } catch { /* Already complete. */ }
		await complete.catch(() => {});
		throw error;
	}
}
export function getUserNote(owner: NotebookOwner, subjectId: string): Promise<UserNote> { return access(owner, subjectId); }
export function setUserNote(owner: NotebookOwner, subjectId: string, text: string, baseRevision: number): Promise<UserNote> { return access(owner, subjectId, { text, baseRevision }); }
export function clearUserNote(owner: NotebookOwner, subjectId: string, baseRevision: number): Promise<UserNote> { return access(owner, subjectId, { text: '', baseRevision }); }
