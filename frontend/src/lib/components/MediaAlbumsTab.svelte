<script lang="ts">
	import { onMount } from 'svelte';
	import { channels, currentChannel } from '$lib/socket';
	import {
		addMediaAlbumItem,
		createMediaAlbum,
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

	let errorMessage = '';
	let newAlbumName = '';
	let draftAttachmentUrl = '';
	let draftAttachmentName = '';
	let draftAttachmentMime = '';
	let draftCaption = '';
	let lastScopeKey = '';

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

		{#if selectedAlbum()}
			<div class="items-section">
				<div class="items-header">
					<strong>{selectedAlbum()?.name}</strong>
					<span>{albumItems.length} loaded</span>
				</div>

				<details class="debug-add-item">
					<summary>Debug add item</summary>
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

				<div class="item-list">
					{#if isLoadingItems}
						<div class="empty-state">Loading items...</div>
					{:else if albumItems.length === 0}
						<div class="empty-state">No items in this album yet.</div>
					{:else}
						{#each albumItems as item}
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
								</div>
							</div>
						{/each}
					{/if}
				</div>
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

	.create-row input,
	.debug-form input {
		width: 100%;
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-primary);
		border-radius: 8px;
		padding: 0.46rem 0.55rem;
		font-size: 0.8rem;
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

	.items-header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		font-size: 0.78rem;
		color: var(--text-secondary);
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

	.item-row {
		border: 1px solid var(--border);
		border-radius: 9px;
		padding: 0.45rem 0.55rem;
		display: flex;
		justify-content: space-between;
		gap: 0.65rem;
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

	.empty-state {
		padding: 0.65rem;
		border: 1px dashed var(--border);
		border-radius: 9px;
		font-size: 0.78rem;
		color: var(--text-secondary);
		text-align: center;
	}
</style>
