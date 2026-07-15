import { mobileTabQueue } from '$lib/mobileTabQueue';

export const MEDIA_ALBUMS_ADDON_ID = 'media-albums';

export function openMediaAlbumsSurface(): void {
	mobileTabQueue.openAddonTab(MEDIA_ALBUMS_ADDON_ID);
}
