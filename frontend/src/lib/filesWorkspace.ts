import { mobileTabQueue } from '$lib/mobileTabQueue';

/** Files workspace surface ("Files" pill). */
export const FILES_ADDON_ID = 'files';

function openFilesSurface(): void {
	mobileTabQueue.openAddonTab(FILES_ADDON_ID);
}

export { openFilesSurface };
