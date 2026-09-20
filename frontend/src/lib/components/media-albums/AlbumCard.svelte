<script lang="ts">
	import { isImageAlbumItem, isVideoAlbumItem, resolveAlbumAssetUrl, formatTimestamp } from './mediaAlbumHelpers';
	import type { MediaAlbum, MediaAlbumItem } from '$lib/api';

	export let album: MediaAlbum;
	export let selectedAlbumId: number | null = null;
	export let isUploadingAlbumFile = false;
	export let lastUploadedAlbumId: number | null = null;
	export let previewItems: MediaAlbumItem[] = [];
	export let canDeleteAlbumFor: (album: MediaAlbum | null) => boolean = () => false;

	export let onActivate: (album: MediaAlbum) => void = () => {};
	export let onContextMenu: (event: MouseEvent, albumId: number) => void = () => {};
	export let onPreviewActivate: (album: MediaAlbum, previewIndex: number) => void = () => {};
	export let onQuickAdd: (albumId: number) => void = () => {};
	export let onQuickDelete: (albumId: number) => void = () => {};

	$: rowStatus = selectedAlbumId === album.id && isUploadingAlbumFile
		? 'Uploading'
		: selectedAlbumId === album.id
			? (album.itemCount > 0 ? 'Selected' : 'Ready')
			: lastUploadedAlbumId === album.id ? 'Updated' : null;

	function handleKeydown(event: KeyboardEvent, album: MediaAlbum): void {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			onActivate(album);
		}
	}

	$: placeholderText = selectedAlbumId === album.id && isUploadingAlbumFile
		? 'Uploading into this album...'
		: album.itemCount > 0 ? 'Open album gallery' : 'Click row to upload the first image';

</script>

<div
	class="album-card"
	class:featured={album.isFeatured}
	class:selected={selectedAlbumId === album.id}
	class:uploading={selectedAlbumId === album.id && isUploadingAlbumFile}
	role="button"
	tabindex="0"
	on:click={() => onActivate(album)}
	on:contextmenu={(event) => onContextMenu(event, album.id)}
	on:keydown={(event) => handleKeydown(event, album)}
>
	<div class="album-name-row">
		<div class="album-name-stack">
			<div class="album-name">{album.name}</div>
			{#if rowStatus}
				<span class="album-row-status">{rowStatus}</span>
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
				on:click|stopPropagation={() => onQuickAdd(album.id)}
			>
				+
			</button>
			{#if canDeleteAlbumFor(album)}
				<button
					type="button"
					class="album-quick-btn album-quick-btn--danger"
					title="Delete album"
					aria-label={`Delete ${album.name}`}
					on:click|stopPropagation={() => onQuickDelete(album.id)}
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
					on:click|stopPropagation={() => onPreviewActivate(album, previewIndex)}
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
				{placeholderText}
			</div>
		{/if}
	</div>
	<div class="album-meta">
		<span>{album.itemCount} items</span>
		<span>{album.updatedAt > 0 ? `Updated ${formatTimestamp(album.updatedAt)}` : 'Recently created'}</span>
	</div>
</div>
