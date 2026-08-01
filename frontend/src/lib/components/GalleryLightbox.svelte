<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { fade } from 'svelte/transition';
	import type { GalleryItem, GalleryCreator } from '$lib/galleryStore';
	import { getCreatorInitial, formatGalleryTime } from '$lib/galleryStore';
	import ObjectShareMenu from './ObjectShareMenu.svelte';
	import { slugify } from '$lib/objectRefRegistry';
	import {
		feedbackByWorkStore,
		feedbackLoadingStore,
		loadFeedback,
		addFeedback,
		findFeedbackAuthor,
	} from '$lib/galleryFeedbackStore';

	export let visible = false;
	export let items: GalleryItem[] = [];
	export let currentIndex = 0;
	export let creators: GalleryCreator[] = [];
	export let onFilterByCreator: (creator: GalleryCreator) => void = () => {};
	export let channelId: string | null = null;
	export let workId: string | null = null;

	$: currentItem = items[currentIndex] || null;
	$: shareRecord = currentItem ? {
		kind: 'gallery_work' as const,
		id: currentItem.id,
		slug: slugify(currentItem.attachmentName),
		title: currentItem.attachmentName,
		channelId: channelId || '',
		subtitle: currentItem.creator?.username,
		thumbUrl: currentItem.attachmentUrl,
		updatedAt: currentItem.uploadedAt,
	} : null;
	$: currentCreator = currentItem?.creator
		? creators.find((c) => c.dbUserId === currentItem?.creator?.dbUserId) || null
		: null;

	$: feedbackMode = !!(channelId && workId);

	let feedbackList: import('$lib/galleryFeedbackStore').GalleryFeedback[] = [];
	let feedbackLoading = false;
	let activeMarkerId: string | null = null;
	let pendingMarker: { x: number; y: number } | null = null;
	let composerText = '';
	let composerEl: HTMLTextAreaElement | null = null;
	let feedbackError: string | null = null;
	let feedbackEl: HTMLDivElement | null = null;

	$: feedbackList = $feedbackByWorkStore.get(workId || '') || [];
	$: feedbackLoading = $feedbackLoadingStore;

	$: if (visible && feedbackMode && channelId && workId) {
		loadFeedback(channelId, workId);
	}

	function close() {
		visible = false;
		pendingMarker = null;
		activeMarkerId = null;
		composerText = '';
	}

	function navigate(dir: number) {
		if (items.length <= 1) return;
		currentIndex = (currentIndex + dir + items.length) % items.length;
		pendingMarker = null;
		activeMarkerId = null;
		composerText = '';
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

	function handleMediaClick(e: MouseEvent) {
		if (!feedbackMode) {
			close();
			return;
		}
		const target = e.currentTarget as HTMLElement;
		if (!target) return;
		const rect = target.getBoundingClientRect();
		const x = ((e.clientX - rect.left) / rect.width) * 100;
		const y = ((e.clientY - rect.top) / rect.height) * 100;
		pendingMarker = { x, y };
		activeMarkerId = null;
		composerText = '';
		if (composerEl) composerEl.focus();
	}

	function handleMarkerClick(fb: import('$lib/galleryFeedbackStore').GalleryFeedback) {
		activeMarkerId = activeMarkerId === fb.feedbackId ? null : fb.feedbackId;
		pendingMarker = null;
		if (activeMarkerId && feedbackEl) {
			const el = feedbackEl.querySelector(`[data-feedback-id="${fb.feedbackId}"]`) as HTMLElement | null;
			if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
		}
	}

	function handleSidebarItemClick(fb: import('$lib/galleryFeedbackStore').GalleryFeedback) {
		activeMarkerId = activeMarkerId === fb.feedbackId ? null : fb.feedbackId;
	}

	async function handleSend() {
		const text = composerText.trim();
		if (!text || !channelId || !workId) return;
		if (pendingMarker) {
			await addFeedback(channelId, workId, text, pendingMarker.x, pendingMarker.y);
			pendingMarker = null;
			composerText = '';
		}
	}

	function handleComposerKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	}

	function onActivateKey(e: KeyboardEvent, action: () => void) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			action();
		}
	}
</script>

{#if visible && currentItem}
	<div
		class="lightbox-backdrop"
		role="presentation"
		on:click|self={close}
		transition:fade
	>
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

		{#if feedbackMode}
			<div class="lightbox-body-row">
				<div class="lightbox-media-col">
					<div
						class="lightbox-media"
						role="button"
						tabindex="0"
						aria-label="Place feedback marker on media"
						on:click={handleMediaClick}
						on:keydown={(e) => onActivateKey(e, () => handleMediaClick(e as unknown as MouseEvent))}
					>
						{#if currentItem.attachmentMime?.startsWith('video/')}
							<video
								src={currentItem.attachmentUrl}
								controls
								autoplay
								class="lightbox-video"
								on:click|stopPropagation
							>
								<track kind="captions" />
							</video>
						{:else}
							<img
								src={currentItem.attachmentUrl}
								alt={currentItem.attachmentName}
								class="lightbox-image"
							/>
						{/if}
					</div>
					{#if feedbackList.length > 0 || pendingMarker}
						<div class="lightbox-markers">
							{#each feedbackList as fb, idx (fb.feedbackId)}
								<button
									class="lightbox-marker-dot"
									class:active={activeMarkerId === fb.feedbackId}
									style="left: {fb.xPercent}%; top: {fb.yPercent}%"
									on:click|stopPropagation={() => handleMarkerClick(fb)}
									aria-label="Feedback marker {idx + 1}"
								>
									{idx + 1}
								</button>
							{/each}
							{#if pendingMarker}
								<div
									class="lightbox-marker-dot lightbox-marker-pending"
									style="left: {pendingMarker.x}%; top: {pendingMarker.y}%"
								></div>
							{/if}
						</div>
					{/if}
				</div>
				<div class="lightbox-feedback-sidebar" bind:this={feedbackEl}>
					<div class="lightbox-feedback-header">
						<span>Feedback ({feedbackList.length})</span>
						<span class="lightbox-feedback-header-hint">
							{pendingMarker ? 'Type and send' : 'Click image to place marker'}
						</span>
					</div>
					{#if feedbackError}
						<div class="lightbox-feedback-error">{feedbackError}</div>
					{/if}
					<div class="lightbox-feedback-list">
						{#if feedbackLoading && feedbackList.length === 0}
							<div class="lightbox-feedback-loading">Loading feedback...</div>
						{:else if feedbackList.length === 0}
							<div class="lightbox-feedback-empty">
								{pendingMarker
									? 'Type your comment and press Send.'
									: 'Click on the image to place a numbered marker, then add a comment.'}
							</div>
						{:else}
							{#each feedbackList as fb, idx (fb.feedbackId)}
								{@const author = findFeedbackAuthor(fb.authorUserId)}
								{@const timeStr = formatGalleryTime(fb.createdAtMicros > 1e12 ? Math.floor(fb.createdAtMicros / 1000) : fb.createdAtMicros)}
								<div
									class="lightbox-feedback-item"
									class:active={activeMarkerId === fb.feedbackId}
									data-feedback-id={fb.feedbackId}
									role="button"
									tabindex="0"
									aria-label="Feedback {idx + 1}"
									on:click={() => handleSidebarItemClick(fb)}
									on:keydown={(e) => onActivateKey(e, () => handleSidebarItemClick(fb))}
								>
									<div class="lightbox-feedback-number">{idx + 1}</div>
									<div class="lightbox-feedback-body">
										<div class="lightbox-feedback-comment">{fb.comment}</div>
										<div class="lightbox-feedback-meta">
											{#if author}
												<span class="lightbox-feedback-author" style="color: {author.color || 'var(--text-secondary)'}">
													{author.username}
												</span>
											{:else}
												<span class="lightbox-feedback-author">User #{fb.authorUserId}</span>
											{/if}
											<span>{timeStr}</span>
										</div>
									</div>
								</div>
							{/each}
						{/if}
					</div>
					<div class="lightbox-feedback-composer">
						<textarea
							bind:this={composerEl}
							class="lightbox-feedback-input"
							placeholder={pendingMarker ? 'Add a comment...' : 'Click image to place marker, then type...'}
							bind:value={composerText}
							on:keydown={handleComposerKeydown}
							disabled={!pendingMarker}
							rows="1"
						></textarea>
						<button
							class="lightbox-feedback-send"
							on:click={handleSend}
							disabled={!composerText.trim() || !pendingMarker}
							aria-label="Send feedback"
						>
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
								<line x1="22" y1="2" x2="11" y2="13"/>
								<polygon points="22 2 15 22 11 13 2 9 22 2"/>
							</svg>
						</button>
					</div>
				</div>
			</div>
		{:else}
			<div
				class="lightbox-media"
				role="button"
				tabindex="0"
				aria-label="Close lightbox"
				on:click={close}
				on:keydown={(e) => onActivateKey(e, close)}
			>
				{#if currentItem.attachmentMime?.startsWith('video/')}
					<video
						src={currentItem.attachmentUrl}
						controls
						autoplay
						class="lightbox-video"
						on:click|stopPropagation
					>
						<track kind="captions" />
					</video>
				{:else}
					<img
						src={currentItem.attachmentUrl}
						alt={currentItem.attachmentName}
						class="lightbox-image"
					/>
				{/if}
			</div>
		{/if}

		<div class="lightbox-info" role="presentation" on:click|stopPropagation>
			<div class="lightbox-info-row">
				<div class="lightbox-info-left">
					{#if currentCreator}
						<div class="lightbox-creator">
							<div class="lightbox-avatar" style="background: {currentCreator.color || 'var(--accent-primary-color)'};">
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
				</div>
				{#if shareRecord}
					<ObjectShareMenu record={shareRecord} />
				{/if}
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
		z-index: var(--z-lightbox, 2000);
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
