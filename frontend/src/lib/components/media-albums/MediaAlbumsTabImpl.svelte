<script lang="ts">
	import './MediaAlbumsTabImpl.css';
	import { onDestroy, onMount, tick } from 'svelte';
	import { channels, currentChannel, currentUser, sendMessage } from '$lib/socket';
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
		GAME_SCREENSHOT_PIPE_REFRESH_EVENT,
		detectGameScreenshotDirectory,
		getGameScreenshotPipeTargetAlbumId,
		listGameScreenshotDirectoryCandidates,
		loadGameScreenshotPipeSettings,
		runGameScreenshotPipeOnce,
		saveGameScreenshotPipeSettings,
		setGameScreenshotPipeTargetAlbumId,
		type GameScreenshotDirectoryCandidate,
		type GameScreenshotPipeImportEventDetail
	} from '$lib/gameScreenshotPipe';
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
		import AlbumViewer from './AlbumViewer.svelte';
		import AlbumCard from './AlbumCard.svelte';
		import AlbumUploadForm from './AlbumUploadForm.svelte';
		import AlbumItemRow from './AlbumItemRow.svelte';
		import ScreenshotPipePanel from './ScreenshotPipePanel.svelte';
		import AlbumItemsHeader from './AlbumItemsHeader.svelte';

	$: activeChannel = $channels.find((channel) => channel.id === $currentChannel) || null;
	$: scopeType = (activeChannel?.type === 'dm' || activeChannel?.type === 'group' ? 'dm' : 'channel') as MediaAlbumScopeType;
	$: scopeId = activeChannel?.id || '';
	$: scopeKey = scopeId ? `${scopeType}:${scopeId}` : '';
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
	let screenshotPipeEnabled = false;
	let screenshotPipeFolderPath = '';
	let screenshotPipeCandidates: GameScreenshotDirectoryCandidate[] = [];
	let isLoadingScreenshotPipeCandidates = false;
	let isScanningScreenshotPipe = false;
	let screenshotPipeStatusMessage = '';
	let screenshotPipeErrorMessage = '';
	let screenshotPipeTargetAlbumId: number | null = null;
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

	function syncScreenshotPipeSettingsFromStorage(): void {
		const settings = loadGameScreenshotPipeSettings();
		screenshotPipeEnabled = settings.enabled;
		screenshotPipeFolderPath = settings.screenshotDirectoryPath;
		screenshotPipeTargetAlbumId = scopeKey ? getGameScreenshotPipeTargetAlbumId(scopeKey) : null;
	}

	function persistScreenshotPipeSettings(): void {
		saveGameScreenshotPipeSettings({
			enabled: screenshotPipeEnabled,
			screenshotDirectoryPath: screenshotPipeFolderPath
		});
	}

	async function refreshScreenshotPipeCandidates(): Promise<void> {
		isLoadingScreenshotPipeCandidates = true;
		try {
			screenshotPipeCandidates = await listGameScreenshotDirectoryCandidates();
		} catch {
			screenshotPipeCandidates = [];
		} finally {
			isLoadingScreenshotPipeCandidates = false;
		}
	}

	async function useDetectedScreenshotFolder(): Promise<void> {
		const detected = await detectGameScreenshotDirectory();
		if (!detected) {
			screenshotPipeErrorMessage = 'No common FFXIV screenshot folder was detected on this device.';
			return;
		}
		screenshotPipeFolderPath = detected;
		persistScreenshotPipeSettings();
		screenshotPipeStatusMessage = `Using ${detected} for screenshot imports.`;
		screenshotPipeErrorMessage = '';
	}

	function setScreenshotPipeTargetFromSelectedAlbum(): void {
		if (!scopeKey || !selectedAlbumId) return;
		setGameScreenshotPipeTargetAlbumId(scopeKey, selectedAlbumId);
		screenshotPipeTargetAlbumId = selectedAlbumId;
		screenshotPipeStatusMessage = `Screenshots will import into "${selectedAlbum()?.name || 'selected album'}" for this scope.`;
		screenshotPipeErrorMessage = '';
	}

	function clearScreenshotPipeTarget(): void {
		if (!scopeKey) return;
		setGameScreenshotPipeTargetAlbumId(scopeKey, null);
		screenshotPipeTargetAlbumId = null;
		screenshotPipeStatusMessage = 'Screenshot imports are no longer tied to this scope.';
		screenshotPipeErrorMessage = '';
	}

	async function scanGameScreenshotPipeNow(): Promise<void> {
		if (isScanningScreenshotPipe) return;
		isScanningScreenshotPipe = true;
		screenshotPipeErrorMessage = '';
		try {
			const result = await runGameScreenshotPipeOnce();
			if (result.imported > 0) {
				screenshotPipeStatusMessage = `Imported ${result.imported} screenshot${result.imported === 1 ? '' : 's'} into the album target.`;
			} else if (result.skipped > 0) {
				screenshotPipeStatusMessage = 'Screenshot folder already synced.';
			} else {
				screenshotPipeStatusMessage = 'No new screenshots were found.';
			}
		} catch (error) {
			screenshotPipeErrorMessage = error instanceof Error ? error.message : 'Failed to scan screenshot folder';
		} finally {
			isScanningScreenshotPipe = false;
		}
	}

	function handleGameScreenshotPipeRefresh(event: Event): void {
		const detail = (event as CustomEvent<GameScreenshotPipeImportEventDetail>).detail;
		if (!detail) return;
		if (!scopeKey || detail.scopeKey !== scopeKey) return;
		lastUploadedAlbumId = detail.albumId;
		screenshotPipeStatusMessage = `Imported "${detail.fileName}" into the target album.`;
		screenshotPipeErrorMessage = '';
		void refreshAlbums(false);
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

	$: selectedAlbumValue = selectedAlbum();
		$: contextMenuAlbumValue = albumContextMenu
			? albums.find((album) => album.id === albumContextMenu?.albumId) || null
			: null;
		$: screenshotPipeTargetAlbumName = screenshotPipeTargetAlbumId
			? albums.find((album) => album.id === screenshotPipeTargetAlbumId)?.name || ''
			: '';
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

	async function openSelectedAlbumViewerAtItem(item: MediaAlbumItem): Promise<void> {
		if (!selectedAlbumId || (!isImageAlbumItem(item) && !isVideoAlbumItem(item))) return;
		const mediaItems = getAlbumViewerItems(albumItems);
		if (mediaItems.length > 0) {
			const itemIndex = Math.max(0, mediaItems.findIndex((mediaItem) => mediaItem.id === item.id));
			albumViewerAlbumId = selectedAlbumId;
			albumViewerAlbumName = selectedAlbum()?.name || 'Album';
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
			sendMessage(scopeId, buildAlbumAnnouncement(created), 'text');
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
		syncScreenshotPipeSettingsFromStorage();
		void refreshScreenshotPipeCandidates();
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
		window.addEventListener(GAME_SCREENSHOT_PIPE_REFRESH_EVENT, handleGameScreenshotPipeRefresh as EventListener);
		window.addEventListener('pointerdown', handleWindowPointerDown);
		window.addEventListener('keydown', handleWindowKeydown);
		autoRefreshTimer = setInterval(() => {
			if (!scopeId || isLoadingAlbums) return;
			void refreshAlbums(false);
		}, 20000);

		return () => {
			window.removeEventListener(
				GAME_SCREENSHOT_PIPE_REFRESH_EVENT,
				handleGameScreenshotPipeRefresh as EventListener
			);
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
			screenshotPipeTargetAlbumId = getGameScreenshotPipeTargetAlbumId(scopeKey);
			screenshotPipeStatusMessage = '';
			screenshotPipeErrorMessage = '';
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
			screenshotPipeTargetAlbumId = null;
			screenshotPipeStatusMessage = '';
			screenshotPipeErrorMessage = '';
			closeAlbumContextMenu();
		}
	}
</script>

<div class="media-albums-tab">
	<div class="section-header">
		<h3>Media</h3>
	</div>
	<p class="scope-label">{scopeLabel} Pins and uploads stay scoped to the current channel or DM.</p>

		<ScreenshotPipePanel
			{scopeId}
			{scopeKey}
			{selectedAlbumId}
			bind:enabled={screenshotPipeEnabled}
			bind:folderPath={screenshotPipeFolderPath}
			candidates={screenshotPipeCandidates}
			isLoadingCandidates={isLoadingScreenshotPipeCandidates}
			isScanning={isScanningScreenshotPipe}
			targetAlbumId={screenshotPipeTargetAlbumId}
			targetAlbumName={screenshotPipeTargetAlbumName}
			statusMessage={screenshotPipeStatusMessage}
			errorMessage={screenshotPipeErrorMessage}
			onPersistSettings={persistScreenshotPipeSettings}
			onScanNow={() => void scanGameScreenshotPipeNow()}
			onUseDetectedFolder={() => void useDetectedScreenshotFolder()}
			onSetTargetFromSelectedAlbum={setScreenshotPipeTargetFromSelectedAlbum}
			onClearTarget={clearScreenshotPipeTarget}
		/>

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
					<AlbumCard
						{album}
						{selectedAlbumId}
						{isUploadingAlbumFile}
						{lastUploadedAlbumId}
						{screenshotPipeTargetAlbumId}
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
				aria-label="Album actions"
				tabindex="-1"
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
				<AlbumItemsHeader
					album={selectedAlbumValue}
					canFeature={canFeatureAlbum(selectedAlbumValue)}
					canDelete={canDeleteAlbum(selectedAlbumValue)}
					isDeleting={isDeletingAlbum}
					isSavingFeatured={isSavingFeaturedAlbum}
					{screenshotPipeTargetAlbumId}
					{selectedAlbumId}
					{scopeKey}
					loadedItemCount={albumItems.length}
					onFeature={(album) => void toggleFeaturedAlbum(album)}
					onDelete={() => void removeSelectedAlbum()}
					onSetPipeTarget={setScreenshotPipeTargetFromSelectedAlbum}
					onAddMedia={() => triggerAlbumUploadPicker('instant')}
				/>
				{#if albumPreviewItems.length > 0}
					<div class="album-preview-strip">
						{#each albumPreviewItems as previewItem, previewIndex}
							<button
								type="button"
								class="album-preview-chip"
								title={previewItem.attachmentName}
								aria-label={`Open ${previewItem.attachmentName}`}
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
					<div class="permission-hint">Only the album owner or moderators can delete this album.</div>
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
