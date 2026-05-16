<script lang="ts">
	import { _ } from '$lib/i18n';
	import { buildReverseImageSearchUrl, getReverseImageSearchProvider } from '$lib/imageUtilities';

	export let imageUrl: string | null = null;
	export let gallery: string[] = [];
	export let onClose: () => void = () => {};

	let currentIndex: number = 0;
	let imageZoom = 1;
	let imageMenuOpen = false;
	let imageMeta: { name: string; width: number | null; height: number | null; sizeBytes: number | null } = {
		name: '',
		width: null,
		height: null,
		sizeBytes: null
	};

	$: currentImageUrl = imageUrl;

	function getFileNameFromUrl(url: string): string {
		try {
			const pathname = new URL(url, window.location.origin).pathname;
			const lastSegment = pathname.split('/').pop() || 'image';
			return decodeURIComponent(lastSegment);
		} catch {
			return 'image';
		}
	}

	function formatBytes(bytes: number | null): string {
		if (bytes === null || Number.isNaN(bytes)) return 'Unknown';
		if (bytes < 1024) return `${bytes} B`;
		const kb = bytes / 1024;
		if (kb < 1024) return `${kb.toFixed(1)} KB`;
		const mb = kb / 1024;
		if (mb < 1024) return `${mb.toFixed(1)} MB`;
		const gb = mb / 1024;
		return `${gb.toFixed(2)} GB`;
	}

	function resetImageOverlayState(url: string) {
		imageZoom = 1;
		imageMenuOpen = false;
		imageMeta = {
			name: getFileNameFromUrl(url),
			width: null,
			height: null,
			sizeBytes: null
		};
		void resolveImageSize(url);
	}

	async function resolveImageSize(url: string) {
		try {
			const response = await fetch(url);
			if (!response.ok) return;
			const blob = await response.blob();
			imageMeta = { ...imageMeta, sizeBytes: blob.size };
		} catch {
			// Ignore metadata failures for external/CORS-protected URLs.
		}
	}

	function setImageZoom(nextZoom: number) {
		imageZoom = Math.max(0.25, Math.min(5, nextZoom));
	}

	function zoomIn() {
		setImageZoom(imageZoom + 0.25);
	}

	function zoomOut() {
		setImageZoom(imageZoom - 0.25);
	}

	function resetZoom() {
		imageZoom = 1;
	}

	function toggleImageMenu() {
		imageMenuOpen = !imageMenuOpen;
	}

	function onEnlargedImageLoad(event: Event) {
		const imageEl = event.currentTarget as HTMLImageElement;
		imageMeta = {
			...imageMeta,
			width: imageEl.naturalWidth || null,
			height: imageEl.naturalHeight || null
		};
	}

	async function copyCurrentImageLink() {
		if (!currentImageUrl || !navigator.clipboard) return;
		try {
			await navigator.clipboard.writeText(currentImageUrl);
		} catch (error) {
			console.warn('Failed to copy image link:', error);
		}
		imageMenuOpen = false;
	}

	async function copyCurrentImage() {
		if (!currentImageUrl || !navigator.clipboard || typeof ClipboardItem === 'undefined') {
			await copyCurrentImageLink();
			return;
		}
		try {
			const response = await fetch(currentImageUrl);
			if (!response.ok) throw new Error(`Failed to fetch image (${response.status})`);
			const blob = await response.blob();
			await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
		} catch (error) {
			console.warn('Failed to copy image, falling back to link copy:', error);
			await copyCurrentImageLink();
		}
		imageMenuOpen = false;
	}

	function openReverseImageSearch(): void {
		if (!currentImageUrl) return;
		const provider = getReverseImageSearchProvider();
		const searchUrl = buildReverseImageSearchUrl(currentImageUrl, provider);
		window.open(searchUrl, '_blank', 'noopener,noreferrer');
		imageMenuOpen = false;
	}

	async function forwardCurrentImage() {
		if (!currentImageUrl) return;
		const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
		if (nav.share) {
			try {
				await nav.share({ url: currentImageUrl, title: imageMeta.name });
				return;
			} catch {
				// Share dialog dismissed or unavailable for this payload.
			}
		}
		await copyCurrentImageLink();
	}

	function navigateImage(direction: 'prev' | 'next') {
		const effectiveGallery = gallery.length > 0 ? gallery : [currentImageUrl];
		if (effectiveGallery.length === 0) return;
		if (direction === 'prev') {
			currentIndex = (currentIndex - 1 + effectiveGallery.length) % effectiveGallery.length;
		} else {
			currentIndex = (currentIndex + 1) % effectiveGallery.length;
		}
		const nextUrl = effectiveGallery[currentIndex];
		if (nextUrl) resetImageOverlayState(nextUrl);
	}

	$: if (imageUrl) {
		const effectiveGallery = gallery.length > 0 ? gallery : [imageUrl];
		currentIndex = effectiveGallery.indexOf(imageUrl);
		if (currentIndex < 0) currentIndex = 0;
		resetImageOverlayState(imageUrl);
	}
</script>

{#if imageUrl}
	<!-- svelte-ignore a11y-click-events-have-key-events -->
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div
		class="image-modal"
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
		<!-- svelte-ignore a11y-click-events-have-key-events -->
		<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
		<img
			src={imageUrl}
			alt={$_('messages.viewer.enlarged_alt')}
			class="enlarged-image"
			on:click|stopPropagation
			on:load={onEnlargedImageLoad}
			style={`transform: scale(${imageZoom});`}
		/>

		<!-- Navigation arrows (only show if multiple images) -->
		{#if gallery.length > 1}
			<button class="nav-arrow nav-prev" on:click|stopPropagation={() => navigateImage('prev')} title={$_('messages.viewer.previous')}>
				&lt;
			</button>
			<button class="nav-arrow nav-next" on:click|stopPropagation={() => navigateImage('next')} title={$_('messages.viewer.next')}>
				&gt;
			</button>
			<div class="image-counter">
				{currentIndex + 1} / {gallery.length}
			</div>
		{/if}

		<div class="lightbox-toolbar-wrap" on:click|stopPropagation>
			<div class="lightbox-toolbar">
				<a
					href={imageUrl}
					target="_blank"
					rel="noopener noreferrer"
					class="toolbar-btn"
					title={$_('messages.viewer.open_new_tab')}
					aria-label={$_('messages.viewer.open_new_tab')}
				>
					<svg class="toolbar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M14 3h7v7" />
						<path d="M10 14 21 3" />
						<path d="M21 14v7h-7" />
						<path d="M3 10V3h7" />
						<path d="M3 21h7v-7" />
					</svg>
				</a>
				<button class="toolbar-btn" on:click={forwardCurrentImage} title={$_('messages.viewer.forward_share')} aria-label={$_('messages.viewer.forward_share')}>
					<svg class="toolbar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M5 12h14" />
						<path d="m13 5 7 7-7 7" />
					</svg>
				</button>
				<button class="toolbar-btn" on:click={zoomOut} title={$_('messages.viewer.zoom_out')} aria-label={$_('messages.viewer.zoom_out')}>
					-
				</button>
				<button class="toolbar-btn zoom-level" on:click={resetZoom} title={$_('messages.viewer.reset_zoom')} aria-label={$_('messages.viewer.reset_zoom')}>
					{Math.round(imageZoom * 100)}%
				</button>
				<button class="toolbar-btn" on:click={zoomIn} title={$_('messages.viewer.zoom_in')} aria-label={$_('messages.viewer.zoom_in')}>
					+
				</button>
				<div class="toolbar-more-wrap">
					<button class="toolbar-btn" on:click={toggleImageMenu} title={$_('messages.viewer.more')} aria-label={$_('messages.viewer.more_actions')}>
						...
					</button>
					{#if imageMenuOpen}
						<div class="toolbar-menu" role="menu">
							<button class="toolbar-menu-item" on:click={copyCurrentImageLink}>{$_('messages.viewer.copy_image_link')}</button>
							<button class="toolbar-menu-item" on:click={copyCurrentImage}>{$_('messages.viewer.copy_image')}</button>
							<button class="toolbar-menu-item" on:click={openReverseImageSearch}>{$_('messages.viewer.reverse_search')}</button>
							<div class="toolbar-menu-item details-hover-row">
								{$_('messages.viewer.image_details')}
								<div class="image-details-popout" role="note">
									<div><strong>{$_('messages.viewer.details_name')}:</strong> {imageMeta.name}</div>
									<div><strong>{$_('messages.viewer.details_dimensions')}:</strong> {imageMeta.width ?? '?'} x {imageMeta.height ?? '?'}</div>
									<div><strong>{$_('messages.viewer.details_size')}:</strong> {formatBytes(imageMeta.sizeBytes)}</div>
								</div>
							</div>
						</div>
					{/if}
				</div>
			</div>
			<button class="close-modal" on:click={onClose} aria-label={$_('messages.viewer.close')}>X</button>
		</div>
	</div>
{/if}
