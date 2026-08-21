import { mobileTabQueue } from '$lib/mobileTabQueue';

/** Lore workspace surface ("Project" pill). */
export const LORE_ADDON_ID = 'lore';

function openLoreSurface(): void {
	mobileTabQueue.openAddonTab(LORE_ADDON_ID);
}

export { openLoreSurface };
