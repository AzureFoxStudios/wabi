<script lang="ts">
	import { _ } from '$lib/i18n';
	import './MediaAlbumsTabImpl.css';
	import SurfaceHeader from '../SurfaceHeader.svelte';
	import { onDestroy, onMount, tick } from 'svelte';
	import { channels, currentChannel, currentUser, sendMessage } from '$lib/socket';

	export let variant: 'compact' | 'full' = 'compact';
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
		type MediaAlbumItem,
		type MediaAlbumScopeType
	} from '$lib/api';
	import {
		albumItemKindLabel,
		formatAlbumActionError,
		formatTimestamp,
		isImageAlbumItem,
		isVideoAlbumItem,
		readScopeViewPreferences,
		resolveAlbumAssetUrl,
		sanitizeAlbumSortMode,
		sanitizeAlbumViewMode,
		sortAlbumsForDisplay,
		writeScopeViewPreferences,
		type AlbumItemSortMode,
		type AlbumItemViewMode
		} from './mediaAlbumHelpers';
		import { uploadAlbumFile } from './mediaAlbumUpload';
		import { markAlbumCreated, markAlbumDeleted } from '$lib/albumLifecycle';
		import AlbumViewer from './AlbumViewer.svelte';
		import AlbumCard from './AlbumCard.svelte';
		import AlbumUploadForm from './AlbumUploadForm.svelte';
		import AlbumItemRow from './AlbumItemRow.svelte';
		import AlbumItemsHeader from './AlbumItemsHeader.svelte';
		import { e2eeStatusRevision, ensureE2eeStatus, refreshE2eeStatus, roomAlbumsAgreed, roomContentKeepReason } from '$lib/dm/dmE2eeState';
		import { albumsCanOpenByAgreement, albumsUnavailable } from '$lib/privacy/contentEgress';
		import AlbumsAgreement from './AlbumsAgreement.svelte';
		import { socket as liveSocket } from '$lib/socket';

	$: activeChannel = $channels.find((channel) => channel.id === $currentChannel) || null;
	$: scopeType = (activeChannel?.type === 'dm' || activeChannel?.type === 'group' ? 'dm' : 'channel') as MediaAlbumScopeType;
	$: scopeId = activeChannel?.id || '';
	$: scopeKey = scopeId ? `${scopeType}:${scopeId}` : '';
	// Albums are server-readable (file names, captions, the files themselves). A DM or group with
	// experimental encryption enabled or pending, or whose status is still unknown, gets an
	// explanation instead of the create/upload controls (privacy/contentEgress.ts).
	$: albumsKeepReason = scopeId ? roomContentKeepReason(scopeId, activeChannel?.type ?? null, $e2eeStatusRevision) : null;
	// The exception: every member of the conversation agreed to server-readable albums. Then the
	// panel works as usual, and a member can withdraw from it.
	$: albumsAgreedHere = albumsKeepReason !== null && roomAlbumsAgreed(scopeId, $e2eeStatusRevision);
	$: albumsOffHere = albumsKeepReason !== null && !albumsAgreedHere;
	$: albumsOff = albumsKeepReason && !albumsAgreedHere ? albumsUnavailable(albumsKeepReason) : null;
	$: albumsAskAgreement = albumsOffHere && albumsKeepReason !== null && albumsCanOpenByAgreement(albumsKeepReason);
	$: if (scopeType === 'dm' && scopeId) ensureE2eeStatus(scopeId);
	// The agreement changes on other members' devices: ask again whenever this panel opens on a
	// conversation, and when the server says the room changed.
	let agreementAskedFor = '';
	$: if (scopeType === 'dm' && scopeId && agreementAskedFor !== scopeId) {
		agreementAskedFor = scopeId;
		void refreshE2eeStatus(scopeId).catch(() => {});
	}
	function onRoomUpdated(payload: { channelId?: string } | null | undefined) {
		if (scopeType === 'dm' && scopeId && payload?.channelId === scopeId) void refreshE2eeStatus(scopeId).catch(() => {});
	}
	$: albumsSocket = $liveSocket;
	let boundAlbumsSocket: { on: Function; off: Function } | null = null;
	$: if (albumsSocket !== boundAlbumsSocket) {
		boundAlbumsSocket?.off('e2ee-room-updated', onRoomUpdated);
		boundAlbumsSocket = albumsSocket;
		boundAlbumsSocket?.on('e2ee-room-updated', onRoomUpdated);
	}
	let albumsWereOff = false;
	$: if (albumsWereOff !== albumsOffHere) {
		albumsWereOff = albumsOffHere;
		// The status arrived and the room is server-readable: load what the gate held back.
		if (!albumsOffHere && scopeId) void refreshAlbums(true);
	}
	$: scopeLabel = (() => {
		if (!scopeId) return $_('media_albums.select_channel');
		if (scopeType === 'dm') {
			return activeChannel?.name ? $_('media_albums.conversation_albums_named', { values: { name: activeChannel.name } }) : $_('media_albums.conversation_albums');
		}
		return activeChannel?.name ? $_('media_albums.channel_albums_named', { values: { name: activeChannel.name } }) : $_('media_albums.channel_albums');
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

	function getAuthToken(): string | null {
		return getSessionAuthToken();
	}

	function applyScopeViewPreferences(scopeKey: string): void {
		if (!scopeKey) return;
		const saved = readScopeViewPreferences(scopeKey);
		if (!saved) return;
		itemSortMode = sanitizeAlbumSortMode(saved.sortMode);
		itemViewMode = sanitizeAlbumViewMode(saved.viewMode);
	}

	function persistScopeViewPreferences(scopeKey: string): void {
		if (!scopeKey) return;
		writeScopeViewPreferences(scopeKey, {
			sortMode: sanitizeAlbumSortMode(itemSortMode),
			viewMode: sanitizeAlbumViewMode(itemViewMode)
		});
	}

	function clearError(): void {
		errorMessage = '';
	}

	function clearSuccess(): void {
		successMessage = '';
	}

	function selectedAlbum(): MediaAlbum | null {
		return albums.find((album) => album.id === selectedAlbumId) || null;
	}

	function albumRowStatus(album: MediaAlbum): string | null {
		if (selectedAlbumId === album.id && isUploadingAlbumFile) return $_('media_albums.uploading');
		if (lastUploadedAlbumId === album.id) return $_('wiki.updated');
		if (selectedAlbumId === album.id) return album.itemCount > 0 ? $_('media_albums.selected') : $_('media_albums.ready');
		return null;
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

	$: selectedAlbumValue = albums.find((album) => album.id === selectedAlbumId) || null;
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
		albumViewerAlbumName = album?.name || $_('media_albums.album_label');
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

	async function openSelectedAlbumViewerAtItem(item: MediaAlbumItem): Promise<void> {
		if (!selectedAlbumId || (!isImageAlbumItem(item) && !isVideoAlbumItem(item))) return;
		const mediaItems = getAlbumViewerItems(albumItems);
		if (mediaItems.length > 0) {
			const itemIndex = Math.max(0, mediaItems.findIndex((mediaItem) => mediaItem.id === item.id));
			albumViewerAlbumId = selectedAlbumId;
			albumViewerAlbumName = selectedAlbum()?.name || $_('media_albums.album_label');
			albumViewerItems = mediaItems;
			albumViewerIndex = itemIndex;
			albumViewerOpen = true;
			return;
		}
		await openAlbumViewer(selectedAlbumId);
	}

	function resetUploadDraft(): void {
		draftUploadFile = null;
		draftUploadCaption = '';
		uploadPickerMode = 'draft';
		if (uploadInputElement) {
			uploadInputElement.value = '';
		}
	}

	async function addUploadedFileItem(): Promise<void> {
		const token = getAuthToken();
		if (!token || !selectedAlbumId || isUploadingAlbumFile || !draftUploadFile || albumsOffHere) return;

		clearSuccess();
		isUploadingAlbumFile = true;
		clearError();
		try {
			const uploaded = await uploadAlbumFile(token, draftUploadFile);
			await addMediaAlbumItem(token, selectedAlbumId, {
				attachmentUrl: uploaded.fileUrl,
				attachmentName: uploaded.fileName,
				attachmentSize: uploaded.fileSize,
				attachmentMime: uploaded.mimeType,
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
			successMessage = $_('media_albums.added_to_album', { values: { file: uploaded.fileName, album: selectedAlbum()?.name || $_('media_albums.album_fallback') } });
		} catch (error) {
			clearSuccess();
			errorMessage = formatAlbumActionError(error, $_('media_albums.err_upload_file'), { mode: 'upload' });
		} finally {
			isUploadingAlbumFile = false;
		}
	}

	async function refreshAlbums(selectFirst = false): Promise<void> {
		const token = getAuthToken();
		if (!token || !scopeId || albumsOffHere) {
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
			errorMessage = error instanceof Error ? error.message : $_('media_albums.err_load_albums');
		} finally {
			isLoadingAlbums = false;
		}
	}

	async function createAlbumFromInput(): Promise<void> {
		const token = getAuthToken();
		const name = newAlbumName.trim();
		if (!token || !scopeId || !name || isCreatingAlbum || albumsOffHere) return;

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
			markAlbumCreated(created.name);
			await refreshAlbums(false);
			selectedAlbumId = created.id;
			await loadAlbumItems(created.id);
			successMessage = $_('media_albums.created_album', { values: { name: created.name } });
			sendMessage(scopeId, buildAlbumAnnouncement(created), 'text');
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : $_('media_albums.err_create_album');
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
			errorMessage = error instanceof Error ? error.message : $_('media_albums.err_load_items');
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
			errorMessage = $_('media_albums.err_feature_permission');
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
			errorMessage = error instanceof Error ? error.message : $_('media_albums.err_feature');
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
			errorMessage = error instanceof Error ? error.message : $_('media_albums.err_save_order');
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
			errorMessage = $_('media_albums.err_reorder_permission');
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
			successMessage = $_('media_albums.added_to_album', { values: { file: attachmentName, album: selectedAlbum()?.name || $_('media_albums.album_fallback') } });
		} catch (error) {
			errorMessage = formatAlbumActionError(error, $_('media_albums.err_add_item'), { mode: 'url' });
		} finally {
			isAddingItem = false;
		}
	}

	async function removeAlbum(albumId: number): Promise<void> {
		const token = getAuthToken();
		if (!token || !albumId || isDeletingAlbum) return;
		const album = albums.find((entry) => entry.id === albumId) || null;
		if (!canDeleteAlbum(album)) {
			errorMessage = $_('media_albums.err_delete_permission');
			return;
		}
		const label = album?.name || `#${albumId}`;
		if (!confirm($_('media_albums.confirm_delete_album', { values: { name: label } }))) return;

		isDeletingAlbum = true;
		clearSuccess();
		clearError();
		try {
			await deleteMediaAlbum(token, albumId);
			// Broadcast-lite: tell chat announcement cards (same session) that
			// this album is gone. They match by name (see albumLifecycle.ts).
			markAlbumDeleted(albumId, album?.name ?? label);
			if (selectedAlbumId === albumId) {
				selectedAlbumId = null;
				albumItems = [];
			}
			if (albumViewerAlbumId === albumId) {
				closeAlbumViewer();
			}
			const { [albumId]: _removed, ...remainingPreviewMap } = albumPreviewMap;
			albumPreviewMap = remainingPreviewMap;
			closeAlbumContextMenu();
			await refreshAlbums(true);
			if (lastUploadedAlbumId === albumId) {
				lastUploadedAlbumId = null;
			}
			successMessage = $_('media_albums.deleted_album', { values: { name: label } });
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : $_('media_albums.err_delete_album');
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
			errorMessage = $_('media_albums.err_item_not_found');
			return;
		}
		if (!canDeleteItem(item, selectedAlbum())) {
			errorMessage = $_('media_albums.err_delete_item_permission');
			return;
		}
		const label = item?.attachmentName || $_('media_albums.item_fallback', { values: { id: itemId } });
		if (!confirm($_('media_albums.confirm_delete_item', { values: { name: label } }))) return;

		deletingItemId = itemId;
		clearSuccess();
		clearError();
		try {
			await deleteMediaAlbumItem(token, selectedAlbumId, itemId);
			await loadAlbumItems(selectedAlbumId);
			await refreshAlbums(false);
			successMessage = $_('media_albums.removed_from_album', { values: { file: label, album: selectedAlbum()?.name || $_('media_albums.album_fallback') } });
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : $_('media_albums.err_delete_item');
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
			// Reading albumsOffHere here also orders this block after the gate is computed.
			if (!albumsOffHere) void refreshAlbums(true);
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

<div class="media-albums-tab" class:media-albums-full={variant === 'full'}>
	{#if variant === 'full'}
		<SurfaceHeader title={$_('places.media')} description={scopeLabel} />
	{:else}
	<div class="section-header">
		<h3>{$_('places.media')}</h3>
	</div>
	<p class="scope-label">{scopeLabel} {$_('media_albums.scope_hint')}</p>
	{/if}

	{#if !getAuthToken()}
		<div class="empty-state">
			{$_('media_albums.sign_in')}
		</div>
	{:else if albumsAskAgreement}
		<AlbumsAgreement channelId={scopeId} variant="panel" />
	{:else if albumsOff}
		<div class="album-list is-empty">
			<div class="empty-state" role={albumsKeepReason === 'checking' ? 'status' : undefined}>
				{#if variant === 'full'}
					<h3>{albumsOff.title}</h3>
					<p>{albumsOff.text}</p>
				{:else}
					<strong>{albumsOff.title}.</strong> {albumsOff.text}
				{/if}
			</div>
		</div>
	{:else}
		{#if albumsAgreedHere}
			<AlbumsAgreement channelId={scopeId} variant="open" />
		{/if}
		<div class="create-row">
			<input
				type="text"
				bind:value={newAlbumName}
				placeholder={$_('media_albums.new_album_name')}
				aria-label={$_('media_albums.new_album_name')}
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
				{isCreatingAlbum ? $_('media_albums.creating') : $_('media_albums.create')}
			</button>
		</div>

		{#if errorMessage}
			<div class="error-banner" role="alert">{errorMessage}</div>
		{/if}
		{#if successMessage}
			<div class="success-banner" role="status">{successMessage}</div>
		{/if}

		<div class="album-list" class:is-empty={albums.length === 0}>
		{#if isLoadingAlbums}
				<div class="empty-state" role="status">{$_('media_albums.loading_albums')}</div>
			{:else if albums.length === 0}
				<div class="empty-state">
					{#if variant === 'full'}
						<svg class="media-empty-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
						<h3>{scopeType === 'dm' ? $_('media_albums.no_albums_dm') : $_('media_albums.no_albums_channel')}</h3>
						<p>{$_('media_albums.create_hint')}</p>
					{:else}
						{scopeType === 'dm' ? $_('media_albums.no_albums_dm_full') : $_('media_albums.no_albums_channel_full')}
					{/if}
				</div>
			{:else}
				{#each albums as album}
					{@const previewItems = getAlbumPreviewItems(album.id)}
					<AlbumCard
						{album}
						{selectedAlbumId}
						{isUploadingAlbumFile}
						{lastUploadedAlbumId}
						{previewItems}
						canDeleteAlbumFor={canDeleteAlbum}
						onActivate={(album) => void handleAlbumCardActivate(album)}
						onContextMenu={(event, albumId) => openAlbumContextMenu(event, albumId)}
						onPreviewActivate={(album, previewIndex) => void handleAlbumPreviewActivate(album, previewIndex)}
						onQuickAdd={(albumId) => void openAlbumUpload(albumId)}
						onQuickDelete={(albumId) => void removeAlbum(albumId)}
					/>
				{/each}
			{/if}
		</div>

		{#if albumContextMenu && contextMenuAlbumValue}
			<div
				class="album-context-menu"
				role="menu"
				aria-label={$_('media_albums.album_actions')}
				tabindex="-1"
				style={`left: ${albumContextMenu.x}px; top: ${albumContextMenu.y}px;`}
				on:pointerdown|stopPropagation
			>
				<button type="button" on:click={() => { closeAlbumContextMenu(); void openAlbum(contextMenuAlbumValue.id); }}>
					{$_('media_albums.open_album')}
				</button>
				<button type="button" on:click={() => { closeAlbumContextMenu(); void openAlbumUpload(contextMenuAlbumValue.id); }}>
					{$_('media_albums.add_file')}
				</button>
				{#if canFeatureAlbum(contextMenuAlbumValue)}
					<button type="button" on:click={() => { closeAlbumContextMenu(); void toggleFeaturedAlbum(contextMenuAlbumValue); }}>
						{contextMenuAlbumValue.isFeatured ? $_('media_albums.unfeature_album') : $_('media_albums.feature_album')}
					</button>
				{/if}
				{#if canDeleteAlbum(contextMenuAlbumValue)}
					<button
						type="button"
						class="danger"
						on:click={() => { closeAlbumContextMenu(); void removeAlbum(contextMenuAlbumValue.id); }}
					>
						{$_('media_albums.delete_album')}
					</button>
				{/if}
			</div>
		{/if}

		{#if selectedAlbumValue}
			<div class="items-section">
				<AlbumItemsHeader
					album={selectedAlbumValue}
					canFeature={canFeatureAlbum(selectedAlbumValue)}
					canDelete={canDeleteAlbum(selectedAlbumValue)}
					isDeleting={isDeletingAlbum}
					isSavingFeatured={isSavingFeaturedAlbum}
					loadedItemCount={albumItems.length}
					onFeature={(album) => void toggleFeaturedAlbum(album)}
					onDelete={() => void removeSelectedAlbum()}
					onAddMedia={() => triggerAlbumUploadPicker('instant')}
				/>
				{#if albumPreviewItems.length > 0}
					<div class="album-preview-strip">
						{#each albumPreviewItems as previewItem, previewIndex}
							<button
								type="button"
								class="album-preview-chip"
								title={previewItem.attachmentName}
								aria-label={$_('shell.open_group', { values: { name: previewItem.attachmentName } })}
								on:click={() => void openSelectedAlbumViewerAtItem(previewItem)}
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
							</button>
						{/each}
					</div>
				{/if}
				{#if !canDeleteAlbum(selectedAlbumValue)}
					<div class="permission-hint">{$_('media_albums.permission_hint')}</div>
				{/if}

				<AlbumUploadForm
					{draftUploadFile}
					bind:draftUploadCaption
					{isUploadingAlbumFile}
					bind:uploadInputElement
					onTriggerPicker={triggerAlbumUploadPicker}
					onUpload={() => void addUploadedFileItem()}
					onFileChange={(event) => void handleAlbumFileChange(event)}
				/>

				<!-- A developer instrument (§9.4): adding an item by URL and MIME type is for dev builds only. -->
				{#if import.meta.env.DEV}
				<details class="debug-add-item">
					<summary>{$_('media_albums.advanced')}</summary>
					<div class="debug-form">
						<input type="text" bind:value={draftAttachmentUrl} placeholder={$_('media_albums.attachment_url')} />
						<input type="text" bind:value={draftAttachmentName} placeholder={$_('media_albums.attachment_name')} />
						<input type="text" bind:value={draftAttachmentMime} placeholder={$_('media_albums.mime_optional')} />
						<input type="text" bind:value={draftCaption} placeholder={$_('media_albums.caption_optional')} />
						<button
							on:click={() => void addDebugItem()}
							disabled={isAddingItem || !draftAttachmentUrl.trim() || !draftAttachmentName.trim()}
						>
							{isAddingItem ? $_('media_albums.adding') : $_('media_albums.add')}
						</button>
					</div>
				</details>
				{/if}

				<div class="item-toolbar">
					<div class="item-toolbar-left">
						<input
							type="search"
							bind:value={itemSearchQuery}
							placeholder={$_('media_albums.search_items')}
						/>
					</div>
					<div class="item-toolbar-right">
						<select bind:value={itemSortMode}>
							<option value="manual">{$_('media_albums.sort_manual')}</option>
							<option value="newest">{$_('media_albums.sort_newest')}</option>
							<option value="oldest">{$_('media_albums.sort_oldest')}</option>
							<option value="name">{$_('messages.zip_preview.sort.name_asc')}</option>
						</select>
						<div class="view-toggle">
							<button class:active={itemViewMode === 'grid'} on:click={() => (itemViewMode = 'grid')}>{$_('wb.pattern_grid')}</button>
							<button class:active={itemViewMode === 'list'} on:click={() => (itemViewMode = 'list')}>{$_('media_albums.list')}</button>
						</div>
					</div>
				</div>

				<div class="item-toolbar-summary">
					{$_('media_albums.showing', { values: { shown: pagedAlbumItems.length, total: filteredAlbumItems.length } })}
					{#if isManualSortMode}
						{#if normalizedItemSearch}
							&middot; {$_('media_albums.clear_search_reorder')}
						{:else if canDragReorderItems}
							&middot; {$_('media_albums.drag_to_reorder')}
						{/if}
					{/if}
					{#if isSavingItemOrder}
						&middot; {$_('media_albums.saving_order')}
					{/if}
				</div>

				<div class="item-list" class:grid-view={itemViewMode === 'grid'}>
					{#if isLoadingItems}
						<div class="empty-state">{$_('media_albums.loading_items')}</div>
					{:else if albumItems.length === 0}
						<div class="empty-state">{$_('media_albums.no_items')}</div>
					{:else if filteredAlbumItems.length === 0}
						<div class="empty-state">{$_('media_albums.no_items_match')}</div>
					{:else}
							{#each pagedAlbumItems as item}
								<AlbumItemRow
									{item}
									album={selectedAlbumValue}
									dragging={draggingItemId === item.id}
									canDrag={canDragReorderItems}
									{deletingItemId}
									canDeleteItem={canDeleteItem}
									on:open={() => void openSelectedAlbumViewerAtItem(item)}
									on:delete={() => void removeItem(item.id)}
									on:dragstart={() => (draggingItemId = item.id)}
									on:dragend={() => (draggingItemId = null)}
									on:drop={() => void handleItemDrop(item.id)}
								/>
							{/each}
					{/if}
				</div>
				{#if !isLoadingItems && !isManualSortMode && filteredAlbumItems.length > ITEMS_PER_PAGE}
					<div class="pagination-row">
						<button on:click={() => currentItemsPage = Math.max(1, currentItemsPage - 1)} disabled={currentItemsPage <= 1}>
							{$_('messages.viewer.previous')}
						</button>
						<span>{$_('media_albums.page_of', { values: { current: currentItemsPage, total: totalItemPages } })}</span>
						<button on:click={() => currentItemsPage = Math.min(totalItemPages, currentItemsPage + 1)} disabled={currentItemsPage >= totalItemPages}>
							{$_('messages.viewer.next')}
						</button>
					</div>
				{/if}
			</div>
		{/if}
	{/if}

		{#if albumViewerOpen}
			<AlbumViewer
				albumName={albumViewerAlbumName}
				albumId={albumViewerAlbumId}
				items={albumViewerItems}
				bind:index={albumViewerIndex}
				currentItem={albumViewerCurrentItem}
				onClose={closeAlbumViewer}
				onAddMedia={(albumId) => void openAlbumUpload(albumId)}
			/>
		{/if}
	</div>
