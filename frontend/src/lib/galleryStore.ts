import { writable, get } from 'svelte/store';
import { getAuthToken, onAuthSessionCleared } from '$lib/authSession';
import { getServerUrl } from '$lib/serverUrl';
import { users, type User } from '$lib/socket';
import { groupMembership } from './groupAccess';
import type { MembershipLease } from './groupMembership';
import { guessGalleryMediaKind } from './galleryFilter';
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

export interface GalleryUploadFileError {
	fileName: string;
	message: string;
}

export interface GalleryUploadResult {
	uploaded: number;
	errors: string[];
	perFileErrors: GalleryUploadFileError[];
}

export const GALLERY_ALBUM_LIMIT = 200;
export const GALLERY_ALBUM_ITEM_LIMIT = 500;
export const GALLERY_RECENT_COUNT = 6;

const EXTENSION_MIME: Record<string, string> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	bmp: 'image/bmp',
	svg: 'image/svg+xml',
	tif: 'image/tiff',
	tiff: 'image/tiff',
	mp4: 'video/mp4',
	webm: 'video/webm',
	mov: 'image/quicktime'.replace('image/', 'video/'),
	m4v: 'video/x-m4v',
	mkv: 'video/x-matroska',
	avi: 'video/x-msvideo',
	ogv: 'video/ogg'
};

function extensionOf(name: string): string | null {
	const trimmed = (name || '').trim().toLowerCase();
	const dot = trimmed.lastIndexOf('.');
	if (dot < 0 || dot === trimmed.length - 1) return null;
	const ext = trimmed.slice(dot + 1);
	return /^[a-z0-9]{2,5}$/.test(ext) ? ext : null;
}

/** Browser File.type is empty for several camera/converted files — fall back to extension. */
export function resolveGalleryMime(file: File): string | null {
	const declared = (file.type || '').trim().toLowerCase();
	if (declared) return declared;
	const ext = extensionOf(file.name);
	if (ext && EXTENSION_MIME[ext]) return EXTENSION_MIME[ext];
	return null;
}

export function isGalleryFile(file: File): boolean {
	return guessGalleryMediaKind(resolveGalleryMime(file), file.name) !== 'unknown';
}

function tokenSubject(token: string | null): string | null {
	if (!token) return null;
	try {
		const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
		return typeof payload.sub === 'string' ? payload.sub : null;
	} catch {
		return null;
	}
}

// Mirrors channelMembership.current(): cancel stale client work on server or
// account changes, but permit a same-account access-token refresh mid-flight
// so legitimate refreshes never lose recoverable gallery work.
function sessionCurrent(serverBefore: string, tokenBefore: string | null): boolean {
	const next = getAuthToken();
	if (getServerUrl() !== serverBefore || !next) return false;
	if (next === tokenBefore) return true;
	const before = tokenSubject(tokenBefore);
	return !!before && before === tokenSubject(next);
}

type MembershipHelper = {
	realm?: () => string | null;
	onContextChanged?: (fn: (previous: string[]) => void) => () => void;
	onRevoked?: (fn: (event: { channelId: string }) => void) => () => void;
	tracks?: (id: string) => boolean;
	capture?: (id: string) => MembershipLease;
	current?: (lease: MembershipLease) => boolean;
};

// The group singleton is the configured helper; method guards tolerate
// narrowed test doubles (bun's mock.module cache is process-wide, so other
// suites register a slim groupAccess mock). Album/membership enforcement
// itself stays server-side via fetchChannel; this lease only cancels stale
// client work the same way captureGroupAccess does.
const membership = groupMembership as unknown as MembershipHelper;

function channelLease(channelId: string): () => boolean {
	if (
		typeof membership.tracks !== 'function' ||
		typeof membership.capture !== 'function' ||
		typeof membership.current !== 'function'
	) {
		return () => true;
	}
	if (!membership.tracks(channelId)) return () => true;
	const lease = membership.capture(channelId);
	return () => {
		try {
			return membership.current!(lease);
		} catch {
			return false;
		}
	};
}

// Each mounted Gallery owns its items, filters source state and request lifetime.
export function createGalleryWorkspace() {
	const galleryItems = writable<GalleryItem[]>([]);
	const galleryCreators = writable<GalleryCreator[]>([]);
	const galleryLoading = writable(false);
	const galleryError = writable<string | null>(null);
	const galleryWarning = writable<string | null>(null);
	const galleryChannelId = writable<string | null>(null);

	const galleryItemsStore = galleryItems;
	const galleryCreatorsStore = galleryCreators;
	const galleryLoadingStore = galleryLoading;
	const galleryErrorStore = galleryError;
	const galleryWarningStore = galleryWarning;
	const galleryChannelStore = galleryChannelId;

	let generation = 0;
	let disposed = false;
	let loadRequestId = 0;

	function clear() {
		generation += 1;
		loadRequestId += 1;
		galleryItems.set([]);
		galleryCreators.set([]);
		galleryChannelId.set(null);
		galleryLoading.set(false);
		galleryError.set(null);
		galleryWarning.set(null);
	}

	function snapshotSession(): { server: string; token: string | null } {
		return { server: getServerUrl(), token: getAuthToken() };
	}

	// Fence on server/account/session ownership, not on the raw token string,
	// so a legitimate same-account token refresh keeps recoverable work while
	// logout, account/server switches and disposal retire it.
	function capture(channelId: string) {
		const version = generation;
		const before = snapshotSession();
		return () =>
			!disposed &&
			generation === version &&
			get(galleryChannelId) === channelId &&
			sessionCurrent(before.server, before.token);
	}

	const stopAuth = onAuthSessionCleared(clear);
	const stopContext =
		typeof membership.onContextChanged === 'function' ? membership.onContextChanged(clear) : () => {};
	const stopRevocation =
		typeof membership.onRevoked === 'function'
			? membership.onRevoked((event) => {
					if (event.channelId === get(galleryChannelId)) clear();
				})
			: () => {};
	function dispose() {
		disposed = true;
		clear();
		stopAuth();
		stopContext();
		stopRevocation();
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

	function applyCreatorLabels(allItems: GalleryItem[], allUsers: User[]): GalleryCreator[] {
		const creatorMap = new Map<number, { count: number; latest: number }>();
		for (const item of allItems) {
			item.creator = allUsers.find((u) => u.dbUserId === item.uploadedBy) || null;
			const existing = creatorMap.get(item.uploadedBy);
			if (existing) {
				existing.count++;
				if (item.uploadedAt > existing.latest) existing.latest = item.uploadedAt;
			} else {
				creatorMap.set(item.uploadedBy, { count: 1, latest: item.uploadedAt });
			}
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
				latestUpload: stats.latest
			});
		}
		creators.sort((a, b) => b.latestUpload - a.latestUpload);
		return creators;
	}

	/** Re-resolve creator labels from the live user list without refetching. */
	function refreshCreators(): void {
		if (disposed) return;
		const allUsers = get(users);
		galleryItems.update((items) => {
			const creators = applyCreatorLabels(items, allUsers);
			galleryCreators.set(creators);
			return items;
		});
	}

	function toGalleryItem(album: MediaAlbum, raw: MediaAlbumItem): GalleryItem | null {
		if (guessGalleryMediaKind(raw.attachmentMime, raw.attachmentName) === 'unknown') return null;
		return {
			id: `album-${raw.albumId}-item-${raw.id}`,
			albumId: raw.albumId,
			albumName: album.name,
			attachmentUrl: resolveAssetUrl(raw.attachmentUrl),
			attachmentName: raw.attachmentName,
			attachmentSize: raw.attachmentSize,
			attachmentMime: raw.attachmentMime,
			caption: raw.caption,
			uploadedBy: raw.uploadedBy,
			uploadedAt: raw.uploadedAt,
			creator: null
		};
	}

	async function loadGallery(channelId: string): Promise<void> {
		if (disposed) return;
		if (typeof membership.realm === 'function') membership.realm();
		if (get(galleryChannelId) !== channelId) clear();
		const requestId = ++loadRequestId;
		const token = getAuthToken();
		if (!token || !channelId) {
			galleryItems.set([]);
			galleryCreators.set([]);
			galleryChannelId.set(null);
			return;
		}

		let hasAccess: () => boolean = () => true;
		try {
			hasAccess = channelLease(channelId);
		} catch (err) {
			galleryError.set(err instanceof Error ? err.message : 'Group access changed');
			galleryItems.set([]);
			galleryCreators.set([]);
			return;
		}

		galleryChannelId.set(channelId);
		const isCurrent = capture(channelId);
		galleryLoading.set(true);
		galleryError.set(null);
		galleryWarning.set(null);

		try {
			const albums = await listMediaAlbums(token, 'channel', channelId, GALLERY_ALBUM_LIMIT);
			if (requestId !== loadRequestId || !isCurrent()) return;
			if (!hasAccess()) return;

			if (albums.length === 0) {
				galleryItems.set([]);
				galleryCreators.set([]);
				galleryLoading.set(false);
				return;
			}

			const albumsAtCap = albums.length >= GALLERY_ALBUM_LIMIT;
			const itemResults = await Promise.allSettled(
				albums.map((album) => listMediaAlbumItems(token, album.id, GALLERY_ALBUM_ITEM_LIMIT))
			);
			if (requestId !== loadRequestId || !isCurrent()) return;
			if (!hasAccess()) return;

			const allItems: GalleryItem[] = [];
			let failures = 0;
			let itemsAtCap = false;
			for (let i = 0; i < itemResults.length; i++) {
				const result = itemResults[i];
				const album = albums[i];
				if (!album) continue;
				if (result.status !== 'fulfilled') {
					failures++;
					continue;
				}
				if (result.value.items.length >= GALLERY_ALBUM_ITEM_LIMIT) itemsAtCap = true;
				for (const raw of result.value.items) {
					const item = toGalleryItem(album, raw);
					if (item) allItems.push(item);
				}
			}

			if (allItems.length === 0 && failures > 0) {
				galleryError.set(
					`Failed to load gallery: ${failures} of ${albums.length} album${albums.length === 1 ? '' : 's'} could not be loaded.`
				);
				galleryItems.set([]);
				galleryCreators.set([]);
				return;
			}

			allItems.sort((a, b) => b.uploadedAt - a.uploadedAt);
			const creators = applyCreatorLabels(allItems, get(users));
			if (requestId !== loadRequestId || !isCurrent()) return;
			galleryItems.set(allItems);
			galleryCreators.set(creators);

			const warnings: string[] = [];
			if (failures > 0) {
				warnings.push(
					`Showing partial results: ${failures} of ${albums.length} album${albums.length === 1 ? '' : 's'} failed to load.`
				);
			}
			if (albumsAtCap) warnings.push(`Showing the first ${GALLERY_ALBUM_LIMIT} albums.`);
			if (itemsAtCap) warnings.push(`Some albums show the first ${GALLERY_ALBUM_ITEM_LIMIT} items.`);
			galleryWarning.set(warnings.length > 0 ? `${warnings.join(' ')} Retry to reload.` : null);
		} catch (err) {
			if (requestId !== loadRequestId || !isCurrent()) return;
			galleryError.set(err instanceof Error ? err.message : 'Failed to load gallery');
			galleryItems.set([]);
			galleryCreators.set([]);
		} finally {
			if (requestId === loadRequestId && isCurrent()) galleryLoading.set(false);
		}
	}

	async function uploadGalleryAsset(
		server: string,
		token: string,
		file: File
	): Promise<{ fileUrl: string; fileName: string; fileSize: number }> {
		const formData = new FormData();
		formData.append('file', file, file.name);

		const response = await fetch(`${server}/api/upload`, {
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

	async function uploadGalleryImages(
		channelId: string,
		files: File[],
		channelName?: string
	): Promise<GalleryUploadResult> {
		const result: GalleryUploadResult = { uploaded: 0, errors: [], perFileErrors: [] };
		if (disposed) {
			result.errors.push('Gallery is no longer open');
			return result;
		}
		// Capture the server up front and never continue against a changed one.
		// Account tolerance mirrors sessionCurrent: same-account token
		// rotation must not strand an in-flight upload.
		const before = snapshotSession();
		const server = before.server;
		const version = generation;
		const channelMatches = () => {
			const current = get(galleryChannelId);
			return current === null || current === channelId;
		};
		const stillCurrent = () =>
			!disposed && generation === version && sessionCurrent(server, before.token) && channelMatches();

		const token = getAuthToken();
		if (!token || !channelId) {
			result.errors.push('Not signed in');
			return result;
		}

		let hasAccess: () => boolean = () => true;
		try {
			hasAccess = channelLease(channelId);
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Group access changed';
			result.errors.push(message);
			return result;
		}

		const eligible = files.filter(isGalleryFile);
		if (eligible.length === 0) {
			result.errors.push('No image or video files selected');
			return result;
		}

		const liveToken = () => getAuthToken();
		try {
			let stepToken = liveToken();
			if (!stepToken || !stillCurrent()) {
				result.errors.push('Gallery context changed before the upload could start');
				return result;
			}
			const albums = await listMediaAlbums(stepToken, 'channel', channelId, GALLERY_ALBUM_LIMIT);
			if (!stillCurrent() || !hasAccess()) {
				result.errors.push('Stopped: the gallery context changed during upload');
				return result;
			}
			let targetAlbum =
				albums.length > 0
					? albums.reduce(
							(latest, album) => (album.updatedAt > latest.updatedAt ? album : latest),
							albums[0]
						)
					: null;
			if (!targetAlbum) {
				targetAlbum = await createMediaAlbum(stepToken, {
					scopeType: 'channel',
					scopeId: channelId,
					name: channelName?.trim() ? channelName.trim() : 'Gallery'
				});
				if (!stillCurrent() || !hasAccess()) {
					result.errors.push('Stopped: the gallery context changed during upload');
					return result;
				}
			}

			for (const file of eligible) {
				if (!stillCurrent() || !hasAccess()) {
					result.errors.push('Stopped: the gallery context changed during upload');
					break;
				}
				stepToken = liveToken();
				if (!stepToken) {
					result.errors.push('Signed out during upload; stopped');
					break;
				}
				try {
					const uploaded = await uploadGalleryAsset(server, stepToken, file);
					if (!stillCurrent() || !hasAccess()) {
						result.errors.push(
							`Uploaded ${file.name} but the gallery changed; it was not added to the album`
						);
						break;
					}
					await addMediaAlbumItem(stepToken, targetAlbum.id, {
						attachmentUrl: uploaded.fileUrl,
						attachmentName: uploaded.fileName,
						attachmentSize: uploaded.fileSize,
						attachmentMime: resolveGalleryMime(file)
					});
					result.uploaded++;
				} catch (error) {
					const message = error instanceof Error ? error.message : `Failed to upload ${file.name}`;
					result.perFileErrors.push({ fileName: file.name, message });
					result.errors.push(`${file.name}: ${message}`);
				}
			}
		} catch (error) {
			result.errors.push(error instanceof Error ? error.message : 'Failed to upload to gallery');
		}

		if (result.uploaded > 0 && stillCurrent() && hasAccess()) {
			await loadGallery(channelId);
		}

		return result;
	}

	return {
		galleryItemsStore,
		galleryCreatorsStore,
		galleryLoadingStore,
		galleryErrorStore,
		galleryWarningStore,
		galleryChannelStore,
		loadGallery,
		uploadGalleryImages,
		refreshCreators,
		dispose
	};
}

// Compatibility facade for non-view callers and presentation helpers.
export const {
	galleryItemsStore,
	galleryCreatorsStore,
	galleryLoadingStore,
	galleryErrorStore,
	galleryWarningStore,
	galleryChannelStore,
	loadGallery,
	uploadGalleryImages,
	refreshCreators
} = createGalleryWorkspace();

export function getGalleryItemKind(mime: string | null): 'image' | 'video' | 'unknown' {
	return guessGalleryMediaKind(mime, '');
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
