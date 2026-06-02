<script lang="ts">
	import {
		albumItemKindLabel,
		formatTimestamp,
		isImageAlbumItem,
		isVideoAlbumItem,
		resolveAlbumAssetUrl
	} from './mediaAlbumHelpers';
	import { formatBytes as fmtBytes } from './mediaAlbumHelpers';
	import type { MediaAlbum, MediaAlbumItem } from '$lib/api';

	export let item: MediaAlbumItem;
	export let album: MediaAlbum | null = null;
	export let dragging: boolean = false;
	export let canDrag: boolean = false;
	export let deletingItemId: number | null = null;
	export let canDeleteItem: (item: MediaAlbumItem, album: MediaAlbum | null) => boolean = () => false;

	export let onOpen: (item: MediaAlbumItem) => void = () => {};
	export let onDelete: (itemId: number) => void = () => {};
	export let onDragStart: () => void = () => {};
	export let onDragEnd: () => void = () => {};
	export let onDrop: () => void = () => {};
</script>

<div
	class="item-row"
	class:dragging
	role="listitem"
	draggable={canDrag}
	on:dragstart={onDragStart}
	on:dragend={onDragEnd}
	on:dragover|preventDefault
	on:drop|preventDefault={onDrop}
>
	{#if isImageAlbumItem(item) || isVideoAlbumItem(item)}
		<button
			type="button"
			class="item-preview"
			title={item.attachmentName}
			aria-label={`Open ${item.attachmentName}`}
			on:click={() => onOpen(item)}
		>
			{#if isImageAlbumItem(item)}
				<img
					src={resolveAlbumAssetUrl(item.attachmentUrl)}
					alt={item.attachmentName}
					loading="lazy"
					decoding="async"
				/>
			{:else}
				<video muted playsinline preload="metadata">
					<source
						src={resolveAlbumAssetUrl(item.attachmentUrl)}
						type={item.attachmentMime || undefined}
					/>
				</video>
			{/if}
		</button>
	{:else}
		<a
			class="item-preview"
			href={resolveAlbumAssetUrl(item.attachmentUrl)}
			target="_blank"
			rel="noreferrer"
			title={item.attachmentName}
		>
			<div class="item-preview-fallback">{albumItemKindLabel(item)}</div>
		</a>
	{/if}
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
			on:click={() => onDelete(item.id)}
			disabled={deletingItemId !== null || !canDeleteItem(item, album)}
			title="Delete item from album"
		>
			{deletingItemId === item.id ? 'Deleting...' : 'Delete'}
		</button>
	</div>
</div>
