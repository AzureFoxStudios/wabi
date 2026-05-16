<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { fade } from 'svelte/transition';
	import type { GalleryItem, GalleryCreator } from '$lib/galleryStore';
	import { getCreatorInitial, formatGalleryTime } from '$lib/galleryStore';

	export let visible = false;
	export let items: GalleryItem[] = [];
	export let currentIndex = 0;
	export let creators: GalleryCreator[] = [];

	export let onFilterByCreator: (creator: GalleryCreator) => void = () => {};

	$: currentItem = items[currentIndex] || null;
	$: currentCreator = currentItem?.creator
		? creators.find((c) => c.dbUserId === currentItem?.creator?.dbUserId) || null
		: null;

	function close() {
		visible = false;
	}

	function navigate(dir: number) {
		if (items.length <= 1) return;
		currentIndex = (currentIndex + dir + items.length) % items.length;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!visible) return;
		if (e.key === 'Escape') close();
		if (e.key === 'ArrowLeft') navigate(-1);
		if (e.key === 'ArrowRight') navigate(1);
	}

	onMount(() => {
		window.addEventListener('keydown', handleKeydown);
	});

	onDestroy(() => {
		window.removeEventListener('keydown', handleKeydown);
	});

	function handleFilterByCreator() {
		if (currentCreator) {
			onFilterByCreator(currentCreator);
		}
	}
</script>

{#if visible && currentItem}
	<div class="lightbox-backdrop" on:click|self={close} transition:fade>
		<button class="lightbox-close" on:click={close} aria-label="Close lightbox">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
				<line x1="18" y1="6" x2="6" y2="18"/>
				<line x1="6" y1="6" x2="18" y2="18"/>
			</svg>
		</button>

		{#if items.length > 1}
			<button class="lightbox-nav lightbox-prev" on:click={() => navigate(-1)} aria-label="Previous">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="15 18 9 12 15 6"/>
				</svg>
			</button>
			<button class="lightbox-nav lightbox-next" on:click={() => navigate(1)} aria-label="Next">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="9 18 15 12 9 6"/>
				</svg>
			</button>
		{/if}

		<div class="lightbox-media" on:click={close}>
			{#if currentItem.attachmentMime?.startsWith('video/')}
				<video
					src={currentItem.attachmentUrl}
					controls
					autoplay
					class="lightbox-video"
					on:click|stopPropagation
				/>
			{:else}
				<img
					src={currentItem.attachmentUrl}
					alt={currentItem.attachmentName}
					class="lightbox-image"
				/>
			{/if}
		</div>

		<div class="lightbox-info" on:click|stopPropagation>
			{#if currentCreator}
				<div class="lightbox-creator">
					<div class="lightbox-avatar" style="background: {currentCreator.color || 'var(--accent-primary)'};">
						{getCreatorInitial(currentCreator.username)}
					</div>
					<div class="lightbox-creator-text">
						<button class="lightbox-creator-name" on:click={handleFilterByCreator}>
							{currentCreator.username}
						</button>
						<span class="lightbox-time">{formatGalleryTime(currentItem.uploadedAt)}</span>
					</div>
				</div>
			{:else}
				<div class="lightbox-creator">
					<div class="lightbox-avatar">?</div>
					<div class="lightbox-creator-text">
						<span class="lightbox-creator-name">Unknown</span>
						<span class="lightbox-time">{formatGalleryTime(currentItem.uploadedAt)}</span>
					</div>
				</div>
			{/if}

			<div class="lightbox-meta">
				<span class="lightbox-album">{currentItem.albumName}</span>
				<span class="lightbox-counter">{currentIndex + 1} / {items.length}</span>
			</div>

			{#if currentItem.caption}
				<div class="lightbox-caption">{currentItem.caption}</div>
			{/if}

			{#if currentCreator}
				<button class="lightbox-more-by" on:click={handleFilterByCreator}>
					More by {currentCreator.username}
				</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	.lightbox-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.92);
		z-index: 10000;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-direction: column;
	}

	.lightbox-close {
		position: absolute;
		top: 12px;
		right: 12px;
		width: 36px;
		height: 36px;
		border-radius: 2px;
		border: none;
		background: rgba(255, 255, 255, 0.08);
		color: white;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: background 0.15s;
	}

	.lightbox-close:hover {
		background: rgba(255, 255, 255, 0.18);
	}

	.lightbox-close svg {
		width: 18px;
		height: 18px;
	}

	.lightbox-nav {
		position: absolute;
		top: 50%;
		transform: translateY(-50%);
		width: 40px;
		height: 40px;
		border-radius: 2px;
		border: none;
		background: rgba(255, 255, 255, 0.06);
		color: white;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: background 0.15s;
	}

	.lightbox-nav:hover {
		background: rgba(255, 255, 255, 0.15);
	}

	.lightbox-nav svg {
		width: 20px;
		height: 20px;
	}

	.lightbox-prev { left: 12px; }
	.lightbox-next { right: 12px; }

	.lightbox-media {
		max-width: 90vw;
		max-height: 70vh;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: zoom-out;
	}

	.lightbox-image {
		max-width: 90vw;
		max-height: 70vh;
		object-fit: contain;
		border-radius: 2px;
	}

	.lightbox-video {
		max-width: 90vw;
		max-height: 70vh;
		border-radius: 2px;
	}

	.lightbox-info {
		margin-top: 12px;
		padding: 10px 16px;
		background: rgba(255, 255, 255, 0.05);
		border-radius: 2px;
		max-width: 480px;
		width: 90vw;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.lightbox-creator {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.lightbox-avatar {
		width: 28px;
		height: 28px;
		border-radius: 2px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 12px;
		font-weight: 700;
		color: white;
		flex-shrink: 0;
	}

	.lightbox-creator-text {
		display: flex;
		flex-direction: column;
	}

	.lightbox-creator-name {
		font-size: 13px;
		font-weight: 700;
		color: white;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		text-align: left;
	}

	.lightbox-creator-name:hover {
		text-decoration: underline;
	}

	.lightbox-time {
		font-size: 11px;
		color: rgba(255, 255, 255, 0.45);
	}

	.lightbox-meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-size: 11px;
		color: rgba(255, 255, 255, 0.35);
	}

	.lightbox-album {
		font-weight: 600;
		color: rgba(255, 255, 255, 0.55);
	}

	.lightbox-caption {
		font-size: 12px;
		color: rgba(255, 255, 255, 0.6);
		line-height: 1.4;
		padding-top: 4px;
		border-top: 1px solid rgba(255, 255, 255, 0.06);
	}

	.lightbox-more-by {
		font-size: 11px;
		font-weight: 600;
		color: var(--accent-primary, #7c6af5);
		background: none;
		border: none;
		padding: 2px 0;
		cursor: pointer;
		text-align: left;
	}

	.lightbox-more-by:hover {
		text-decoration: underline;
	}
</style>
