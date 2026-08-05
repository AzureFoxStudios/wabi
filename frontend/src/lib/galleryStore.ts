import { writable, derived, get } from 'svelte/store';
import { getAuthToken } from '$lib/authSession';
import { getServerUrl } from '$lib/serverUrl';
import { currentUser, users, type User } from '$lib/socket';
import {
	listMediaAlbums,
	listMediaAlbumItems,
	createMediaAlbum,
	addMediaAlbumItem,
	type MediaAlbum,
	type MediaAlbumItem
} from '$lib/api';

export interface GalleryItem {
	id: string;
	albumId: number;
	albumName: string;
	attachmentUrl: string;
	attachmentName: string;
	attachmentSize: number | null;
	attachmentMime: string | null;
	caption: string | null;
	uploadedBy: number;
	uploadedAt: number;
	creator: User | null;
}

export interface GalleryCreator {
	dbUserId: number;
	username: string;
	profilePicture?: string;
	color?: string;
	bannerUrl?: string;
	workCount: number;
	latestUpload: number;
}

const galleryItems = writable<GalleryItem[]>([]);
const galleryCreators = writable<GalleryCreator[]>([]);
const galleryLoading = writable(false);
const galleryError = writable<string | null>(null);
const galleryChannelId = writable<string | null>(null);

export const galleryItemsStore = galleryItems;
export const galleryCreatorsStore = galleryCreators;
export const galleryLoadingStore = galleryLoading;
export const galleryErrorStore = galleryError;

function isImageMime(mime: string | null): boolean {
	if (!mime) return false;
	return mime.startsWith('image/');
}

function isVideoMime(mime: string | null): boolean {
	if (!mime) return false;
	return mime.startsWith('video/');
}

function resolveAssetUrl(attachmentUrl: string): string {
	if (!attachmentUrl) return '';
	if (attachmentUrl.startsWith('data:')) return attachmentUrl;
	if (attachmentUrl.startsWith('http://') || attachmentUrl.startsWith('https://')) {
		try {
			const url = new URL(attachmentUrl);
			const isLocal =
				(url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
				url.pathname.startsWith('/uploads/');
			if (isLocal) {
				return `${getServerUrl()}${url.pathname}${url.search}${url.hash}`;
			}
		} catch {
			// fall through
		}
		return attachmentUrl;
	}
	const normalized = attachmentUrl.startsWith('/') ? attachmentUrl : `/${attachmentUrl}`;
	return `${getServerUrl()}${normalized}`;
}

export async function loadGallery(channelId: string): Promise<void> {
	const token = getAuthToken();
	if (!token || !channelId) {
		galleryItems.set([]);
		galleryCreators.set([]);
		galleryChannelId.set(null);
		return;
	}

	galleryChannelId.set(channelId);
	galleryLoading.set(true);
	galleryError.set(null);

	try {
		const albums = await listMediaAlbums(token, 'channel', channelId, 200);

		if (albums.length === 0) {
			galleryItems.set([]);
			galleryCreators.set([]);
			galleryLoading.set(false);
			return;
		}

		const allItems: GalleryItem[] = [];
		const creatorMap = new Map<number, { count: number; latest: number }>();

		const itemResults = await Promise.allSettled(
			albums.map((album) => listMediaAlbumItems(token, album.id, 500))
		);

		for (let i = 0; i < itemResults.length; i++) {
			const result = itemResults[i];
			const album = albums[i];
			if (!album) continue;
			if (result.status !== 'fulfilled') continue;

			for (const item of result.value.items) {
				if (!isImageMime(item.attachmentMime) && !isVideoMime(item.attachmentMime)) continue;

				const existing = creatorMap.get(item.uploadedBy);
				if (existing) {
					existing.count++;
					if (item.uploadedAt > existing.latest) existing.latest = item.uploadedAt;
				} else {
					creatorMap.set(item.uploadedBy, { count: 1, latest: item.uploadedAt });
				}

				allItems.push({
					id: `album-${item.albumId}-item-${item.id}`,
					albumId: item.albumId,
					albumName: album.name,
					attachmentUrl: resolveAssetUrl(item.attachmentUrl),
					attachmentName: item.attachmentName,
					attachmentSize: item.attachmentSize,
					attachmentMime: item.attachmentMime,
					caption: item.caption,
					uploadedBy: item.uploadedBy,
					uploadedAt: item.uploadedAt,
					creator: null,
				});
			}
		}

		allItems.sort((a, b) => b.uploadedAt - a.uploadedAt);

		const allUsers = get(users);
		for (const item of allItems) {
			item.creator = allUsers.find((u) => u.dbUserId === item.uploadedBy) || null;
		}

		const creators: GalleryCreator[] = [];
		for (const [dbUserId, stats] of creatorMap) {
			const user = allUsers.find((u) => u.dbUserId === dbUserId);
			creators.push({
				dbUserId,
				username: user?.username || `User #${dbUserId}`,
				profilePicture: user?.profilePicture,
				color: user?.color || user?.roleColor,
				workCount: stats.count,
				latestUpload: stats.latest,
			});
		}
		creators.sort((a, b) => b.latestUpload - a.latestUpload);

		galleryItems.set(allItems);
		galleryCreators.set(creators);
	} catch (err) {
		galleryError.set(err instanceof Error ? err.message : 'Failed to load gallery');
		galleryItems.set([]);
		galleryCreators.set([]);
	} finally {
		galleryLoading.set(false);
	}
}

export function getGalleryItemKind(mime: string | null): 'image' | 'video' | 'unknown' {
	if (isImageMime(mime)) return 'image';
	if (isVideoMime(mime)) return 'video';
	return 'unknown';
}

export function getCreatorInitial(username: string): string {
	return username.charAt(0).toUpperCase();
}

export function formatGalleryTime(timestamp: number): string {
	const now = Date.now();
	const diff = now - timestamp;
	const seconds = Math.floor(diff / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (seconds < 60) return 'just now';
	if (minutes < 60) return `${minutes}m ago`;
	if (hours < 24) return `${hours}h ago`;
	if (days < 7) return `${days}d ago`;
	try {
		return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(timestamp));
	} catch {
		return `${days}d ago`;
	}
}

export interface GalleryUploadResult {
	uploaded: number;
	errors: string[];
}

async function uploadGalleryAsset(
	token: string,
	file: File
): Promise<{ fileUrl: string; fileName: string; fileSize: number }> {
	const formData = new FormData();
	formData.append('file', file, file.name);

	const response = await fetch(`${getServerUrl()}/api/upload`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`
		},
		body: formData
	});

	if (!response.ok) {
		let detail = '';
		try {
			const payload = await response.json();
			detail = payload?.error || '';
		} catch {
			detail = await response.text();
		}
		throw new Error(detail || `Upload failed (${response.status})`);
	}

	const payload = await response.json();
	const fileUrl = typeof payload?.fileUrl === 'string' ? payload.fileUrl : '';
	if (!fileUrl) {
		throw new Error('Upload did not return a file URL.');
	}

	return {
		fileUrl,
		fileName: typeof payload?.fileName === 'string' ? payload.fileName : file.name,
		fileSize:
			typeof payload?.fileSize === 'number' && Number.isFinite(payload.fileSize)
				? payload.fileSize
				: file.size
	};
}

export async function uploadGalleryImages(
	channelId: string,
	files: File[],
	channelName?: string
): Promise<GalleryUploadResult> {
	const result: GalleryUploadResult = { uploaded: 0, errors: [] };
	const token = getAuthToken();
	if (!token || !channelId) {
		result.errors.push('Not signed in');
		return result;
	}

	const images = files.filter((file) => file.type.startsWith('image/'));
	if (images.length === 0) {
		result.errors.push('No image files selected');
		return result;
	}

	try {
		const albums = await listMediaAlbums(token, 'channel', channelId, 200);
		let targetAlbum =
			albums.length > 0
				? albums.reduce(
						(latest, album) => (album.updatedAt > latest.updatedAt ? album : latest),
						albums[0]
					)
				: null;
		if (!targetAlbum) {
			targetAlbum = await createMediaAlbum(token, {
				scopeType: 'channel',
				scopeId: channelId,
				name: channelName?.trim() ? channelName.trim() : 'Gallery'
			});
		}

		for (const file of images) {
			try {
				const uploaded = await uploadGalleryAsset(token, file);
				await addMediaAlbumItem(token, targetAlbum.id, {
					attachmentUrl: uploaded.fileUrl,
					attachmentName: uploaded.fileName,
					attachmentSize: uploaded.fileSize,
					attachmentMime: file.type || null
				});
				result.uploaded++;
			} catch (error) {
				result.errors.push(error instanceof Error ? error.message : `Failed to upload ${file.name}`);
			}
		}
	} catch (error) {
		result.errors.push(error instanceof Error ? error.message : 'Failed to upload to gallery');
	}

	if (result.uploaded > 0) {
		await loadGallery(channelId);
	}

	return result;
}
