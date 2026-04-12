<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { channels, currentChannel, currentUser, sendMessage } from '$lib/socket';
	import { getServerUrl } from '$lib/serverUrl';
	import { getAuthToken as getSessionAuthToken } from '$lib/authSession';
	import {
		addMediaAlbumItem,
		createMediaAlbum,
		deleteMediaAlbum,
		deleteMediaAlbumItem,
		listMediaAlbumItems,
		listMediaAlbums,
		reorderMediaAlbumItems,
		setMediaAlbumFeatured,
		type MediaAlbum,
		MediaAlbumApiError,
		type MediaAlbumItem,
		type MediaAlbumScopeType
	} from '$lib/api';

	$: activeChannel = $channels.find((channel) => channel.id === $currentChannel) || null;
	$: scopeType = (activeChannel?.type === 'dm' || activeChannel?.type === 'group' ? 'dm' : 'channel') as MediaAlbumScopeType;
	$: scopeId = activeChannel?.id || '';
	$: scopeLabel = (() => {
		if (!scopeId) return 'Select a channel to browse albums.';
		if (scopeType === 'dm') {
			return activeChannel?.name ? `Conversation albums (${activeChannel.name})` : 'Conversation albums';
		}
		return activeChannel?.name ? `Channel albums (#${activeChannel.name})` : 'Channel albums';
	})();

	let albums: MediaAlbum[] = [];
	let selectedAlbumId: number | null = null;
	let albumItems: MediaAlbumItem[] = [];

	let isLoadingAlbums = false;
	let isLoadingItems = false;
	let isCreatingAlbum = false;
	let isAddingItem = false;
	let isDeletingAlbum = false;
	let deletingItemId: number | null = null;

	let errorMessage = '';
	let successMessage = '';
	let newAlbumName = '';
	let draftAttachmentUrl = '';
	let draftAttachmentName = '';
	let draftAttachmentMime = '';
	let draftCaption = '';
	let draftUploadCaption = '';
	let draftUploadFile: File | null = null;
	let uploadInputElement: HTMLInputElement | null = null;
	let uploadPickerMode: 'draft' | 'instant' = 'draft';
	let lastScopeKey = '';
	let isUploadingAlbumFile = false;
	let itemSearchQuery = '';
	type AlbumItemSortMode = 'manual' | 'newest' | 'oldest' | 'name';
	type AlbumItemViewMode = 'list' | 'grid';
	let itemSortMode: AlbumItemSortMode = 'newest';
	let itemViewMode: AlbumItemViewMode = 'grid';
	let currentItemsPage = 1;
	let lastItemsControlKey = '';
	let isSavingItemOrder = false;
	let isSavingFeaturedAlbum = false;
	let draggingItemId: number | null = null;
	let activePrefsScopeKey = '';
	let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
	let albumPreviewMap: Record<number, MediaAlbumItem[]> = {};
	let albumContextMenu:
		| {
				albumId: number;
				x: number;
				y: number;
		  }
		| null = null;
	let albumViewerOpen = false;
	let albumViewerItems: MediaAlbumItem[] = [];
	let albumViewerAlbumId: number | null = null;
	let albumViewerAlbumName = '';
	let albumViewerIndex = 0;
	let albumViewerCurrentItem: MediaAlbumItem | null = null;
	let lastUploadedAlbumId: number | null = null;
	const ITEMS_PER_PAGE = 24;
	const ALBUM_VIEW_PREFS_KEY = 'wabi.mediaAlbums.viewPrefs.v1';

	function getAuthToken(): string | null {
		return getSessionAuthToken();
	}

	interface AlbumViewPrefs {
		sortMode: AlbumItemSortMode;
		viewMode: AlbumItemViewMode;
	}

	function sanitizeAlbumSortMode(value: unknown): AlbumItemSortMode {
		if (value === 'manual') return 'manual';
		if (value === 'oldest') return 'oldest';
		if (value === 'name') return 'name';
		return 'newest';
	}

	function sanitizeAlbumViewMode(value: unknown): AlbumItemViewMode {
		if (value === 'list') return 'list';
		return 'grid';
	}

	function safeReadAlbumViewPrefsMap(): Record<string, AlbumViewPrefs> {
		if (typeof window === 'undefined') return {};
		try {
			const raw = window.localStorage.getItem(ALBUM_VIEW_PREFS_KEY);
			if (!raw) return {};
			const parsed = JSON.parse(raw) as Record<string, Partial<AlbumViewPrefs>>;
			const sanitized: Record<string, AlbumViewPrefs> = {};
			for (const [key, value] of Object.entries(parsed || {})) {
				if (!key) continue;
				sanitized[key] = {
					sortMode: sanitizeAlbumSortMode(value?.sortMode),
					viewMode: sanitizeAlbumViewMode(value?.viewMode)
				};
			}
			return sanitized;
		} catch {
			return {};
		}
	}

	function safeWriteAlbumViewPrefsMap(map: Record<string, AlbumViewPrefs>): void {
		if (typeof window === 'undefined') return;
		try {
			window.localStorage.setItem(ALBUM_VIEW_PREFS_KEY, JSON.stringify(map));
		} catch {
			// best-effort persistence
		}
	}

	function applyScopeViewPreferences(scopeKey: string): void {
		if (!scopeKey) return;
		const map = safeReadAlbumViewPrefsMap();
		const saved = map[scopeKey];
		if (!saved) return;
		itemSortMode = sanitizeAlbumSortMode(saved.sortMode);
		itemViewMode = sanitizeAlbumViewMode(saved.viewMode);
	}

	function persistScopeViewPreferences(scopeKey: string): void {
		if (!scopeKey) return;
		const map = safeReadAlbumViewPrefsMap();
		map[scopeKey] = {
			sortMode: sanitizeAlbumSortMode(itemSortMode),
			viewMode: sanitizeAlbumViewMode(itemViewMode)
		};
		safeWriteAlbumViewPrefsMap(map);
	}

	function clearError(): void {
		errorMessage = '';
	}

	function clearSuccess(): void {
		successMessage = '';
	}

	function sortAlbumsForDisplay(nextAlbums: MediaAlbum[]): MediaAlbum[] {
		return nextAlbums
			.slice()
			.sort((a, b) => {
				if (a.isFeatured !== b.isFeatured) {
					return a.isFeatured ? -1 : 1;
				}
				return b.updatedAt - a.updatedAt;
			});
	}

	function selectedAlbum(): MediaAlbum | null {
		return albums.find((album) => album.id === selectedAlbumId) || null;
	}

	function albumRowStatus(album: MediaAlbum): string | null {
		if (selectedAlbumId === album.id && isUploadingAlbumFile) return 'Uploading';
		if (lastUploadedAlbumId === album.id) return 'Updated';
		if (selectedAlbumId === album.id) return album.itemCount > 0 ? 'Selected' : 'Ready';
		return null;
	}

	function formatTimestamp(timestamp: number | null | undefined): string {
		if (!timestamp) return 'unknown';
		try {
			return new Date(timestamp).toLocaleString();
		} catch {
			return 'unknown';
		}
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
	}

	function resolveAlbumAssetUrl(attachmentUrl: string): string {
		if (!attachmentUrl) return '';
		if (attachmentUrl.startsWith('data:')) return attachmentUrl;
		if (attachmentUrl.startsWith('http://') || attachmentUrl.startsWith('https://')) {
			try {
				const absoluteUrl = new URL(attachmentUrl);
				const isLocalAsset =
					(absoluteUrl.hostname === 'localhost' || absoluteUrl.hostname === '127.0.0.1') &&
					(
						absoluteUrl.pathname.startsWith('/uploads/') ||
						/^\/api\/whiteboard\/boards\/[^/]+\/files\//.test(absoluteUrl.pathname)
					);
				if (isLocalAsset) {
					return `${getServerUrl()}${absoluteUrl.pathname}${absoluteUrl.search}${absoluteUrl.hash}`;
				}
			} catch {
				// fall through to original URL
			}
			return attachmentUrl;
		}
		const normalizedPath = attachmentUrl.startsWith('/') ? attachmentUrl : `/${attachmentUrl}`;
		return `${getServerUrl()}${normalizedPath}`;
	}

	function isImageAlbumItem(item: MediaAlbumItem): boolean {
		const mime = (item.attachmentMime || '').toLowerCase();
		return mime.startsWith('image/') || /\.(avif|bmp|gif|heic|jpe?g|png|svg|webp)$/i.test(item.attachmentName);
	}

	function isVideoAlbumItem(item: MediaAlbumItem): boolean {
		const mime = (item.attachmentMime || '').toLowerCase();
		return mime.startsWith('video/') || /\.(m4v|mov|mp4|ogv|webm)$/i.test(item.attachmentName);
	}

	function albumItemKindLabel(item: MediaAlbumItem): string {
		if (isImageAlbumItem(item)) return 'Image';
		if (isVideoAlbumItem(item)) return 'Video';
		if ((item.attachmentMime || '').startsWith('audio/')) return 'Audio';
		const extension = item.attachmentName.split('.').pop()?.trim();
		return extension ? extension.toUpperCase() : 'FILE';
	}

	function triggerAlbumUploadPicker(mode: 'draft' | 'instant' = 'draft'): void {
		uploadPickerMode = mode;
		if (mode === 'instant') {
			draftUploadCaption = '';
		}
		uploadInputElement?.click();
	}

	function getAlbumPreviewItems(albumId: number): MediaAlbumItem[] {
		return albumPreviewMap[albumId] || [];
	}

	function closeAlbumContextMenu(): void {
		albumContextMenu = null;
	}

	function openAlbumContextMenu(event: MouseEvent, albumId: number): void {
		event.preventDefault();
		if (typeof window === 'undefined') {
			albumContextMenu = { albumId, x: 0, y: 0 };
			return;
		}
		const menuWidth = 220;
		const menuHeight = 220;
		albumContextMenu = {
			albumId,
			x: Math.max(12, Math.min(event.clientX, window.innerWidth - menuWidth - 12)),
			y: Math.max(12, Math.min(event.clientY, window.innerHeight - menuHeight - 12))
		};
	}

	function buildAlbumAnnouncement(album: MediaAlbum): string {
		if (scopeType === 'dm') {
			return `Opened album "${album.name}". Add images from the Albums tab.`;
		}
		return `Opened album "${album.name}" for this channel. Add images from the Albums tab.`;
	}

	function formatAlbumActionError(
		error: unknown,
		fallback: string,
		context: { mode: 'upload' | 'url' }
	): string {
		if (error instanceof MediaAlbumApiError) {
			if (error.code === 'ALBUM_UPLOAD_SIZE_LIMIT') {
				const maxBytes = typeof error.details?.maxBytes === 'number' ? error.details.maxBytes : null;
				if (maxBytes !== null) {
					return `Album item exceeds your role size limit (${formatBytes(maxBytes)} max).`;
				}
				return 'Album item exceeds your role size limit.';
			}
			if (error.code === 'ALBUM_UPLOAD_RATE_LIMIT_USER') {
				const retry = error.retryAfterSeconds ?? 60;
				return `You reached the album upload limit for this minute. Try again in ${retry}s.`;
			}
			if (error.code === 'ALBUM_UPLOAD_RATE_LIMIT_SCOPE') {
				const retry = error.retryAfterSeconds ?? 60;
				return `This channel/DM album scope is currently rate-limited. Try again in ${retry}s.`;
			}
		}
		if (error instanceof Error && error.message.trim()) return error.message;
		return context.mode === 'upload' ? 'Failed to upload album file' : fallback;
	}

	function currentUserDbId(): number | null {
		return typeof $currentUser?.dbUserId === 'number' ? $currentUser.dbUserId : null;
	}

	function canModerateAlbums(): boolean {
		const role = ($currentUser?.highestRole || '').toLowerCase();
		return role === 'owner' || role === 'admin' || role === 'mod';
	}

	function canDeleteAlbum(album: MediaAlbum | null): boolean {
		if (!album) return false;
		const dbUserId = currentUserDbId();
		if (dbUserId !== null && album.createdBy === dbUserId) return true;
		return canModerateAlbums();
	}

	function canFeatureAlbum(album: MediaAlbum | null): boolean {
		if (!album) return false;
		const dbUserId = currentUserDbId();
		if (dbUserId !== null && album.createdBy === dbUserId) return true;
		return canModerateAlbums();
	}

	function canDeleteItem(item: MediaAlbumItem, album: MediaAlbum | null): boolean {
		const dbUserId = currentUserDbId();
		if (dbUserId !== null && item.uploadedBy === dbUserId) return true;
		if (dbUserId !== null && album && album.createdBy === dbUserId) return true;
		return canModerateAlbums();
	}

	$: selectedAlbumValue = selectedAlbum();
	$: contextMenuAlbumValue = albumContextMenu
		? albums.find((album) => album.id === albumContextMenu?.albumId) || null
		: null;
	$: albumPreviewItems = albumItems.filter((item) => isImageAlbumItem(item) || isVideoAlbumItem(item)).slice(0, 4);
	$: albumViewerCurrentItem =
		albumViewerOpen && albumViewerItems.length > 0
			? albumViewerItems[Math.max(0, Math.min(albumViewerIndex, albumViewerItems.length - 1))] || null
			: null;
	$: normalizedItemSearch = itemSearchQuery.trim().toLowerCase();
	$: isManualSortMode = itemSortMode === 'manual';
	$: canDragReorderItems = isManualSortMode && !normalizedItemSearch && !!selectedAlbumId;
	$: filteredAlbumItems = albumItems
		.filter((item) => {
			if (!normalizedItemSearch) return true;
			return (
				item.attachmentName.toLowerCase().includes(normalizedItemSearch) ||
				(item.caption || '').toLowerCase().includes(normalizedItemSearch)
			);
		})
		.slice()
		.sort((a, b) => {
			if (isManualSortMode) {
				return 0;
			}
			if (itemSortMode === 'name') {
				return a.attachmentName.localeCompare(b.attachmentName);
			}
			if (itemSortMode === 'oldest') {
				return a.uploadedAt - b.uploadedAt;
			}
			return b.uploadedAt - a.uploadedAt;
		});
	$: totalItemPages = isManualSortMode ? 1 : Math.max(1, Math.ceil(filteredAlbumItems.length / ITEMS_PER_PAGE));
	$: pagedAlbumItems = isManualSortMode
		? filteredAlbumItems
		: filteredAlbumItems.slice(
				(currentItemsPage - 1) * ITEMS_PER_PAGE,
				currentItemsPage * ITEMS_PER_PAGE
			);
	$: if (currentItemsPage > totalItemPages) {
		currentItemsPage = totalItemPages;
	}
	$: {
		const key = `${selectedAlbumId ?? 'none'}::${itemSearchQuery}::${itemSortMode}`;
		if (key !== lastItemsControlKey) {
			lastItemsControlKey = key;
			currentItemsPage = 1;
		}
	}
	$: if (activePrefsScopeKey) {
		persistScopeViewPreferences(activePrefsScopeKey);
	}

	async function handleAlbumFileChange(event: Event): Promise<void> {
		const input = event.target as HTMLInputElement;
		draftUploadFile = input.files?.[0] || null;
		input.value = '';
		const selectedMode = uploadPickerMode;
		uploadPickerMode = 'draft';
		if (!draftUploadFile || selectedMode !== 'instant') return;
		await addUploadedFileItem();
	}

	async function ensureAlbumSelected(albumId: number): Promise<void> {
		if (selectedAlbumId !== albumId) {
			selectedAlbumId = albumId;
			await tick();
		}
	}

	function getAlbumViewerItems(items: MediaAlbumItem[]): MediaAlbumItem[] {
		return items.filter((item) => isImageAlbumItem(item) || isVideoAlbumItem(item));
	}

	function closeAlbumViewer(): void {
		albumViewerOpen = false;
		albumViewerItems = [];
		albumViewerAlbumId = null;
		albumViewerAlbumName = '';
		albumViewerIndex = 0;
	}

	async function openAlbumUpload(albumId: number): Promise<void> {
		await ensureAlbumSelected(albumId);
		triggerAlbumUploadPicker('instant');
		void loadAlbumItems(albumId);
	}

	async function openAlbumViewer(albumId: number, preferredIndex = 0): Promise<void> {
		const loadedItems = await loadAlbumItems(albumId);
		const mediaItems = getAlbumViewerItems(loadedItems);
		const album = albums.find((entry) => entry.id === albumId) || null;
		if (mediaItems.length === 0) {
			if (album?.itemCount === 0) {
				await openAlbumUpload(albumId);
			}
			return;
		}
		albumViewerAlbumId = albumId;
		albumViewerAlbumName = album?.name || 'Album';
		albumViewerItems = mediaItems;
		albumViewerIndex = Math.max(0, Math.min(preferredIndex, mediaItems.length - 1));
		albumViewerOpen = true;
	}

	async function handleAlbumCardActivate(album: MediaAlbum): Promise<void> {
		if (album.itemCount === 0) {
			await openAlbumUpload(album.id);
			return;
		}
		await openAlbumViewer(album.id);
	}

	async function handleAlbumPreviewActivate(album: MediaAlbum, previewIndex: number): Promise<void> {
		await openAlbumViewer(album.id, previewIndex);
	}

	function resetUploadDraft(): void {
		draftUploadFile = null;
		draftUploadCaption = '';
		uploadPickerMode = 'draft';
		if (uploadInputElement) {
			uploadInputElement.value = '';
		}
	}

	async function uploadAlbumFile(token: string, file: File): Promise<{
		fileUrl: string;
		fileName: string;
		fileSize: number;
	}> {
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

	async function addUploadedFileItem(): Promise<void> {
		const token = getAuthToken();
		if (!token || !selectedAlbumId || isUploadingAlbumFile || !draftUploadFile) return;

		clearSuccess();
		isUploadingAlbumFile = true;
		clearError();
		try {
			const uploaded = await uploadAlbumFile(token, draftUploadFile);
			await addMediaAlbumItem(token, selectedAlbumId, {
				attachmentUrl: uploaded.fileUrl,
				attachmentName: uploaded.fileName,
				attachmentSize: uploaded.fileSize,
				attachmentMime: draftUploadFile.type || null,
				caption: draftUploadCaption.trim() || null
			});
			const refreshedItems = await loadAlbumItems(selectedAlbumId);
			if (albumViewerAlbumId === selectedAlbumId) {
				albumViewerItems = getAlbumViewerItems(refreshedItems);
				albumViewerIndex = Math.max(
					0,
					Math.min(albumViewerIndex, Math.max(albumViewerItems.length - 1, 0))
				);
			}
			resetUploadDraft();
			await refreshAlbums(false);
			lastUploadedAlbumId = selectedAlbumId;
			successMessage = `Added "${uploaded.fileName}" to "${selectedAlbum()?.name || 'album'}".`;
		} catch (error) {
			clearSuccess();
			errorMessage = formatAlbumActionError(error, 'Failed to upload album file', { mode: 'upload' });
		} finally {
			isUploadingAlbumFile = false;
		}
	}

	async function refreshAlbums(selectFirst = false): Promise<void> {
		const token = getAuthToken();
		if (!token || !scopeId) {
			albums = [];
			selectedAlbumId = null;
			albumItems = [];
			albumPreviewMap = {};
			lastUploadedAlbumId = null;
			clearSuccess();
			return;
		}

		isLoadingAlbums = true;
		clearError();
		try {
			const scopeKeyAtStart = `${scopeType}:${scopeId}`;
			const nextAlbums = sortAlbumsForDisplay(await listMediaAlbums(token, scopeType, scopeId, 200));
			albums = nextAlbums;
			const albumIds = new Set(nextAlbums.map((album) => album.id));
			albumPreviewMap = Object.fromEntries(
				Object.entries(albumPreviewMap).filter(([albumId]) => albumIds.has(Number(albumId)))
			);

			if (nextAlbums.length === 0) {
				selectedAlbumId = null;
				albumItems = [];
				albumPreviewMap = {};
				lastUploadedAlbumId = null;
				return;
			}

			const selectedStillExists = selectedAlbumId && nextAlbums.some((album) => album.id === selectedAlbumId);
			if (!selectedStillExists && (selectFirst || selectedAlbumId === null)) {
				const preferredAlbum = nextAlbums.find((album) => album.isFeatured) || nextAlbums[0];
				selectedAlbumId = preferredAlbum.id;
				await loadAlbumItems(preferredAlbum.id);
			} else if (selectedStillExists && selectedAlbumId) {
				await loadAlbumItems(selectedAlbumId);
			}

			const previewTargets = nextAlbums
				.filter((album) => albumPreviewMap[album.id] === undefined)
				.slice(0, 18);
			if (previewTargets.length > 0) {
				const previewResults = await Promise.allSettled(
					previewTargets.map((album) => listMediaAlbumItems(token, album.id, 4))
				);
				if (`${scopeType}:${scopeId}` === scopeKeyAtStart) {
					const nextPreviewMap = { ...albumPreviewMap };
					previewResults.forEach((result, index) => {
						const album = previewTargets[index];
						if (!album) return;
						nextPreviewMap[album.id] =
							result.status === 'fulfilled'
								? result.value.items.filter((item) => isImageAlbumItem(item) || isVideoAlbumItem(item)).slice(0, 3)
								: [];
					});
					albumPreviewMap = nextPreviewMap;
				}
			}
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to load media albums';
		} finally {
			isLoadingAlbums = false;
		}
	}

	async function createAlbumFromInput(): Promise<void> {
		const token = getAuthToken();
		const name = newAlbumName.trim();
		if (!token || !scopeId || !name || isCreatingAlbum) return;

		isCreatingAlbum = true;
		clearSuccess();
		clearError();
		try {
			const created = await createMediaAlbum(token, {
				scopeType,
				scopeId,
				name
			});
			newAlbumName = '';
			await refreshAlbums(false);
			selectedAlbumId = created.id;
			await loadAlbumItems(created.id);
			successMessage = `Created album "${created.name}".`;
			void sendMessage(scopeId, buildAlbumAnnouncement(created), 'text').catch(() => undefined);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to create album';
		} finally {
			isCreatingAlbum = false;
		}
	}

	async function loadAlbumItems(albumId: number): Promise<MediaAlbumItem[]> {
		const token = getAuthToken();
		if (!token || !albumId) {
			albumItems = [];
			return [];
		}

		isLoadingItems = true;
		clearError();
		try {
			const response = await listMediaAlbumItems(token, albumId, 500);
			albumItems = response.items;
			albumPreviewMap = {
				...albumPreviewMap,
				[albumId]: response.items.filter((item) => isImageAlbumItem(item) || isVideoAlbumItem(item)).slice(0, 3)
			};
			return response.items;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to load album items';
			albumItems = [];
			return [];
		} finally {
			isLoadingItems = false;
		}
	}

	async function openAlbum(albumId: number): Promise<void> {
		await ensureAlbumSelected(albumId);
		await loadAlbumItems(albumId);
	}

	async function toggleFeaturedAlbum(album: MediaAlbum): Promise<void> {
		const token = getAuthToken();
		if (!token || isSavingFeaturedAlbum) return;
		if (!canFeatureAlbum(album)) {
			errorMessage = 'Only album owner or moderators can change featured album state.';
			return;
		}

		isSavingFeaturedAlbum = true;
		clearSuccess();
		clearError();
		try {
			const updated = await setMediaAlbumFeatured(token, album.id, !album.isFeatured);
			const mapped = albums.map((entry) => {
				if (entry.scopeType !== updated.scopeType || entry.scopeId !== updated.scopeId) return entry;
				if (updated.isFeatured) {
					return entry.id === updated.id ? updated : { ...entry, isFeatured: false };
				}
				return entry.id === updated.id ? updated : entry;
			});
			albums = sortAlbumsForDisplay(mapped);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to update featured album state';
		} finally {
			isSavingFeaturedAlbum = false;
		}
	}

	async function persistAlbumItemOrder(nextItems: MediaAlbumItem[]): Promise<void> {
		const token = getAuthToken();
		if (!token || !selectedAlbumId || isSavingItemOrder) return;
		isSavingItemOrder = true;
		clearError();
		try {
			const itemIds = nextItems.map((item) => item.id);
			const reorderedItems = await reorderMediaAlbumItems(token, selectedAlbumId, itemIds);
			if (reorderedItems.length > 0) {
				albumItems = reorderedItems;
			}
			await refreshAlbums(false);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to save album item order';
			await loadAlbumItems(selectedAlbumId);
		} finally {
			isSavingItemOrder = false;
		}
	}

	function moveAlbumItemLocally(movingItemId: number, targetItemId: number): MediaAlbumItem[] | null {
		const fromIndex = albumItems.findIndex((item) => item.id === movingItemId);
		const toIndex = albumItems.findIndex((item) => item.id === targetItemId);
		if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return null;
		const next = albumItems.slice();
		const [moving] = next.splice(fromIndex, 1);
		if (!moving) return null;
		next.splice(toIndex, 0, moving);
		return next.map((item, index) => ({ ...item, sortOrder: index + 1 }));
	}

	async function handleItemDrop(targetItemId: number): Promise<void> {
		if (!canDragReorderItems || draggingItemId === null || draggingItemId === targetItemId) {
			draggingItemId = null;
			return;
		}
		const album = selectedAlbum();
		if (!canFeatureAlbum(album)) {
			errorMessage = 'Only album owner or moderators can reorder this album.';
			draggingItemId = null;
			return;
		}
		const nextItems = moveAlbumItemLocally(draggingItemId, targetItemId);
		draggingItemId = null;
		if (!nextItems) return;
		albumItems = nextItems;
		await persistAlbumItemOrder(nextItems);
	}

	async function addDebugItem(): Promise<void> {
		const token = getAuthToken();
		if (!token || !selectedAlbumId || isAddingItem) return;
		const attachmentUrl = draftAttachmentUrl.trim();
		const attachmentName = draftAttachmentName.trim();
		if (!attachmentUrl || !attachmentName) return;

		isAddingItem = true;
		clearSuccess();
		clearError();
		try {
			await addMediaAlbumItem(token, selectedAlbumId, {
				attachmentUrl,
				attachmentName,
				attachmentMime: draftAttachmentMime.trim() || null,
				caption: draftCaption.trim() || null
			});
			draftAttachmentUrl = '';
			draftAttachmentName = '';
			draftAttachmentMime = '';
			draftCaption = '';
			await loadAlbumItems(selectedAlbumId);
			await refreshAlbums(false);
			lastUploadedAlbumId = selectedAlbumId;
			successMessage = `Added "${attachmentName}" to "${selectedAlbum()?.name || 'album'}".`;
		} catch (error) {
			errorMessage = formatAlbumActionError(error, 'Failed to add album item', { mode: 'url' });
		} finally {
			isAddingItem = false;
		}
	}

	async function removeAlbum(albumId: number): Promise<void> {
		const token = getAuthToken();
		if (!token || !albumId || isDeletingAlbum) return;
		const album = albums.find((entry) => entry.id === albumId) || null;
		if (!canDeleteAlbum(album)) {
			errorMessage = 'Only album owner or moderators can delete this album.';
			return;
		}
		const label = album?.name || `#${albumId}`;
		if (!confirm(`Delete album "${label}"? This removes all album items.`)) return;

		isDeletingAlbum = true;
		clearSuccess();
		clearError();
		try {
			await deleteMediaAlbum(token, albumId);
			if (selectedAlbumId === albumId) {
				selectedAlbumId = null;
				albumItems = [];
			}
			if (albumViewerAlbumId === albumId) {
				closeAlbumViewer();
			}
			const { [albumId]: _, ...remainingPreviewMap } = albumPreviewMap;
			albumPreviewMap = remainingPreviewMap;
			closeAlbumContextMenu();
			await refreshAlbums(true);
			if (lastUploadedAlbumId === albumId) {
				lastUploadedAlbumId = null;
			}
			successMessage = `Deleted album "${label}".`;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to delete album';
		} finally {
			isDeletingAlbum = false;
		}
	}

	async function removeSelectedAlbum(): Promise<void> {
		if (!selectedAlbumId) return;
		await removeAlbum(selectedAlbumId);
	}

	async function removeItem(itemId: number): Promise<void> {
		const token = getAuthToken();
		if (!token || !selectedAlbumId || deletingItemId !== null) return;
		const item = albumItems.find((entry) => entry.id === itemId);
		if (!item) {
			errorMessage = 'Album item not found.';
			return;
		}
		if (!canDeleteItem(item, selectedAlbum())) {
			errorMessage = 'Only item owner, album owner, or moderators can delete this item.';
			return;
		}
		const label = item?.attachmentName || `item #${itemId}`;
		if (!confirm(`Delete "${label}" from this album?`)) return;

		deletingItemId = itemId;
		clearSuccess();
		clearError();
		try {
			await deleteMediaAlbumItem(token, selectedAlbumId, itemId);
			await loadAlbumItems(selectedAlbumId);
			await refreshAlbums(false);
			successMessage = `Removed "${label}" from "${selectedAlbum()?.name || 'album'}".`;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to delete album item';
		} finally {
			deletingItemId = null;
		}
	}

	onMount(() => {
		void refreshAlbums(true);
		const handleWindowPointerDown = (): void => {
			closeAlbumContextMenu();
		};
		const handleWindowKeydown = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') {
				if (albumViewerOpen) {
					closeAlbumViewer();
					return;
				}
				closeAlbumContextMenu();
				return;
			}
			if (!albumViewerOpen || albumViewerItems.length <= 1) return;
			if (event.key === 'ArrowLeft') {
				event.preventDefault();
				albumViewerIndex =
					(albumViewerIndex - 1 + albumViewerItems.length) % albumViewerItems.length;
			}
			if (event.key === 'ArrowRight') {
				event.preventDefault();
				albumViewerIndex = (albumViewerIndex + 1) % albumViewerItems.length;
			}
		};
		window.addEventListener('pointerdown', handleWindowPointerDown);
		window.addEventListener('keydown', handleWindowKeydown);
		autoRefreshTimer = setInterval(() => {
			if (!scopeId || isLoadingAlbums) return;
			void refreshAlbums(false);
		}, 20000);

		return () => {
			window.removeEventListener('pointerdown', handleWindowPointerDown);
			window.removeEventListener('keydown', handleWindowKeydown);
		};
	});

	onDestroy(() => {
		if (autoRefreshTimer) {
			clearInterval(autoRefreshTimer);
			autoRefreshTimer = null;
		}
	});

	$: {
		const scopeKey = `${scopeType}:${scopeId}`;
		if (scopeId && scopeKey !== lastScopeKey) {
			lastScopeKey = scopeKey;
			lastUploadedAlbumId = null;
			clearSuccess();
			applyScopeViewPreferences(scopeKey);
			activePrefsScopeKey = scopeKey;
			void refreshAlbums(true);
		}
		if (!scopeId) {
			lastScopeKey = '';
			activePrefsScopeKey = '';
			albums = [];
			selectedAlbumId = null;
			albumItems = [];
			albumPreviewMap = {};
			lastUploadedAlbumId = null;
			clearSuccess();
			closeAlbumContextMenu();
		}
	}
</script>

<div class="media-albums-tab">
	<div class="section-header">
		<h3>Media Albums</h3>
	</div>
	<p class="scope-label">{scopeLabel}</p>
	<p class="scope-label">Albums stay scoped to the current channel/DM for privacy.</p>

	{#if !getAuthToken()}
		<div class="empty-state">
			Sign in to create and browse persistent albums.
		</div>
	{:else}
		<div class="create-row">
			<input
				type="text"
				bind:value={newAlbumName}
				placeholder="New album name"
				maxlength="80"
				on:keydown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						void createAlbumFromInput();
					}
				}}
			/>
			<button
				on:click={() => void createAlbumFromInput()}
				disabled={!scopeId || !newAlbumName.trim() || isCreatingAlbum}
			>
				{isCreatingAlbum ? 'Creating...' : 'Create'}
			</button>
		</div>

		{#if errorMessage}
			<div class="error-banner">{errorMessage}</div>
		{/if}
		{#if successMessage}
			<div class="success-banner">{successMessage}</div>
		{/if}

		<div class="album-list">
			{#if isLoadingAlbums}
				<div class="empty-state">Loading albums...</div>
			{:else if albums.length === 0}
				<div class="empty-state">{scopeType === 'dm' ? 'No albums in this conversation yet.' : 'No albums in this channel yet.'}</div>
			{:else}
				{#each albums as album}
					{@const previewItems = getAlbumPreviewItems(album.id)}
					<div
						class="album-card"
						class:featured={album.isFeatured}
						class:selected={selectedAlbumId === album.id}
						class:uploading={selectedAlbumId === album.id && isUploadingAlbumFile}
						role="button"
						tabindex="0"
						on:click={() => void handleAlbumCardActivate(album)}
						on:contextmenu={(event) => openAlbumContextMenu(event, album.id)}
						on:keydown={(event) => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault();
								void handleAlbumCardActivate(album);
							}
						}}
					>
						<div class="album-name-row">
							<div class="album-name-stack">
								<div class="album-name">{album.name}</div>
								{#if albumRowStatus(album)}
									<span class="album-row-status">{albumRowStatus(album)}</span>
								{/if}
							</div>
							<div class="album-card-actions">
								{#if album.isFeatured}
									<span class="featured-badge">Featured</span>
								{/if}
								<button
									type="button"
									class="album-quick-btn"
									title="Add file to album"
									aria-label={`Add file to ${album.name}`}
									on:click|stopPropagation={() => void openAlbumUpload(album.id)}
								>
									+
								</button>
								{#if canDeleteAlbum(album)}
									<button
										type="button"
										class="album-quick-btn album-quick-btn--danger"
										title="Delete album"
										aria-label={`Delete ${album.name}`}
										on:click|stopPropagation={() => void removeAlbum(album.id)}
									>
										Delete
									</button>
								{/if}
							</div>
						</div>
						<div class="album-card-preview-row">
							{#if previewItems.length > 0}
								{#each previewItems as previewItem, previewIndex}
									<button
										type="button"
										class="album-card-preview"
										aria-label={`Open ${album.name} preview ${previewIndex + 1}`}
										on:click|stopPropagation={() => void handleAlbumPreviewActivate(album, previewIndex)}
									>
										{#if isVideoAlbumItem(previewItem)}
											<video muted playsinline preload="metadata">
												<source
													src={resolveAlbumAssetUrl(previewItem.attachmentUrl)}
													type={previewItem.attachmentMime || undefined}
												/>
											</video>
										{:else}
											<img
												src={resolveAlbumAssetUrl(previewItem.attachmentUrl)}
												alt=""
												loading="lazy"
												decoding="async"
											/>
										{/if}
									</button>
								{/each}
							{:else}
								<div class="album-card-placeholder">
									{selectedAlbumId === album.id && isUploadingAlbumFile
										? 'Uploading into this album...'
										: album.itemCount > 0
											? 'Open album gallery'
											: 'Click row to upload the first image'}
								</div>
							{/if}
						</div>
						<div class="album-meta">
							<span>{album.itemCount} items</span>
							<span>Updated {formatTimestamp(album.updatedAt)}</span>
						</div>
					</div>
				{/each}
			{/if}
		</div>

		{#if albumContextMenu && contextMenuAlbumValue}
			<div
				class="album-context-menu"
				style={`left: ${albumContextMenu.x}px; top: ${albumContextMenu.y}px;`}
				on:pointerdown|stopPropagation
			>
				<button type="button" on:click={() => { closeAlbumContextMenu(); void openAlbum(contextMenuAlbumValue.id); }}>
					Open album
				</button>
				<button type="button" on:click={() => { closeAlbumContextMenu(); void openAlbumUpload(contextMenuAlbumValue.id); }}>
					Add file
				</button>
				{#if canFeatureAlbum(contextMenuAlbumValue)}
					<button type="button" on:click={() => { closeAlbumContextMenu(); void toggleFeaturedAlbum(contextMenuAlbumValue); }}>
						{contextMenuAlbumValue.isFeatured ? 'Unfeature album' : 'Feature album'}
					</button>
				{/if}
				{#if canDeleteAlbum(contextMenuAlbumValue)}
					<button
						type="button"
						class="danger"
						on:click={() => { closeAlbumContextMenu(); void removeAlbum(contextMenuAlbumValue.id); }}
					>
						Delete album
					</button>
				{/if}
			</div>
		{/if}

		{#if selectedAlbumValue}
			<div class="items-section">
				<div class="items-header">
					<div class="items-header-title">
						<strong>{selectedAlbumValue.name}</strong>
						<span>
							{albumItems.length} loaded
							{#if selectedAlbumValue.isFeatured}
								&middot; featured
							{/if}
						</span>
					</div>
					<div class="items-header-actions">
						<button
							type="button"
							class="album-plus-btn"
							on:click={() => triggerAlbumUploadPicker('instant')}
							title="Add file to album"
							aria-label="Add file to album"
						>
							+
						</button>
						{#if canFeatureAlbum(selectedAlbumValue)}
							<button
								class="feature-btn"
								class:active={selectedAlbumValue.isFeatured}
								on:click={() => void toggleFeaturedAlbum(selectedAlbumValue)}
								disabled={isSavingFeaturedAlbum}
								title={selectedAlbumValue.isFeatured ? 'Unpin featured album' : 'Pin as featured album'}
							>
								{selectedAlbumValue.isFeatured ? 'Unfeature album' : 'Feature album'}
							</button>
						{/if}
						<button
							class="danger-btn"
							on:click={() => void removeSelectedAlbum()}
							disabled={isDeletingAlbum || !canDeleteAlbum(selectedAlbumValue)}
							title="Delete this album"
						>
							{isDeletingAlbum ? 'Deleting...' : 'Delete album'}
						</button>
					</div>
				</div>
				{#if albumPreviewItems.length > 0}
					<div class="album-preview-strip">
						{#each albumPreviewItems as previewItem}
							<a
								class="album-preview-chip"
								href={resolveAlbumAssetUrl(previewItem.attachmentUrl)}
								target="_blank"
								rel="noreferrer"
								title={previewItem.attachmentName}
							>
								{#if isVideoAlbumItem(previewItem)}
									<video muted playsinline preload="metadata">
										<source
											src={resolveAlbumAssetUrl(previewItem.attachmentUrl)}
											type={previewItem.attachmentMime || undefined}
										/>
									</video>
								{:else}
									<img
										src={resolveAlbumAssetUrl(previewItem.attachmentUrl)}
										alt={previewItem.attachmentName}
										loading="lazy"
										decoding="async"
									/>
								{/if}
							</a>
						{/each}
					</div>
				{/if}
				{#if !canDeleteAlbum(selectedAlbumValue)}
					<div class="permission-hint">Only the album owner or moderators can delete this album.</div>
				{/if}

				<div class="upload-local-item">
					<input
						type="file"
						bind:this={uploadInputElement}
						class="album-file-input"
						on:change={handleAlbumFileChange}
						accept="image/*,video/*,audio/*,.zip,.pdf,.txt,.md"
					/>
						<div
							class="upload-local-row"
							role="button"
							tabindex="0"
							on:click={() => triggerAlbumUploadPicker()}
							on:keydown={(event) => {
								if (event.key === 'Enter' || event.key === ' ') {
									event.preventDefault();
									triggerAlbumUploadPicker();
								}
						}}
					>
						<button
							type="button"
							class="album-upload-trigger"
							on:click|stopPropagation={() => triggerAlbumUploadPicker()}
							title="Choose file for this album"
							aria-label="Choose file for this album"
						>
							+
						</button>
						<div class="upload-local-copy">
							<strong>Add to this album</strong>
							<span>{draftUploadFile ? draftUploadFile.name : 'Pick an image, video, or file to add.'}</span>
						</div>
						<button
							on:click|stopPropagation={() => void addUploadedFileItem()}
							disabled={isUploadingAlbumFile || !draftUploadFile}
						>
							{isUploadingAlbumFile ? 'Uploading...' : 'Upload to album'}
						</button>
					</div>
					{#if draftUploadFile}
						<div class="upload-local-meta">
							<span>{draftUploadFile.name}</span>
							<span>{formatBytes(draftUploadFile.size)}</span>
						</div>
					{/if}
					<input
						type="text"
						bind:value={draftUploadCaption}
						placeholder="Caption for uploaded file (optional)"
					/>
				</div>

				<details class="debug-add-item">
					<summary>Advanced: add item by URL</summary>
					<div class="debug-form">
						<input type="text" bind:value={draftAttachmentUrl} placeholder="Attachment URL" />
						<input type="text" bind:value={draftAttachmentName} placeholder="Attachment name" />
						<input type="text" bind:value={draftAttachmentMime} placeholder="MIME type (optional)" />
						<input type="text" bind:value={draftCaption} placeholder="Caption (optional)" />
						<button
							on:click={() => void addDebugItem()}
							disabled={isAddingItem || !draftAttachmentUrl.trim() || !draftAttachmentName.trim()}
						>
							{isAddingItem ? 'Adding...' : 'Add'}
						</button>
					</div>
				</details>

				<div class="item-toolbar">
					<div class="item-toolbar-left">
						<input
							type="search"
							bind:value={itemSearchQuery}
							placeholder="Search album items..."
						/>
					</div>
					<div class="item-toolbar-right">
						<select bind:value={itemSortMode}>
							<option value="manual">Manual order</option>
							<option value="newest">Newest first</option>
							<option value="oldest">Oldest first</option>
							<option value="name">Name (A-Z)</option>
						</select>
						<div class="view-toggle">
							<button class:active={itemViewMode === 'grid'} on:click={() => (itemViewMode = 'grid')}>Grid</button>
							<button class:active={itemViewMode === 'list'} on:click={() => (itemViewMode = 'list')}>List</button>
						</div>
					</div>
				</div>

				<div class="item-toolbar-summary">
					Showing {pagedAlbumItems.length} of {filteredAlbumItems.length} items
					{#if isManualSortMode}
						{#if normalizedItemSearch}
							&middot; clear search to reorder items
						{:else if canDragReorderItems}
							&middot; drag and drop to reorder
						{/if}
					{/if}
					{#if isSavingItemOrder}
						&middot; saving order...
					{/if}
				</div>

				<div class="item-list" class:grid-view={itemViewMode === 'grid'}>
					{#if isLoadingItems}
						<div class="empty-state">Loading items...</div>
					{:else if albumItems.length === 0}
						<div class="empty-state">No items in this album yet.</div>
					{:else if filteredAlbumItems.length === 0}
						<div class="empty-state">No items match this search.</div>
					{:else}
						{#each pagedAlbumItems as item}
							<div
								class="item-row"
								class:dragging={draggingItemId === item.id}
								role="listitem"
								draggable={canDragReorderItems}
								on:dragstart={() => (draggingItemId = item.id)}
								on:dragend={() => (draggingItemId = null)}
								on:dragover|preventDefault
								on:drop|preventDefault={() => void handleItemDrop(item.id)}
							>
								<a
									class="item-preview"
									href={resolveAlbumAssetUrl(item.attachmentUrl)}
									target="_blank"
									rel="noreferrer"
									title={item.attachmentName}
								>
									{#if isImageAlbumItem(item)}
										<img
											src={resolveAlbumAssetUrl(item.attachmentUrl)}
											alt={item.attachmentName}
											loading="lazy"
											decoding="async"
										/>
									{:else if isVideoAlbumItem(item)}
										<video muted playsinline preload="metadata">
											<source
												src={resolveAlbumAssetUrl(item.attachmentUrl)}
												type={item.attachmentMime || undefined}
											/>
										</video>
									{:else}
										<div class="item-preview-fallback">{albumItemKindLabel(item)}</div>
									{/if}
								</a>
								<div class="item-main">
									<a href={resolveAlbumAssetUrl(item.attachmentUrl)} target="_blank" rel="noreferrer">
										{item.attachmentName}
									</a>
									<div class="item-kind-pill">{albumItemKindLabel(item)}</div>
									{#if item.caption}
										<div class="item-caption">{item.caption}</div>
									{/if}
								</div>
								<div class="item-meta">
									{#if item.attachmentSize !== null}
										<div>{(item.attachmentSize / 1024 / 1024).toFixed(2)} MB</div>
									{/if}
									<div>{formatTimestamp(item.uploadedAt)}</div>
									<button
										class="item-delete-btn"
										on:click={() => void removeItem(item.id)}
										disabled={deletingItemId !== null || !canDeleteItem(item, selectedAlbumValue)}
										title="Delete item from album"
									>
										{deletingItemId === item.id ? 'Deleting...' : 'Delete'}
									</button>
								</div>
							</div>
						{/each}
					{/if}
				</div>
				{#if !isLoadingItems && !isManualSortMode && filteredAlbumItems.length > ITEMS_PER_PAGE}
					<div class="pagination-row">
						<button on:click={() => currentItemsPage = Math.max(1, currentItemsPage - 1)} disabled={currentItemsPage <= 1}>
							Previous
						</button>
						<span>Page {currentItemsPage} / {totalItemPages}</span>
						<button on:click={() => currentItemsPage = Math.min(totalItemPages, currentItemsPage + 1)} disabled={currentItemsPage >= totalItemPages}>
							Next
						</button>
					</div>
				{/if}
			</div>
		{/if}
	{/if}

	{#if albumViewerOpen && albumViewerCurrentItem}
		<div
			class="album-viewer-backdrop"
			role="button"
			tabindex="0"
			on:click={closeAlbumViewer}
			on:keydown={(event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					closeAlbumViewer();
				}
			}}
		>
			<div
				class="album-viewer-modal"
				role="dialog"
				aria-modal="true"
				aria-label={albumViewerAlbumName}
				tabindex="-1"
			>
				<div class="album-viewer-header">
					<div class="album-viewer-copy">
						<strong>{albumViewerAlbumName}</strong>
						<span>{albumViewerIndex + 1} / {albumViewerItems.length}</span>
					</div>
					<div class="album-viewer-actions">
						<button type="button" class="album-viewer-action" on:click={() => albumViewerAlbumId && void openAlbumUpload(albumViewerAlbumId)}>
							Add media
						</button>
						<button type="button" class="album-viewer-close" on:click={closeAlbumViewer} aria-label="Close album viewer">
							X
						</button>
					</div>
				</div>
				<div class="album-viewer-stage">
					{#if isVideoAlbumItem(albumViewerCurrentItem)}
						<video controls autoplay playsinline>
							<source
								src={resolveAlbumAssetUrl(albumViewerCurrentItem.attachmentUrl)}
								type={albumViewerCurrentItem.attachmentMime || undefined}
							/>
						</video>
					{:else}
						<img
							src={resolveAlbumAssetUrl(albumViewerCurrentItem.attachmentUrl)}
							alt={albumViewerCurrentItem.attachmentName}
						/>
					{/if}
				</div>
				<div class="album-viewer-strip">
					{#each albumViewerItems as item, index}
						<button
							type="button"
							class="album-viewer-thumb"
							class:active={index === albumViewerIndex}
							on:click={() => (albumViewerIndex = index)}
							title={item.attachmentName}
						>
							{#if isVideoAlbumItem(item)}
								<video muted playsinline preload="metadata">
									<source
										src={resolveAlbumAssetUrl(item.attachmentUrl)}
										type={item.attachmentMime || undefined}
									/>
								</video>
							{:else}
								<img
									src={resolveAlbumAssetUrl(item.attachmentUrl)}
									alt={item.attachmentName}
									loading="lazy"
									decoding="async"
								/>
							{/if}
						</button>
					{/each}
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.media-albums-tab {
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
		height: 100%;
		padding: 0.7rem;
		overflow: auto;
	}

	.section-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.section-header h3 {
		font-size: 0.92rem;
		margin: 0;
	}

	.scope-label {
		margin: 0;
		font-size: 0.74rem;
		color: var(--text-secondary);
		word-break: break-all;
	}

	.create-row button,
	.debug-form button,
	.album-plus-btn,
	.album-upload-trigger {
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-primary);
		border-radius: 8px;
		padding: 0.42rem 0.58rem;
		font-size: 0.78rem;
		cursor: pointer;
	}

	.create-row button:hover,
	.debug-form button:hover,
	.album-plus-btn:hover,
	.album-upload-trigger:hover {
		border-color: rgba(var(--accent-rgb), 0.5);
	}

	.create-row button:disabled,
	.debug-form button:disabled,
	.album-plus-btn:disabled,
	.album-upload-trigger:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.create-row {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.45rem;
	}

	.upload-local-item {
		display: grid;
		gap: 0.45rem;
		padding: 0.7rem;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: rgba(var(--accent-rgb), 0.06);
	}

	.upload-local-row {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: 0.7rem;
		align-items: center;
		border-radius: 10px;
		cursor: pointer;
	}

	.upload-local-row:focus-visible {
		outline: 2px solid rgba(var(--accent-rgb), 0.45);
		outline-offset: 2px;
	}

	.album-file-input {
		display: none;
	}

	.album-plus-btn,
	.album-upload-trigger {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.1rem;
		height: 2.1rem;
		padding: 0;
		border-radius: 999px;
		font-size: 1.2rem;
		line-height: 1;
		font-weight: 600;
	}

	.upload-local-copy {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.16rem;
	}

	.upload-local-copy strong {
		font-size: 0.8rem;
	}

	.upload-local-copy span {
		font-size: 0.74rem;
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.upload-local-meta {
		display: flex;
		justify-content: space-between;
		font-size: 0.74rem;
		color: var(--text-secondary);
		gap: 0.5rem;
		word-break: break-all;
	}

	.create-row input,
	.debug-form input,
	.upload-local-item input {
		width: 100%;
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-primary);
		border-radius: 8px;
		padding: 0.46rem 0.55rem;
		font-size: 0.8rem;
	}

	.item-toolbar input,
	.item-toolbar select {
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-primary);
		border-radius: 8px;
		padding: 0.4rem 0.5rem;
		font-size: 0.77rem;
	}

	.error-banner {
		border: 1px solid rgba(220, 38, 38, 0.45);
		background: rgba(220, 38, 38, 0.12);
		color: #fecaca;
		padding: 0.45rem 0.55rem;
		border-radius: 8px;
		font-size: 0.76rem;
	}

	.success-banner {
		border: 1px solid rgba(34, 197, 94, 0.35);
		background: rgba(34, 197, 94, 0.12);
		color: #bbf7d0;
		padding: 0.45rem 0.55rem;
		border-radius: 8px;
		font-size: 0.76rem;
	}

	.album-list,
	.item-list {
		display: flex;
		flex-direction: column;
		gap: 0.42rem;
	}

	.album-card {
		display: block;
		width: 100%;
		border: 1px solid var(--border);
		background: rgba(255, 255, 255, 0.03);
		color: var(--text-primary);
		border-radius: 12px;
		padding: 0.6rem 0.7rem;
		text-align: left;
		cursor: pointer;
		transition: border-color 0.18s ease, background 0.18s ease, transform 0.18s ease;
	}

	.album-card.featured {
		border-color: rgba(var(--accent-rgb), 0.45);
	}

	.album-card.selected {
		border-color: rgba(var(--accent-rgb), 0.65);
		background: rgba(var(--accent-rgb), 0.14);
		box-shadow: 0 0 0 1px rgba(var(--accent-rgb), 0.18);
	}

	.album-card.uploading {
		border-color: rgba(34, 197, 94, 0.45);
		background: rgba(34, 197, 94, 0.12);
		box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.14);
	}

	.album-card:hover {
		border-color: rgba(var(--accent-rgb), 0.38);
	}

	.album-card:focus-visible {
		outline: 2px solid rgba(var(--accent-rgb), 0.45);
		outline-offset: 2px;
	}

	.album-name-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.4rem;
	}

	.album-name-stack {
		min-width: 0;
		display: grid;
		gap: 0.24rem;
	}

	.album-name {
		font-size: 0.84rem;
		font-weight: 600;
		min-width: 0;
		word-break: break-word;
	}

	.album-row-status {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: fit-content;
		padding: 0.14rem 0.42rem;
		border-radius: 999px;
		border: 1px solid rgba(var(--accent-rgb), 0.35);
		background: rgba(var(--accent-rgb), 0.14);
		font-size: 0.66rem;
		font-weight: 700;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		color: var(--text-secondary);
	}

	.album-card-actions {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		flex-shrink: 0;
	}

	.album-card-preview-row {
		display: flex;
		gap: 0.38rem;
		margin-top: 0.55rem;
		min-height: 4.2rem;
	}

	.album-card-preview {
		flex: 0 0 calc((100% - 0.76rem) / 3);
		height: 4.2rem;
		border-radius: 0.8rem;
		overflow: hidden;
		border: 1px solid var(--border);
		background: rgba(255, 255, 255, 0.04);
		padding: 0;
		cursor: pointer;
	}

	.album-card-preview img,
	.album-card-preview video {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.album-card-placeholder {
		display: grid;
		place-items: center;
		width: 100%;
		min-height: 4.2rem;
		padding: 0.55rem 0.7rem;
		border-radius: 0.8rem;
		border: 1px dashed var(--border);
		background: rgba(255, 255, 255, 0.03);
		font-size: 0.72rem;
		color: var(--text-secondary);
		text-align: center;
	}

	.album-viewer-backdrop {
		position: fixed;
		inset: 0;
		z-index: var(--z-modal, 1200);
		display: grid;
		place-items: center;
		padding: 1rem;
		background: rgba(2, 6, 23, 0.82);
		backdrop-filter: blur(10px);
	}

	.album-viewer-modal {
		width: min(1100px, 100%);
		max-height: min(92vh, 920px);
		display: grid;
		grid-template-rows: auto minmax(0, 1fr) auto;
		gap: 0.8rem;
		padding: 0.9rem;
		border-radius: 18px;
		border: 1px solid rgba(148, 163, 184, 0.22);
		background:
			linear-gradient(180deg, rgba(17, 24, 39, 0.98), rgba(15, 23, 42, 0.96)),
			rgba(15, 23, 42, 0.96);
		box-shadow: 0 28px 60px rgba(2, 6, 23, 0.42);
	}

	.album-viewer-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.8rem;
	}

	.album-viewer-copy {
		display: grid;
		gap: 0.18rem;
		color: #f8fafc;
	}

	.album-viewer-copy strong {
		font-size: 1rem;
	}

	.album-viewer-copy span {
		font-size: 0.78rem;
		color: #cbd5e1;
	}

	.album-viewer-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.album-viewer-action,
	.album-viewer-close {
		border: 1px solid rgba(148, 163, 184, 0.28);
		background: rgba(255, 255, 255, 0.08);
		color: #f8fafc;
		border-radius: 10px;
		padding: 0.42rem 0.68rem;
		cursor: pointer;
	}

	.album-viewer-close {
		width: 2.2rem;
		height: 2.2rem;
		padding: 0;
		font-weight: 700;
	}

	.album-viewer-stage {
		display: grid;
		place-items: center;
		min-height: 0;
		border-radius: 16px;
		overflow: hidden;
		background:
			radial-gradient(circle at top, rgba(255, 255, 255, 0.1), transparent 45%),
			rgba(15, 23, 42, 0.92);
		border: 1px solid rgba(148, 163, 184, 0.16);
	}

	.album-viewer-stage img,
	.album-viewer-stage video {
		display: block;
		max-width: 100%;
		max-height: min(68vh, 680px);
		object-fit: contain;
	}

	.album-viewer-strip {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(84px, 1fr));
		gap: 0.55rem;
	}

	.album-viewer-thumb {
		border: 1px solid rgba(148, 163, 184, 0.18);
		border-radius: 12px;
		padding: 0;
		overflow: hidden;
		background: rgba(255, 255, 255, 0.04);
		cursor: pointer;
	}

	.album-viewer-thumb.active {
		border-color: rgba(var(--accent-rgb), 0.7);
		box-shadow: 0 0 0 1px rgba(var(--accent-rgb), 0.22);
	}

	.album-viewer-thumb img,
	.album-viewer-thumb video {
		display: block;
		width: 100%;
		height: 84px;
		object-fit: cover;
	}

	.featured-badge {
		font-size: 0.66rem;
		color: var(--text-secondary);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0.12rem 0.34rem;
		background: rgba(var(--accent-rgb), 0.12);
	}

	.feature-btn {
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-primary);
		border-radius: 7px;
		padding: 0.22rem 0.4rem;
		font-size: 0.68rem;
		cursor: pointer;
	}

	.feature-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.feature-btn.active {
		border-color: rgba(var(--accent-rgb), 0.65);
		background: rgba(var(--accent-rgb), 0.2);
	}

	.album-quick-btn {
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-primary);
		border-radius: 999px;
		padding: 0.18rem 0.52rem;
		font-size: 0.7rem;
		cursor: pointer;
	}

	.album-quick-btn:hover {
		background: rgba(var(--accent-rgb), 0.12);
	}

	.album-quick-btn--danger {
		border-color: rgba(220, 38, 38, 0.45);
		color: #fecaca;
		background: rgba(220, 38, 38, 0.08);
	}

	.album-meta {
		margin-top: 0.42rem;
		display: flex;
		justify-content: space-between;
		font-size: 0.72rem;
		color: var(--text-secondary);
	}

	.album-context-menu {
		position: fixed;
		z-index: 1200;
		display: grid;
		gap: 0.2rem;
		min-width: 12.5rem;
		padding: 0.35rem;
		border-radius: 0.9rem;
		border: 1px solid var(--border);
		background: color-mix(in srgb, var(--bg-primary) 92%, black 8%);
		box-shadow: 0 18px 44px rgba(15, 23, 42, 0.28);
	}

	.album-context-menu button {
		border: none;
		background: transparent;
		color: var(--text-primary);
		border-radius: 0.7rem;
		padding: 0.55rem 0.7rem;
		text-align: left;
		cursor: pointer;
	}

	.album-context-menu button:hover {
		background: rgba(var(--accent-rgb), 0.14);
	}

	.album-context-menu button.danger {
		color: #fecaca;
	}

	.items-section {
		border-top: 1px solid var(--border);
		padding-top: 0.6rem;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}

	.permission-hint {
		font-size: 0.74rem;
		color: var(--text-secondary);
		padding: 0.45rem 0.5rem;
		border: 1px dashed var(--border);
		border-radius: 8px;
	}

	.items-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.items-header-actions {
		display: inline-flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.42rem;
	}

	.items-header-title {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.danger-btn {
		border: 1px solid rgba(220, 38, 38, 0.6);
		background: rgba(220, 38, 38, 0.14);
		color: #fecaca;
		border-radius: 8px;
		padding: 0.34rem 0.52rem;
		font-size: 0.74rem;
		cursor: pointer;
	}

	.danger-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.danger-btn:hover {
		background: rgba(220, 38, 38, 0.22);
	}

	.album-preview-strip {
		display: flex;
		gap: 0.45rem;
		overflow-x: auto;
		padding-bottom: 0.1rem;
	}

	.album-preview-chip {
		flex: 0 0 auto;
		width: 4.2rem;
		height: 4.2rem;
		border-radius: 0.9rem;
		overflow: hidden;
		border: 1px solid var(--border);
		background: rgba(255, 255, 255, 0.04);
		box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);
	}

	.album-preview-chip img,
	.album-preview-chip video {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.debug-add-item summary {
		cursor: pointer;
		font-size: 0.76rem;
		color: var(--text-secondary);
	}

	.debug-form {
		margin-top: 0.42rem;
		display: grid;
		gap: 0.4rem;
	}

	.item-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.item-toolbar-left {
		flex: 1;
		min-width: 0;
	}

	.item-toolbar-left input {
		width: 100%;
	}

	.item-toolbar-right {
		display: flex;
		align-items: center;
		gap: 0.45rem;
	}

	.view-toggle {
		display: inline-flex;
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
	}

	.view-toggle button {
		border: none;
		background: transparent;
		color: var(--text-secondary);
		font-size: 0.74rem;
		padding: 0.35rem 0.5rem;
		cursor: pointer;
	}

	.view-toggle button.active {
		background: rgba(var(--accent-rgb), 0.2);
		color: var(--text-primary);
	}

	.item-toolbar-summary {
		font-size: 0.72rem;
		color: var(--text-secondary);
	}

	.item-row {
		border: 1px solid var(--border);
		border-radius: 9px;
		padding: 0.45rem 0.55rem;
		display: grid;
		grid-template-columns: 5.25rem minmax(0, 1fr) auto;
		align-items: start;
		gap: 0.65rem;
	}

	.item-row[draggable='true'] {
		cursor: move;
	}

	.item-row.dragging {
		opacity: 0.6;
		border-color: rgba(var(--accent-rgb), 0.6);
	}

	.item-list.grid-view {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 0.45rem;
	}

	.item-list.grid-view .item-row {
		grid-template-columns: 1fr;
	}

	.item-list.grid-view .item-meta {
		width: 100%;
		align-items: flex-start;
		text-align: left;
	}

	.item-preview {
		display: flex;
		width: 5.25rem;
		height: 5.25rem;
		border-radius: 0.85rem;
		overflow: hidden;
		border: 1px solid var(--border);
		background: rgba(255, 255, 255, 0.04);
		text-decoration: none;
	}

	.item-preview img,
	.item-preview video {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.item-preview-fallback {
		display: grid;
		place-items: center;
		width: 100%;
		height: 100%;
		padding: 0.4rem;
		background:
			linear-gradient(135deg, rgba(var(--accent-rgb), 0.18), rgba(148, 163, 184, 0.12)),
			rgba(255, 255, 255, 0.04);
		color: var(--text-secondary);
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		text-align: center;
	}

	.item-main {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.item-kind-pill {
		display: inline-flex;
		align-items: center;
		width: fit-content;
		padding: 0.18rem 0.42rem;
		border-radius: 999px;
		font-size: 0.66rem;
		color: var(--text-secondary);
		background: rgba(var(--accent-rgb), 0.1);
		border: 1px solid rgba(var(--accent-rgb), 0.18);
	}

	.item-main a {
		color: var(--accent);
		text-decoration: none;
		font-size: 0.8rem;
		word-break: break-all;
	}

	.item-main a:hover {
		text-decoration: underline;
	}

	.item-caption {
		color: var(--text-secondary);
		font-size: 0.72rem;
	}

	.item-meta {
		flex-shrink: 0;
		color: var(--text-secondary);
		font-size: 0.69rem;
		text-align: right;
		display: flex;
		flex-direction: column;
		gap: 0.16rem;
	}

	.item-delete-btn {
		border: 1px solid rgba(220, 38, 38, 0.6);
		background: rgba(220, 38, 38, 0.14);
		color: #fecaca;
		border-radius: 7px;
		padding: 0.22rem 0.42rem;
		font-size: 0.68rem;
		cursor: pointer;
	}

	.item-delete-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.pagination-row {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		font-size: 0.74rem;
		color: var(--text-secondary);
	}

	.pagination-row button {
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-primary);
		border-radius: 8px;
		padding: 0.3rem 0.48rem;
		font-size: 0.74rem;
		cursor: pointer;
	}

	.pagination-row button:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.empty-state {
		padding: 0.65rem;
		border: 1px dashed var(--border);
		border-radius: 9px;
		font-size: 0.78rem;
		color: var(--text-secondary);
		text-align: center;
	}

	@media (max-width: 900px) {
		.media-albums-tab {
			padding: 0.55rem;
			gap: 0.55rem;
		}

		.album-list {
			display: grid;
			grid-auto-flow: column;
			grid-auto-columns: minmax(180px, 1fr);
			overflow-x: auto;
			padding-bottom: 0.2rem;
			scroll-snap-type: x proximity;
		}

		.album-card {
			scroll-snap-align: start;
		}

		.items-header {
			flex-direction: column;
			align-items: stretch;
		}

		.items-header .danger-btn {
			align-self: flex-start;
		}

		.items-header-actions {
			width: 100%;
			justify-content: space-between;
		}

		.album-preview-strip {
			padding-bottom: 0.25rem;
		}

		.item-toolbar {
			flex-direction: column;
			align-items: stretch;
		}

		.item-toolbar-right {
			width: 100%;
			justify-content: space-between;
		}

		.view-toggle {
			flex: 1;
		}

		.view-toggle button {
			flex: 1;
		}

		.item-list.grid-view {
			grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
		}
	}

	@media (max-width: 640px) {
		.create-row,
		.upload-local-row {
			grid-template-columns: 1fr;
		}

		.item-row {
			grid-template-columns: 1fr;
			gap: 0.35rem;
		}

		.item-preview {
			width: 100%;
			height: 10rem;
		}

		.item-meta {
			width: 100%;
			align-items: flex-start;
			text-align: left;
		}

		.item-delete-btn {
			padding: 0.35rem 0.52rem;
			font-size: 0.72rem;
		}

		.pagination-row {
			flex-wrap: wrap;
		}
	}
</style>
