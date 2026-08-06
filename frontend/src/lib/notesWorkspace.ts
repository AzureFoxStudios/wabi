import { mobileTabQueue } from '$lib/mobileTabQueue';

export const NOTES_ADDON_ID = 'notes';

function openNotesSurface(): void {
	mobileTabQueue.openAddonTab(NOTES_ADDON_ID);
}

export { openNotesSurface };
