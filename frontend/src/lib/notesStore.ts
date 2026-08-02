import { browser } from '$app/environment';
import { writable } from 'svelte/store';

export interface LocalNote {
	id: string;
	text: string;
	createdAt: number;
	updatedAt: number;
	pinned?: boolean;
	color?: string;
}

// Preset swatches mapped to theme tokens (NOT hardcoded brand colors).
// Stored on the note and resolved via a CSS custom property at render time.
export const NOTE_COLORS: string[] = [
	'var(--accent-primary-color)',
	'var(--color-success, #22c55e)',
	'var(--color-warning, #f59e0b)',
	'var(--color-danger, #ef4444)',
	'var(--accent-purple, #9b59b6)',
	'var(--text-secondary, #8a8aa3)'
];

const KEEP_NOTES_PREFIX = 'wabi:keep-notes:v1';
const DM_NOTES_PREFIX = 'wabi:dm-notes:v1';
const QUICK_SCRATCHPAD_PREFIX = 'wabi:quick-scratchpad:v1';

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

// Pinned notes float to the top; within each group, newest-updated first.
export function sortNotesWithPin(notes: LocalNote[]): LocalNote[] {
	return [...notes].sort((a, b) => {
		const ap = a.pinned ? 1 : 0;
		const bp = b.pinned ? 1 : 0;
		if (ap !== bp) return bp - ap;
		return b.updatedAt - a.updatedAt;
	});
}

export function getKeepNotesStorageKey(userId: string | undefined): string {
	return `${KEEP_NOTES_PREFIX}:${userId || 'anon'}`;
}

export function getDmNotesStorageKey(channelId: string, userId: string | undefined): string {
	return `${DM_NOTES_PREFIX}:${userId || 'anon'}:${channelId}`;
}

export function getQuickScratchpadStorageKey(userId: string | undefined): string {
	return `${QUICK_SCRATCHPAD_PREFIX}:${userId || 'anon'}`;
}

export function readNotes(storageKey: string): LocalNote[] {
	return sortNotes(safeRead<LocalNote[]>(storageKey, []));
}

export function writeNotes(storageKey: string, notes: LocalNote[]): void {
	safeWrite(storageKey, sortNotes(notes));
}

export function readScratchpadText(storageKey: string): string {
	return safeRead<string>(storageKey, '');
}

export function writeScratchpadText(storageKey: string, value: string): void {
	safeWrite(storageKey, value);
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

/** N1: floating QuickScratchpad open state (global hotkey + /scratch). */
export const quickScratchpadOpen = writable(false);

export function openQuickScratchpad(): void {
	quickScratchpadOpen.set(true);
}

export function closeQuickScratchpad(): void {
	quickScratchpadOpen.set(false);
}

export function toggleQuickScratchpad(): void {
	quickScratchpadOpen.update((v) => !v);
}
