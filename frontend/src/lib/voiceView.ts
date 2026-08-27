import { writable } from 'svelte/store';
import { mobileTabQueue } from './mobileTabQueue';
import { READER_ADDON_ID } from './readerWorkspace';
import { MODEL_VIEWPORT_ADDON_ID } from './modelViewportTab';
import { MAP_ADDON_ID } from './mapWorkspace';
import { MEDIA_ALBUMS_ADDON_ID } from './mediaAlbumsWorkspace';
import { PLANNER_ADDON_ID } from './plannerWorkspace';
import { NOTES_ADDON_ID } from './notesWorkspace';

/**
 * Phase 4 — the dedicated voice view (figure 1): all calls as cards, checkable
 * from any channel via the workspace view pills. Simple boolean view state;
 * addon tabs take precedence while open, and the view returns when they close.
 */
export const voiceViewOpen = writable(false);

/**
 * Open the voice view from ANY surface (chat-header pills, MainLayout bar).
 *
 * The 2026-08-27 report ("the call view doesn't work / can't go to it") was
 * this exact gap: the chat-header pill bar — the ONLY bar visible while in
 * the default messages view — had no `voice` case, so the pill was a silent
 * no-op unless another view was already open. One shared opener now backs
 * every entry point: close the center addon tabs (they render in front of
 * the voice view in MainLayout's branch chain) and flip the store.
 */
export function openVoiceView(): void {
	mobileTabQueue.closeAddonTab(READER_ADDON_ID);
	mobileTabQueue.closeAddonTab(MODEL_VIEWPORT_ADDON_ID);
	mobileTabQueue.closeAddonTab(MAP_ADDON_ID);
	mobileTabQueue.closeAddonTab(MEDIA_ALBUMS_ADDON_ID);
	mobileTabQueue.closeAddonTab(PLANNER_ADDON_ID);
	mobileTabQueue.closeAddonTab(NOTES_ADDON_ID);
	voiceViewOpen.set(true);
}

/** Close the voice view (return-to-messages paths call this). */
export function closeVoiceView(): void {
	voiceViewOpen.set(false);
}
