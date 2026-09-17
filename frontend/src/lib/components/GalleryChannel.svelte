<script lang="ts">
	import { onDestroy } from 'svelte';
	import { currentChannel, channels, users } from '$lib/socket';
	import {
		createGalleryWorkspace,
		formatGalleryTime,
		getCreatorInitial,
		GALLERY_RECENT_COUNT,
		type GalleryItem,
		type GalleryCreator,
	} from '$lib/galleryStore';
	const galleryWorkspace = createGalleryWorkspace();
	const {
		galleryItemsStore,
		galleryCreatorsStore,
		galleryLoadingStore,
		galleryErrorStore,
		galleryWarningStore,
		loadGallery,
		uploadGalleryImages,
		refreshCreators,
	} = galleryWorkspace;
	import {
		filterGalleryItems,
		splitGallerySections,
		galleryViewState,
		guessGalleryMediaKind,
	} from '$lib/galleryFilter';
	import { _ } from '$lib/i18n';
	import GalleryLightbox from './GalleryLightbox.svelte';
	import { initObjectRefRegistry, registerObjectRef, slugify } from '$lib/objectRefRegistry';
	import { openShareModal } from '$lib/shareStore';
	import { buildShareLink, buildShareRefText, copyToClipboard } from '$lib/shareToChannel';
	import { peekPendingNav, takePendingNav } from '$lib/pendingNav';

	export let channelId: string | undefined = undefined;
	$: effectiveChannel = channelId || $currentChannel;

	$: activeChannel = $channels.find((ch) => ch.id === effectiveChannel) || null;
	$: allItems = $galleryItemsStore;
	$: allCreators = $galleryCreatorsStore;
	$: isLoading = $galleryLoadingStore;
	$: error = $galleryErrorStore;
	$: warning = $galleryWarningStore;

	let activeTypeFilter: 'all' | 'image' | 'video' = 'all';
	let activeCreatorFilter: GalleryCreator | null = null;
	let searchQuery = '';
	let lightboxVisible = false;
	let lightboxIndex = 0;
	let lightboxItems: GalleryItem[] = [];
	let recentItems: GalleryItem[] = [];
	let olderItems: GalleryItem[] = [];
	let loadedChannelId: string | null = null;

	let uploadInputElement: HTMLInputElement | null = null;
	let isUploading = false;
	let uploadErrorList: string[] = [];
	let uploadNoticeText: string | null = null;
	let isDragOver = false;
	let dragDepth = 0;

	// Live creator names without refetching; the subscription is owned by this
	// mount and released on destroy.
	const stopUsers = users.subscribe(() => {
		refreshCreators();
	});

	function resetChannelState() {
		lightboxVisible = false;
		lightboxItems = [];
		lightboxIndex = 0;
		searchQuery = '';
		activeTypeFilter = 'all';
		activeCreatorFilter = null;
		isUploading = false;
		uploadErrorList = [];
		uploadNoticeText = null;
		isDragOver = false;
		dragDepth = 0;
	}

	// Single guarded load per channel — no duplicate initial loads.
	$: if (effectiveChannel && effectiveChannel !== loadedChannelId) {
		loadedChannelId = effectiveChannel;
		resetChannelState();
		loadGallery(effectiveChannel);
	}

	$: if (!effectiveChannel && loadedChannelId) {
		loadedChannelId = null;
		resetChannelState();
	}

	initObjectRefRegistry();

	$: if (allItems.length > 0 && effectiveChannel) {
		for (const item of allItems) {
			registerObjectRef({
				kind: 'gallery_work',
				id: item.id,
				slug: slugify(item.attachmentName),
				title: item.attachmentName,
				channelId: effectiveChannel,
				subtitle: item.creator?.username || undefined,
				thumbUrl: item.attachmentUrl,
				updatedAt: item.uploadedAt,
			});
		}
	}

	function shareGalleryItem(item: GalleryItem) {
		openShareModal({
			kind: 'gallery_work',
			id: item.id,
			slug: slugify(item.attachmentName),
			title: item.attachmentName,
			channelId: effectiveChannel,
			subtitle: item.creator?.username || undefined,
			thumbUrl: item.attachmentUrl,
			updatedAt: item.uploadedAt,
		});
	}

	// Filters apply to the FULL list first; the recent/older split below only
	// sections the already-filtered matches. The uploader filter uses the
	// stable uploadedBy id so offline uploaders stay filterable.
	$: filteredItems = filterGalleryItems(allItems, {
		query: searchQuery,
		type: activeTypeFilter,
		uploaderId: activeCreatorFilter?.dbUserId ?? null,
	});

	$: ({ recent: recentItems, older: olderItems } = splitGallerySections(
		filteredItems,
		GALLERY_RECENT_COUNT
	));
	$: mainItems = activeCreatorFilter ? filteredItems : olderItems;
	$: viewState = galleryViewState(allItems.length, filteredItems.length);
	$: filtersActive =
		searchQuery.trim() !== '' || activeTypeFilter !== 'all' || activeCreatorFilter !== null;

	function clearFilters() {
		searchQuery = '';
		activeTypeFilter = 'all';
		activeCreatorFilter = null;
	}

	$: creatorHeader = activeCreatorFilter
		? allCreators.find((c) => c.dbUserId === activeCreatorFilter.dbUserId) || null
		: null;

	// C2: deep-link handoff after items load — peek first, take only on hit
	$: if (effectiveChannel && allItems.length > 0) {
		const pending = peekPendingNav();
		if (
			pending?.kind === 'gallery_work' &&
			(!pending.channelId || pending.channelId === effectiveChannel)
		) {
			const idx = allItems.findIndex((item) => item.id === pending.workId);
			if (idx >= 0) {
				takePendingNav('gallery_work', effectiveChannel);
				openLightbox(idx, allItems);
			}
		}
	}

	let observer: IntersectionObserver | null = null;
	const videoState = new Map<string, { el: HTMLVideoElement; hovered: boolean; inView: boolean }>();

	function setupIntersectionObserver() {
		if (typeof window === 'undefined') return;
		observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const id = (entry.target as HTMLElement).dataset.itemId;
					if (!id) continue;
					const state = videoState.get(id);
					if (!state) continue;
					state.inView = entry.isIntersecting && entry.intersectionRatio > 0.3;
					applyVideoState(state);
				}
			},
			{ threshold: [0.3] }
		);
	}

	setupIntersectionObserver();

	function applyVideoState(state: { el: HTMLVideoElement; hovered: boolean; inView: boolean }) {
		if (state.hovered || state.inView) {
			state.el.play().catch(() => {});
		} else {
			state.el.pause();
		}
	}

	function registerVideo(id: string, el: HTMLVideoElement) {
		const existing = videoState.get(id);
		const state = existing || { el, hovered: false, inView: false };
		state.el = el;
		videoState.set(id, state);
		if (observer) observer.observe(el);
	}

	function unregisterVideo(id: string) {
		const state = videoState.get(id);
		if (state && observer) observer.unobserve(state.el);
		videoState.delete(id);
	}

	function videoRef(el: HTMLVideoElement, id: string) {
		registerVideo(id, el);
		return { destroy() { unregisterVideo(id); } };
	}

	function setVideoHover(id: string, hovered: boolean) {
		const state = videoState.get(id);
		if (!state) return;
		state.hovered = hovered;
		applyVideoState(state);
	}

	function setTypeFilter(type: 'all' | 'image' | 'video') {
		activeTypeFilter = type;
	}

	function toggleCreatorFilter(creator: GalleryCreator) {
		if (activeCreatorFilter?.dbUserId === creator.dbUserId) {
			activeCreatorFilter = null;
		} else {
			activeCreatorFilter = creator;
		}
	}

	function clearCreatorFilter() {
		activeCreatorFilter = null;
	}

	function openLightbox(index: number, items: GalleryItem[]) {
		lightboxIndex = index;
		lightboxItems = items;
		lightboxVisible = true;
	}

	function closeLightbox() {
		lightboxVisible = false;
	}

	function handleLightboxFilterByCreator(creator: GalleryCreator) {
		toggleCreatorFilter(creator);
	}

	function triggerUploadPicker() {
		uploadInputElement?.click();
	}

	async function handleUploadInputChange(event: Event) {
		const input = event.target as HTMLInputElement;
		const files = input.files ? Array.from(input.files) : [];
		input.value = '';
		if (files.length === 0) return;
		await runGalleryUpload(files);
	}

	function handleDragEnter(event: DragEvent) {
		event.preventDefault();
		dragDepth++;
		isDragOver = true;
	}

	function handleDragOver(event: DragEvent) {
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
	}

	function handleDragLeave(event: DragEvent) {
		event.preventDefault();
		dragDepth = Math.max(0, dragDepth - 1);
		if (dragDepth === 0) isDragOver = false;
	}

	async function handleDrop(event: DragEvent) {
		event.preventDefault();
		dragDepth = 0;
		isDragOver = false;
		const files = Array.from(event.dataTransfer?.files || []);
		if (files.length === 0) return;
		await runGalleryUpload(files);
	}

	async function runGalleryUpload(files: File[]) {
		if (!effectiveChannel || isUploading) return;
		if (files.length === 0) return;
		const channel = $channels.find((ch) => ch.id === effectiveChannel) || null;
		isUploading = true;
		uploadErrorList = [];
		uploadNoticeText = null;
		try {
			const result = await uploadGalleryImages(effectiveChannel, files, channel?.name);
			if (result.uploaded > 0) {
				uploadNoticeText =
					result.errors.length > 0
						? `Uploaded ${result.uploaded} of ${files.length} files`
						: `Uploaded ${result.uploaded} file${result.uploaded === 1 ? '' : 's'}`;
			}
			if (result.errors.length > 0) {
				uploadErrorList = result.errors;
			}
		} finally {
			isUploading = false;
		}
	}

	onDestroy(() => {
		stopUsers();
		for (const state of videoState.values()) {
			try {
				state.el.pause();
			} catch {
				// ignore teardown races
			}
		}
		videoState.clear();
		if (observer) observer.disconnect();
		galleryWorkspace.dispose();
	});
</script>

<div
	class="gallery-channel"
	class:drop-active={isDragOver}
	role="group"
	on:dragenter={handleDragEnter}
	on:dragover={handleDragOver}
	on:dragleave={handleDragLeave}
	on:drop={handleDrop}
>
	<header class="gallery-header">
		<div class="gallery-header-left">
			<span class="gallery-hash">#</span>
			<span class="gallery-title">{activeChannel?.name || 'gallery'}</span>
			{#if creatorHeader}
				<span class="gallery-creator-badge">
					<div class="gallery-creator-badge-avatar" style="background: {creatorHeader.color || 'var(--accent-primary-color)'};">
						{getCreatorInitial(creatorHeader.username)}
					</div>
					{creatorHeader.username}
				</span>
			{/if}
		</div>
		<div class="gallery-header-actions">
			<input
				class="gallery-upload-input"
				type="file"
				accept="image/*,video/*"
				multiple
				bind:this={uploadInputElement}
				on:change={handleUploadInputChange}
			/>
			<button
				class="gallery-upload-btn"
				class:busy={isUploading}
				disabled={isUploading || !effectiveChannel}
				on:click={triggerUploadPicker}
				aria-label={$_('gallery_upload')}
				title={$_('gallery_upload')}
			>
				{#if isUploading}
					<span class="gallery-upload-spinner"></span>
				{:else}
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
						<path d="M12 5v14M5 12h14"/>
					</svg>
				{/if}
			</button>
			<input
				type="text"
				class="gallery-search"
				placeholder="Search works..."
				bind:value={searchQuery}
			/>
		</div>
	</header>

	{#if uploadNoticeText}
		<div class="gallery-upload-notice" role="status">{uploadNoticeText}</div>
	{/if}
	{#if uploadErrorList.length > 0}
		<div class="gallery-upload-error" role="alert">
			{#each uploadErrorList.slice(0, 3) as uploadError}
				<div>{uploadError}</div>
			{/each}
			{#if uploadErrorList.length > 3}
				<div>…and {uploadErrorList.length - 3} more</div>
			{/if}
		</div>
	{/if}
	{#if warning}
		<div class="gallery-warning" role="status">
			<span>{warning}</span>
			<button on:click={() => effectiveChannel && loadGallery(effectiveChannel)}>Retry</button>
		</div>
	{/if}

	{#if isDragOver}
		<div class="gallery-dropzone" aria-hidden="true">
			<div class="gallery-dropzone-inner">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
					<path d="M12 16V7"/>
					<path d="M8 11l4-4 4 4"/>
					<path d="M5 19h14"/>
				</svg>
				<span>{$_('gallery_drop_hint')}</span>
			</div>
		</div>
	{/if}

	<div class="gallery-content">
		{#if isLoading}
			<div class="gallery-loading">
				<div class="loading-spinner"></div>
				<span>Loading gallery...</span>
			</div>
		{:else if error}
			<div class="gallery-error">
				<span>{error}</span>
				<button on:click={() => effectiveChannel && loadGallery(effectiveChannel)}>Retry</button>
			</div>
		{:else if viewState === 'empty'}
			<div class="gallery-empty">
				<div class="empty-icon">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
						<rect x="3" y="3" width="18" height="18" rx="2"/>
						<circle cx="8.5" cy="8.5" r="1.5"/>
						<path d="M21 15l-5-5L5 21"/>
					</svg>
				</div>
				<h3>No works yet</h3>
				<p>Upload images or videos to albums in this channel to populate the gallery.</p>
			</div>
		{:else}
			{#if !activeCreatorFilter && recentItems.length > 0}
				<section class="recent-section">
					<div class="section-header">
						<h2>Recently Uploaded</h2>
						<span class="section-count">{recentItems.length} new</span>
					</div>
					<div class="recent-scroll">
						{#each recentItems as item, idx (item.id)}
							<div
								class="recent-card"
								role="button"
								tabindex="0"
								aria-label="Open {item.attachmentName}"
								on:click={() => openLightbox(idx, recentItems)}
								on:keydown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										openLightbox(idx, recentItems);
									}
								}}
								on:contextmenu|stopPropagation={(e) => { e.preventDefault(); shareGalleryItem(recentItems[idx]); }}
							>
								<div class="recent-card-cover">
									{#if guessGalleryMediaKind(item.attachmentMime, item.attachmentName) === 'video'}
										<video
											src={item.attachmentUrl}
											muted
											preload="metadata"
											class="recent-media"
											playsinline
											loop
											data-item-id={item.id}
											use:videoRef={item.id}
											on:mouseenter={() => setVideoHover(item.id, true)}
											on:mouseleave={() => setVideoHover(item.id, false)}
										>
											<track kind="captions" />
										</video>
									{:else}
										<img src={item.attachmentUrl} alt={item.attachmentName} class="recent-media" loading="lazy" />
									{/if}
									<div class="recent-gloss"></div>
									<div class="recent-card-info">
										<span class="recent-card-title">{item.attachmentName}</span>
										<div class="recent-card-meta">
											{#if item.creator}
												<button
													class="recent-card-creator"
													on:click|stopPropagation={() => item.creator && toggleCreatorFilter({
														dbUserId: item.creator!.dbUserId!,
														username: item.creator!.username,
														profilePicture: item.creator!.profilePicture,
														color: item.creator!.color || item.creator!.roleColor,
														workCount: allCreators.find(c => c.dbUserId === item.creator!.dbUserId)?.workCount || 0,
														latestUpload: item!.uploadedAt,
													})}
												>
													{item.creator.username}
												</button>
											{/if}
											<span class="recent-card-time">{formatGalleryTime(item.uploadedAt)}</span>
										</div>
									</div>
								</div>
							</div>
						{/each}
					</div>
				</section>
			{/if}

			{#if activeCreatorFilter && creatorHeader}
				<div class="creator-banner">
					{#if creatorHeader.bannerUrl}
						<img class="creator-banner-image" src={creatorHeader.bannerUrl} alt="" />
					{/if}
					<div class="creator-banner-overlay"></div>
					<div class="creator-banner-content">
						<div class="creator-banner-avatar" style="background: {creatorHeader.color || 'var(--accent-primary-color)'};">
							{getCreatorInitial(creatorHeader.username)}
						</div>
						<div class="creator-banner-info">
							<h2>{creatorHeader.username}</h2>
							<span class="creator-banner-stats">{creatorHeader.workCount} works in this gallery</span>
						</div>
						<button class="creator-banner-clear" on:click={clearCreatorFilter}>
							Show all
						</button>
					</div>
				</div>
			{/if}

			{#if mainItems.length > 0}
				<section class="gallery-section">
					{#if !activeCreatorFilter}
						<div class="section-header">
							<h2>{filtersActive ? 'Matching works' : 'All Works'}</h2>
							<span class="section-count">{mainItems.length} total</span>
						</div>
					{/if}
					<div class="gallery-grid">
						{#each mainItems as item, idx (item.id)}
							<div
								class="gallery-card"
								role="button"
								tabindex="0"
								aria-label="Open {item.attachmentName}"
								on:click={() => openLightbox(idx, mainItems)}
								on:keydown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										openLightbox(idx, mainItems);
									}
								}}
								on:contextmenu|stopPropagation={(e) => { e.preventDefault(); shareGalleryItem(mainItems[idx]); }}
							>
								<div class="card-cover">
									{#if guessGalleryMediaKind(item.attachmentMime, item.attachmentName) === 'video'}
										<video
											src={item.attachmentUrl}
											muted
											preload="metadata"
											class="card-media"
											playsinline
											loop
											data-item-id={item.id}
											use:videoRef={item.id}
											on:mouseenter={() => setVideoHover(item.id, true)}
											on:mouseleave={() => setVideoHover(item.id, false)}
										>
											<track kind="captions" />
										</video>
									{:else}
										<img src={item.attachmentUrl} alt={item.attachmentName} class="card-media" loading="lazy" />
									{/if}
									<div class="card-gloss"></div>
									<div class="card-overlay">
										{#if item.creator}
											<div
												class="card-avatar"
												style="background: {item.creator.color || item.creator.roleColor || 'var(--accent-primary-color)'};"
											>
												{getCreatorInitial(item.creator.username)}
											</div>
											<button
												class="card-creator-name"
												on:click|stopPropagation={() => item.creator && toggleCreatorFilter({
													dbUserId: item.creator!.dbUserId!,
													username: item.creator!.username,
													profilePicture: item.creator!.profilePicture,
													color: item.creator!.color || item.creator!.roleColor,
													workCount: allCreators.find(c => c.dbUserId === item.creator!.dbUserId)?.workCount || 0,
													latestUpload: item!.uploadedAt,
												})}
											>
												{item.creator.username}
											</button>
										{:else}
											<div class="card-avatar">?</div>
											<span class="card-creator-name">Unknown</span>
										{/if}
										<span class="card-time">{formatGalleryTime(item.uploadedAt)}</span>
									</div>
								</div>
							</div>
						{/each}
					</div>
				</section>
			{:else}
				<div class="gallery-empty">
					<h3>No works match these filters</h3>
					<p>Try a different search, media type, or creator.</p>
					<button class="creator-banner-clear" on:click={clearFilters}>Clear filters</button>
				</div>
			{/if}
		{/if}
	</div>

	<footer class="filter-bar">
		<div class="filter-bar-left">
			<button class="filter-btn" class:active={activeTypeFilter === 'all'} on:click={() => setTypeFilter('all')}>All</button>
			<button class="filter-btn" class:active={activeTypeFilter === 'image'} on:click={() => setTypeFilter('image')}>Images</button>
			<button class="filter-btn" class:active={activeTypeFilter === 'video'} on:click={() => setTypeFilter('video')}>Video</button>
			<div class="filter-divider"></div>
			<div class="filter-creators">
				{#each allCreators.slice(0, 10) as creator}
					<button
						class="creator-chip"
						class:active={activeCreatorFilter?.dbUserId === creator.dbUserId}
						on:click={() => toggleCreatorFilter(creator)}
						title={creator.username}
					>
						<div class="creator-chip-avatar" style="background: {creator.color || 'var(--accent-primary-color)'};">
							{getCreatorInitial(creator.username)}
						</div>
						<span class="creator-chip-name">{creator.username}</span>
					</button>
				{/each}
			</div>
		</div>
	</footer>

	<GalleryLightbox
		bind:visible={lightboxVisible}
		items={lightboxItems}
		bind:currentIndex={lightboxIndex}
		creators={allCreators}
		channelId={$currentChannel}
		workId={lightboxItems[lightboxIndex]?.id || null}
		onFilterByCreator={handleLightboxFilterByCreator}
	/>
</div>

