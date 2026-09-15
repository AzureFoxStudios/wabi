import { mobileTabQueue } from '$lib/mobileTabQueue';
import { writable } from 'svelte/store';

export const NOTES_ADDON_ID = 'notes';

export const notesOpenRequest = writable<{ scopeId: string; noteId: string; sequence: number } | null>(null);
let sequence = 0;

function openNotesSurface(target?: { scopeId: string; noteId: string } | Event): void {
	if (target && 'scopeId' in target && 'noteId' in target) notesOpenRequest.set({ ...target, sequence: ++sequence });
	mobileTabQueue.openAddonTab(NOTES_ADDON_ID);
}

export { openNotesSurface };
