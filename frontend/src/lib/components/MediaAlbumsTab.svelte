<script lang="ts">
	import { onMount } from 'svelte';
	import { channels, currentChannel, currentUser } from '$lib/socket';
	import { getServerUrl } from '$lib/serverUrl';
	import {
		addMediaAlbumItem,
		createMediaAlbum,
		deleteMediaAlbum,
		deleteMediaAlbumItem,
		listMediaAlbumItems,
		listMediaAlbums,
		type MediaAlbum,
		type MediaAlbumItem,
		type MediaAlbumScopeType
	} from '$lib/api';

	$: activeChannel = $channels.find((channel) => channel.id === $currentChannel) || null;
	$: scopeType = (activeChannel?.type === 'dm' || activeChannel?.type === 'group' ? 'dm' : 'channel') as MediaAlbumScopeType;
	$: scopeId = activeChannel?.id || '';
	$: scopeLabel = scopeId ? `${scopeType}:${scopeId}` : 'No active channel';

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
	let newAlbumName = '';
	let draftAttachmentUrl = '';
	let draftAttachmentName = '';
	let draftAttachmentMime = '';
	let draftCaption = '';
	let draftUploadCaption = '';
	let draftUploadFile: File | null = null;
	let uploadInputElement: HTMLInputElement | null = null;
	let lastScopeKey = '';
	let isUploadingAlbumFile = false;
	let itemSearchQuery = '';
	let itemSortMode: 'newest' | 'oldest' | 'name' = 'newest';
	let itemViewMode: 'list' | 'grid' = 'grid';
	let currentItemsPage = 1;
	let lastItemsControlKey = '';
	const ITEMS_PER_PAGE = 24;

	function getAuthToken(): string | null {
		if (typeof window === 'undefined') return null;
		return localStorage.getItem('authToken');
	}

	function clearError(): void {
		errorMessage = '';
	}

	function selectedAlbum(): MediaAlbum | null {
		return albums.find((album) => album.id === selectedAlbumId) || null;
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

	function canDeleteItem(item: MediaAlbumItem, album: MediaAlbum | null): boolean {
		const dbUserId = currentUserDbId();
		if (dbUserId !== null && item.uploadedBy === dbUserId) return true;
		if (dbUserId !== null && album && album.createdBy === dbUserId) return true;
		return canModerateAlbums();
	}

	$: selectedAlbumValue = selectedAlbum();
	$: normalizedItemSearch = itemSearchQuery.trim().toLowerCase();
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
			if (itemSortMode === 'name') {
				return a.attachmentName.localeCompare(b.attachmentName);
			}
			if (itemSortMode === 'oldest') {
				return a.uploadedAt - b.uploadedAt;
			}
			return b.uploadedAt - a.uploadedAt;
		});
	$: totalItemPages = Math.max(1, Math.ceil(filteredAlbumItems.length / ITEMS_PER_PAGE));
	$: pagedAlbumItems = filteredAlbumItems.slice(
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

	function handleAlbumFileChange(event: Event): void {
		const input = event.target as HTMLInputElement;
		draftUploadFile = input.files?.[0] || null;
	}

	function resetUploadDraft(): void {
		draftUploadFile = null;
		draftUploadCaption = '';
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
			resetUploadDraft();
			await loadAlbumItems(selectedAlbumId);
			await refreshAlbums(false);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to upload album file';
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
			return;
		}

		isLoadingAlbums = true;
		clearError();
		try {
			const nextAlbums = await listMediaAlbums(token, scopeType, scopeId, 200);
			albums = nextAlbums;

			if (nextAlbums.length === 0) {
				selectedAlbumId = null;
				albumItems = [];
				return;
			}

			const selectedStillExists = selectedAlbumId && nextAlbums.some((album) => album.id === selectedAlbumId);
			if (!selectedStillExists && (selectFirst || selectedAlbumId === null)) {
				selectedAlbumId = nextAlbums[0].id;
				await loadAlbumItems(nextAlbums[0].id);
				return;
			}

			if (selectedStillExists && selectedAlbumId) {
				await loadAlbumItems(selectedAlbumId);
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
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to create album';
		} finally {
			isCreatingAlbum = false;
		}
	}

	async function loadAlbumItems(albumId: number): Promise<void> {
		const token = getAuthToken();
		if (!token || !albumId) {
			albumItems = [];
			return;
		}

		isLoadingItems = true;
		clearError();
		try {
			const response = await listMediaAlbumItems(token, albumId, 500);
			albumItems = response.items;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to load album items';
			albumItems = [];
		} finally {
			isLoadingItems = false;
		}
	}

	async function openAlbum(albumId: number): Promise<void> {
		selectedAlbumId = albumId;
		await loadAlbumItems(albumId);
	}

	async function addDebugItem(): Promise<void> {
		const token = getAuthToken();
		if (!token || !selectedAlbumId || isAddingItem) return;
		const attachmentUrl = draftAttachmentUrl.trim();
		const attachmentName = draftAttachmentName.trim();
		if (!attachmentUrl || !attachmentName) return;

		isAddingItem = true;
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
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to add album item';
		} finally {
			isAddingItem = false;
		}
	}

	async function removeSelectedAlbum(): Promise<void> {
		const token = getAuthToken();
		if (!token || !selectedAlbumId || isDeletingAlbum) return;
		const album = selectedAlbum();
		if (!canDeleteAlbum(album)) {
			errorMessage = 'Only album owner or moderators can delete this album.';
			return;
		}
		const label = album?.name || `#${selectedAlbumId}`;
		if (!confirm(`Delete album "${label}"? This removes all album items.`)) return;

		isDeletingAlbum = true;
		clearError();
		try {
			await deleteMediaAlbum(token, selectedAlbumId);
			selectedAlbumId = null;
			albumItems = [];
			await refreshAlbums(true);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to delete album';
		} finally {
			isDeletingAlbum = false;
		}
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
		clearError();
		try {
			await deleteMediaAlbumItem(token, selectedAlbumId, itemId);
			await loadAlbumItems(selectedAlbumId);
			await refreshAlbums(false);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to delete album item';
		} finally {
			deletingItemId = null;
		}
	}

	onMount(() => {
		void refreshAlbums(true);
	});

	$: {
		const scopeKey = `${scopeType}:${scopeId}`;
		if (scopeId && scopeKey !== lastScopeKey) {
			lastScopeKey = scopeKey;
			void refreshAlbums(true);
		}
		if (!scopeId) {
			lastScopeKey = '';
			albums = [];
			selectedAlbumId = null;
			albumItems = [];
		}
	}
</script>

<div class="media-albums-tab">
	<div class="section-header">
		<h3>Media Albums</h3>
		<button class="refresh-btn" on:click={() => void refreshAlbums(false)} disabled={isLoadingAlbums}>
			{isLoadingAlbums ? 'Loading...' : 'Refresh'}
		</button>
	</div>
	<p class="scope-label">{scopeLabel}</p>

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

		<div class="album-list">
			{#if isLoadingAlbums}
				<div class="empty-state">Loading albums...</div>
			{:else if albums.length === 0}
				<div class="empty-state">No albums in this scope yet.</div>
			{:else}
				{#each albums as album}
					<button
						class="album-card"
						class:selected={selectedAlbumId === album.id}
						on:click={() => void openAlbum(album.id)}
					>
						<div class="album-name">{album.name}</div>
						<div class="album-meta">
							<span>{album.itemCount} items</span>
							<span>Updated {formatTimestamp(album.updatedAt)}</span>
						</div>
					</button>
				{/each}
			{/if}
		</div>

		{#if selectedAlbumValue}
			<div class="items-section">
				<div class="items-header">
					<div class="items-header-title">
						<strong>{selectedAlbumValue.name}</strong>
						<span>{albumItems.length} loaded</span>
					</div>
					<button
						class="danger-btn"
						on:click={() => void removeSelectedAlbum()}
						disabled={isDeletingAlbum || !canDeleteAlbum(selectedAlbumValue)}
						title="Delete this album"
					>
						{isDeletingAlbum ? 'Deleting...' : 'Delete album'}
					</button>
				</div>
				{#if !canDeleteAlbum(selectedAlbumValue)}
					<div class="permission-hint">Only the album owner or moderators can delete this album.</div>
				{/if}

				<div class="upload-local-item">
					<div class="upload-local-row">
						<input
							type="file"
							bind:this={uploadInputElement}
							on:change={handleAlbumFileChange}
							accept="image/*,video/*,audio/*,.zip,.pdf,.txt,.md"
						/>
						<button
							on:click={() => void addUploadedFileItem()}
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
							<div class="item-row">
								<div class="item-main">
									<a href={item.attachmentUrl} target="_blank" rel="noreferrer">
										{item.attachmentName}
									</a>
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
				{#if !isLoadingItems && filteredAlbumItems.length > ITEMS_PER_PAGE}
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

	.refresh-btn,
	.create-row button,
	.debug-form button {
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-primary);
		border-radius: 8px;
		padding: 0.42rem 0.58rem;
		font-size: 0.78rem;
		cursor: pointer;
	}

	.refresh-btn:hover,
	.create-row button:hover,
	.debug-form button:hover {
		border-color: rgba(var(--accent-rgb), 0.5);
	}

	.refresh-btn:disabled,
	.create-row button:disabled,
	.debug-form button:disabled {
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
		padding: 0.55rem;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: rgba(255, 255, 255, 0.02);
	}

	.upload-local-row {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.45rem;
		align-items: center;
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

	.album-list,
	.item-list {
		display: flex;
		flex-direction: column;
		gap: 0.42rem;
	}

	.album-card {
		width: 100%;
		border: 1px solid var(--border);
		background: rgba(255, 255, 255, 0.02);
		color: var(--text-primary);
		border-radius: 10px;
		padding: 0.5rem 0.6rem;
		text-align: left;
		cursor: pointer;
	}

	.album-card.selected {
		border-color: rgba(var(--accent-rgb), 0.65);
		background: rgba(var(--accent-rgb), 0.12);
	}

	.album-name {
		font-size: 0.84rem;
		font-weight: 600;
	}

	.album-meta {
		margin-top: 0.22rem;
		display: flex;
		justify-content: space-between;
		font-size: 0.72rem;
		color: var(--text-secondary);
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
		display: flex;
		justify-content: space-between;
		gap: 0.65rem;
	}

	.item-list.grid-view {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 0.45rem;
	}

	.item-list.grid-view .item-row {
		flex-direction: column;
		align-items: flex-start;
	}

	.item-list.grid-view .item-meta {
		width: 100%;
		align-items: flex-start;
		text-align: left;
	}

	.item-main {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
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
</style>
