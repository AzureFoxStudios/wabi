import type { MediaAlbum, MediaAlbumItem } from '$lib/api';

export function currentUserDbId(currentUser: { dbUserId?: number } | null | undefined): number | null {
	return typeof currentUser?.dbUserId === 'number' ? currentUser.dbUserId : null;
}

export function canModerateAlbums(currentUser: { highestRole?: string } | null | undefined): boolean {
	const role = (currentUser?.highestRole || '').toLowerCase();
	return role === 'owner' || role === 'admin' || role === 'mod';
}

export function canDeleteAlbum(
	album: MediaAlbum | null,
	currentUser: { dbUserId?: number; highestRole?: string } | null | undefined
): boolean {
	if (!album) return false;
	const dbUserId = currentUserDbId(currentUser);
	if (dbUserId !== null && album.createdBy === dbUserId) return true;
	return canModerateAlbums(currentUser);
}

export function canFeatureAlbum(
	album: MediaAlbum | null,
	currentUser: { dbUserId?: number; highestRole?: string } | null | undefined
): boolean {
	if (!album) return false;
	const dbUserId = currentUserDbId(currentUser);
	if (dbUserId !== null && album.createdBy === dbUserId) return true;
	return canModerateAlbums(currentUser);
}

export function canDeleteItem(
	item: MediaAlbumItem,
	album: MediaAlbum | null,
	currentUser: { dbUserId?: number; highestRole?: string } | null | undefined
): boolean {
	const dbUserId = currentUserDbId(currentUser);
	if (dbUserId !== null && item.uploadedBy === dbUserId) return true;
	if (dbUserId !== null && album && album.createdBy === dbUserId) return true;
	return canModerateAlbums(currentUser);
}
