<script lang="ts">
	import { _ } from '$lib/i18n';
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
		? $_('media_albums.uploading')
		: selectedAlbumId === album.id
			? (album.itemCount > 0 ? $_('media_albums.selected') : $_('media_albums.ready'))
			: lastUploadedAlbumId === album.id ? $_('wiki.updated') : null;

	function handleKeydown(event: KeyboardEvent, album: MediaAlbum): void {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			onActivate(album);
		}
	}

	$: placeholderText = selectedAlbumId === album.id && isUploadingAlbumFile
		? $_('ac.uploading_into')
		: album.itemCount > 0 ? $_('ac.open_gallery') : $_('ac.click_first');

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
				<span class="featured-badge">{$_('ac.featured')}</span>
			{/if}
			<button
				type="button"
				class="album-quick-btn"
				title={$_('album_header.add_file')}
				aria-label={$_('ac.add_file_to', { values: { name: album.name } })}
				on:click|stopPropagation={() => onQuickAdd(album.id)}
			>
				+
			</button>
			{#if canDeleteAlbumFor(album)}
				<button
					type="button"
					class="album-quick-btn album-quick-btn--danger"
					title={$_('media_albums.delete_album')}
					aria-label={$_('ac.delete_name', { values: { name: album.name } })}
					on:click|stopPropagation={() => onQuickDelete(album.id)}
			>
					{$_('admin.actions.delete')}
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
					aria-label={$_('ac.open_preview', { values: { name: album.name, index: previewIndex + 1 } })}
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
		<span>{$_('message_content.album_items_count', { values: { count: album.itemCount } })}</span>
		<span>{album.updatedAt > 0 ? $_('ac.updated_at', { values: { time: formatTimestamp(album.updatedAt) } }) : $_('ac.recent')}</span>
	</div>
</div>
