import { browser } from '$app/environment';

export const USER_NOTES_STORAGE_KEY = 'wabi.userNotes.byUserId';
export const MAX_USER_NOTE_LENGTH = 400;

type UserNotesMap = Record<string, string>;

function sanitizeUserId(userId: string): string {
	return typeof userId === 'string' ? userId.trim() : '';
}

function sanitizeUserNote(note: string): string {
	if (typeof note !== 'string') return '';
	const normalized = note.replace(/\s+/g, ' ').trim();
	return normalized.slice(0, MAX_USER_NOTE_LENGTH);
}

function safeReadNotesMap(): UserNotesMap {
	if (!browser) return {};
	try {
		const raw = localStorage.getItem(USER_NOTES_STORAGE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as UserNotesMap;
		if (!parsed || typeof parsed !== 'object') return {};
		const sanitized: UserNotesMap = {};
		for (const [rawUserId, rawNote] of Object.entries(parsed)) {
			const userId = sanitizeUserId(rawUserId);
			const note = sanitizeUserNote(typeof rawNote === 'string' ? rawNote : '');
			if (!userId || !note) continue;
			sanitized[userId] = note;
		}
		return sanitized;
	} catch {
		return {};
	}
}

function safeWriteNotesMap(notes: UserNotesMap): void {
	if (!browser) return;
	try {
		localStorage.setItem(USER_NOTES_STORAGE_KEY, JSON.stringify(notes));
	} catch {
		// best-effort persistence
	}
}

export function getUserNote(userId: string): string {
	const normalizedUserId = sanitizeUserId(userId);
	if (!normalizedUserId) return '';
	const notes = safeReadNotesMap();
	return notes[normalizedUserId] || '';
}

export function setUserNote(userId: string, note: string): string {
	const normalizedUserId = sanitizeUserId(userId);
	if (!normalizedUserId) return '';
	const normalizedNote = sanitizeUserNote(note);
	const notes = safeReadNotesMap();
	if (normalizedNote) {
		notes[normalizedUserId] = normalizedNote;
	} else {
		delete notes[normalizedUserId];
	}
	safeWriteNotesMap(notes);
	return normalizedNote;
}

export function clearUserNote(userId: string): void {
	const normalizedUserId = sanitizeUserId(userId);
	if (!normalizedUserId) return;
	const notes = safeReadNotesMap();
	if (!(normalizedUserId in notes)) return;
	delete notes[normalizedUserId];
	safeWriteNotesMap(notes);
}
