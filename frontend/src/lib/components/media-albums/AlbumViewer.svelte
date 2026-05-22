<script lang="ts">
	import type { MediaAlbumItem } from '$lib/api';
	import { isVideoAlbumItem, resolveAlbumAssetUrl } from './mediaAlbumHelpers';

	export let albumName = '';
	export let albumId: number | null = null;
	export let items: MediaAlbumItem[] = [];
	export let index = 0;
	export let currentItem: MediaAlbumItem | null = null;
	export let onClose: () => void = () => {};
	export let onAddMedia: (albumId: number) => void = () => {};

	function navigate(direction: 'prev' | 'next'): void {
		if (items.length <= 1) return;
		index = direction === 'prev'
			? (index - 1 + items.length) % items.length
			: (index + 1) % items.length;
	}
</script>

{#if currentItem}
	<div
		class="album-viewer-backdrop"
		role="button"
		tabindex="0"
		on:click={onClose}
		on:keydown={(event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				onClose();
			}
		}}
	>
		<div
			class="album-viewer-modal"
			role="dialog"
			aria-modal="true"
			aria-label={albumName}
			tabindex="-1"
			on:click|stopPropagation
			on:keydown|stopPropagation
		>
			<div class="album-viewer-header">
				<div class="album-viewer-copy">
					<strong>{albumName}</strong>
					<span>{index + 1} / {items.length} &middot; {currentItem.attachmentName}</span>
				</div>
				<div class="album-viewer-actions">
					<a
						class="album-viewer-action"
						href={resolveAlbumAssetUrl(currentItem.attachmentUrl)}
						target="_blank"
						rel="noopener noreferrer"
					>
						Open original
					</a>
					<button
						type="button"
						class="album-viewer-action"
						on:click={() => albumId && onAddMedia(albumId)}
					>
						Add media
					</button>
					<button type="button" class="album-viewer-close" on:click={onClose} aria-label="Close album viewer">
						X
					</button>
				</div>
			</div>
			<div class="album-viewer-stage">
				{#if isVideoAlbumItem(currentItem)}
					<video controls autoplay playsinline>
						<source
							src={resolveAlbumAssetUrl(currentItem.attachmentUrl)}
							type={currentItem.attachmentMime || undefined}
						/>
					</video>
				{:else}
					<img
						src={resolveAlbumAssetUrl(currentItem.attachmentUrl)}
						alt={currentItem.attachmentName}
					/>
				{/if}
				{#if items.length > 1}
					<button type="button" class="album-viewer-nav album-viewer-nav-prev" on:click={() => navigate('prev')} aria-label="Previous album item">
						&lt;
					</button>
					<button type="button" class="album-viewer-nav album-viewer-nav-next" on:click={() => navigate('next')} aria-label="Next album item">
						&gt;
					</button>
				{/if}
			</div>
			{#if currentItem.caption}
				<div class="album-viewer-caption">{currentItem.caption}</div>
			{/if}
			<div class="album-viewer-strip">
				{#each items as item, itemIndex}
					<button
						type="button"
						class="album-viewer-thumb"
						class:active={itemIndex === index}
						on:click={() => (index = itemIndex)}
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
