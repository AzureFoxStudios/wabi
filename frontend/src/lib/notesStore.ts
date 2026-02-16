import { browser } from '$app/environment';

export interface LocalNote {
	id: string;
	text: string;
	createdAt: number;
	updatedAt: number;
}

const KEEP_NOTES_PREFIX = 'wabi:keep-notes:v1';
const DM_NOTES_PREFIX = 'wabi:dm-notes:v1';

function safeRead<T>(key: string, fallback: T): T {
	if (!browser) return fallback;
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return fallback;
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

function safeWrite<T>(key: string, value: T): void {
	if (!browser) return;
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Ignore quota/private mode write failures.
	}
}

function sortNotes(notes: LocalNote[]): LocalNote[] {
	return [...notes].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getKeepNotesStorageKey(userId: string | undefined): string {
	return `${KEEP_NOTES_PREFIX}:${userId || 'anon'}`;
}

export function getDmNotesStorageKey(channelId: string, userId: string | undefined): string {
	return `${DM_NOTES_PREFIX}:${userId || 'anon'}:${channelId}`;
}

export function readNotes(storageKey: string): LocalNote[] {
	return sortNotes(safeRead<LocalNote[]>(storageKey, []));
}

export function writeNotes(storageKey: string, notes: LocalNote[]): void {
	safeWrite(storageKey, sortNotes(notes));
}

export function createEmptyNote(): LocalNote {
	const ts = Date.now();
	const rand = Math.random().toString(36).slice(2, 8);
	return {
		id: `note-${ts}-${rand}`,
		text: '',
		createdAt: ts,
		updatedAt: ts
	};
}
