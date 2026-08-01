<script lang="ts">
	import { tick } from 'svelte';
	import { browser } from '$app/environment';
	import '$lib/prism-theme.css';
	import { mobileTabQueue } from '$lib/mobileTabQueue';
	import { READER_ADDON_ID } from '$lib/readerWorkspace';
	import ReaderImportSheet from './ReaderImportSheet.svelte';
	import { countWords, formatSourceLabel, renderReaderHtml } from './readerTabHelpers';
	import {
		clearReaderSelection,
		openReaderDocument,
		openReaderHistoryEntry,
		openReaderImagesFromFiles,
		openTemporaryReaderFile,
		type ReaderContentWidth,
		readerHistory,
		type ReaderFontFamily,
		readerPreferences,
		readerProgressByDocument,
		readerSelection,
		setReaderDocumentProgress,
		type ReaderTheme,
		updateReaderPreferences,
		type ReaderDocumentFormat,
		type ImagePage,
		type ImageFitMode,
		type ReadingDirection
	} from '$lib/readerWorkspace';

	const ACCEPTED_READER_FILE_TYPES = '.md,.markdown,.txt,.text,.html,.htm';
	const ACCEPTED_IMAGE_FILES = '.jpg,.jpeg,.png,.gif,.webp,.bmp';
	let articleViewport: HTMLDivElement | null = null;
	let fileInput: HTMLInputElement | null = null;
	let importPanelOpen = false;
	let readerChromeHidden = false;
	let importTitle = '';
	let importContent = '';
	let importFormat: ReaderDocumentFormat = 'markdown';
	let importBusy = false;
	let readerProgressPercent = 0;
	let lastRestoredDocKey = '';
	let isFullscreenMode = false;
	let isAtDocumentStart = true;
	let isAtDocumentEnd = false;
	let currentPageEstimate = 1;
	let totalPagesEstimate = 1;

	let imageViewerOpen = false;
	let currentImageIndex = 0;
	let imageInput: HTMLInputElement | null = null;
	let imageImportOpen = false;
	let imageImportTitle = '';

	if (browser) {
		const saved = localStorage.getItem('wabi:reader:fullscreen');
		if (saved === 'true') isFullscreenMode = true;
	}

	function handleImageKeydown(event: KeyboardEvent): void {
		if (!imageViewerOpen) return;
		if (event.key === 'Escape') closeImageViewer();
		if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') goToPreviousImage();
		if (event.key === 'ArrowRight' || event.key === 'ArrowDown') goToNextImage();
	}

	function openImportPanel(format: ReaderDocumentFormat): void {
		importFormat = format;
		importPanelOpen = true;
	}

	function closeImportPanel(): void {
		importPanelOpen = false;
		importTitle = '';
		importContent = '';
		importFormat = 'markdown';
	}

	function submitImportedDocument(): void {
		if (!importContent.trim()) return;
		openReaderDocument(
			importTitle.trim() || 'Pasted Document',
			importContent,
			importFormat,
			'pasted'
		);
		closeImportPanel();
	}

	function openFilePicker(): void {
		fileInput?.click();
	}

	async function handleFileChange(event: Event): Promise<void> {
		const target = event.currentTarget as HTMLInputElement;
		const file = target.files?.[0];
		target.value = '';
		if (!file) return;
		importBusy = true;
		try {
			await openTemporaryReaderFile(file);
		} finally {
			importBusy = false;
		}
	}

	function openImagePicker(): void {
		imageInput?.click();
	}

	async function handleImageFileChange(event: Event): Promise<void> {
		const target = event.currentTarget as HTMLInputElement;
		const files = target.files;
		target.value = '';
		if (!files || files.length === 0) return;
		imageImportOpen = false;
		await openReaderImagesFromFiles(imageImportTitle.trim() || 'Image Gallery', files);
		imageImportTitle = '';
	}

	$: isImageMode = $readerSelection?.contentType === 'images';
	$: currentImages = ($readerSelection?.images || []) as ImagePage[];
	$: currentImage = currentImages[currentImageIndex] || null;
	$: isFirstImage = currentImageIndex <= 0;
	$: isLastImage = currentImages.length > 0 && currentImageIndex >= currentImages.length - 1;

	function openImageViewer(index: number): void {
		currentImageIndex = Math.max(0, Math.min(index, currentImages.length - 1));
		imageViewerOpen = true;
	}

	function closeImageViewer(): void {
		imageViewerOpen = false;
	}

	function goToPreviousImage(): void {
		if (!isFirstImage) {
			currentImageIndex -= 1;
		}
	}

	function goToNextImage(): void {
		if (!isLastImage) {
			currentImageIndex += 1;
		}
	}

	function setImageFit(event: Event): void {
		const value = (event.currentTarget as HTMLSelectElement).value as ImageFitMode;
		updateReaderPreferences({ imageFit: value });
	}

	function setReadingDirection(event: Event): void {
		const value = (event.currentTarget as HTMLSelectElement).value as ReadingDirection;
		updateReaderPreferences({ readingDirection: value });
	}

	function handleViewportScroll(): void {
		if (!$readerSelection || !articleViewport) {
			readerProgressPercent = 0;
			return;
		}
		const maxScroll = Math.max(0, articleViewport.scrollHeight - articleViewport.clientHeight);
		const progress = maxScroll <= 0 ? 0 : articleViewport.scrollTop / maxScroll;
		readerProgressPercent = Math.round(progress * 100);
		setReaderDocumentProgress($readerSelection.docKey, progress);
		updatePageEstimate();
	}

	function updatePageEstimate(): void {
		if (!articleViewport) {
			currentPageEstimate = 1;
			totalPagesEstimate = 1;
			isAtDocumentStart = true;
			isAtDocumentEnd = true;
			return;
		}
		const { scrollTop, scrollHeight, clientHeight } = articleViewport;
		if (scrollHeight <= clientHeight) {
			currentPageEstimate = 1;
			totalPagesEstimate = 1;
			isAtDocumentStart = true;
			isAtDocumentEnd = true;
			return;
		}
		const pageHeight = clientHeight * 0.8;
		totalPagesEstimate = Math.max(1, Math.ceil(scrollHeight / pageHeight));
		currentPageEstimate = Math.min(totalPagesEstimate, Math.floor(scrollTop / pageHeight) + 1);
		isAtDocumentStart = scrollTop <= 0;
		isAtDocumentEnd = scrollTop + clientHeight >= scrollHeight - 5;
	}

	function goToNextPage(): void {
		if (!articleViewport) return;
		const viewportHeight = articleViewport.clientHeight;
		const newScroll = Math.min(
			articleViewport.scrollTop + (viewportHeight * 0.8),
			articleViewport.scrollHeight - viewportHeight
		);
		articleViewport.scrollTop = newScroll;
	}

	function goToPreviousPage(): void {
		if (!articleViewport) return;
		const viewportHeight = articleViewport.clientHeight;
		const newScroll = Math.max(articleViewport.scrollTop - (viewportHeight * 0.8), 0);
		articleViewport.scrollTop = newScroll;
	}

	function toggleFullscreenMode(): void {
		isFullscreenMode = !isFullscreenMode;
		if (browser) {
			localStorage.setItem('wabi:reader:fullscreen', isFullscreenMode ? 'true' : 'false');
		}
	}

	function handleThemeChange(event: Event): void {
		const value = (event.currentTarget as HTMLSelectElement).value as ReaderTheme;
		updateReaderPreferences({ theme: value });
	}

	function handleFontFamilyChange(event: Event): void {
		const value = (event.currentTarget as HTMLSelectElement).value as ReaderFontFamily;
		updateReaderPreferences({ fontFamily: value });
	}

	function handleContentWidthChange(event: Event): void {
		const value = (event.currentTarget as HTMLSelectElement).value as ReaderContentWidth;
		updateReaderPreferences({ contentWidth: value });
	}

	$: renderedDocumentHtml = $readerSelection
		? renderReaderHtml($readerSelection.content, $readerSelection.format)
		: '';
	$: selectedWordCount = $readerSelection ? countWords($readerSelection.content) : 0;
	$: selectedReadMinutes = Math.max(1, Math.ceil(selectedWordCount / 220));
	$: selectedStoredProgress = $readerSelection
		? $readerProgressByDocument[$readerSelection.docKey] ?? 0
		: 0;
	$: if (!$readerSelection) {
		lastRestoredDocKey = '';
		readerProgressPercent = 0;
	}
	$: if ($readerSelection && articleViewport && $readerSelection.docKey !== lastRestoredDocKey) {
		const currentDocKey = $readerSelection.docKey;
		lastRestoredDocKey = currentDocKey;
		const nextProgress = selectedStoredProgress;
		void tick().then(() => {
			if (!articleViewport || $readerSelection?.docKey !== currentDocKey) return;
			const maxScroll = Math.max(0, articleViewport.scrollHeight - articleViewport.clientHeight);
			articleViewport.scrollTop = maxScroll * nextProgress;
			readerProgressPercent = Math.round(nextProgress * 100);
			updatePageEstimate();
		});
	}
</script>

<svelte:window on:keydown={handleImageKeydown} />

<div
	class="reader-shell"
	class:theme-paper={$readerPreferences.theme === 'paper'}
	class:theme-sepia={$readerPreferences.theme === 'sepia'}
	class:theme-night={$readerPreferences.theme === 'night'}
	class:font-serif={$readerPreferences.fontFamily === 'serif'}
	class:font-sans={$readerPreferences.fontFamily === 'sans'}
	class:width-narrow={$readerPreferences.contentWidth === 'narrow'}
	class:width-medium={$readerPreferences.contentWidth === 'medium'}
	class:width-wide={$readerPreferences.contentWidth === 'wide'}
	class:fullscreen-mode={isFullscreenMode}
>
	{#if !readerChromeHidden}
		<div class="reader-toolbar">
			<div class="reader-toolbar-main">
				<div class="reader-title-group">
					<span class="reader-kicker">Reader Mode</span>
					{#if $readerSelection}
						<h2>{$readerSelection.title}</h2>
						<div class="reader-meta">
							<span>{selectedWordCount.toLocaleString()} words</span>
							<span>{selectedReadMinutes} min read</span>
							<span>{readerProgressPercent}%</span>
							<span>{formatSourceLabel($readerSelection.source)}</span>
						</div>
					{:else}
						<h2>Open a long-form document</h2>
						<div class="reader-meta">
							<span>Markdown, text, or HTML</span>
							<span>Recent history stays available during this session</span>
						</div>
					{/if}
				</div>

				<div class="reader-toolbar-actions">
					<button class="reader-action-btn subtle" type="button" on:click={() => mobileTabQueue.closeAddonTab(READER_ADDON_ID)} title="Back to Chat">
						← Back to Chat
					</button>
					{#if $readerSelection}
						<button class="reader-action-btn" type="button" on:click={goToPreviousPage} disabled={isAtDocumentStart} title="Previous Page">
							← Prev
						</button>
						<span class="reader-page-indicator">{currentPageEstimate} / {totalPagesEstimate}</span>
						<button class="reader-action-btn" type="button" on:click={goToNextPage} disabled={isAtDocumentEnd} title="Next Page">
							Next →
						</button>
					{/if}
					<button class="reader-action-btn primary" type="button" on:click={openFilePicker} disabled={importBusy}>
						{importBusy ? 'Opening...' : 'Open File'}
					</button>
					<button class="reader-action-btn" type="button" on:click={openImagePicker}>
						Images
					</button>
					<button class="reader-action-btn" type="button" on:click={() => openImportPanel('markdown')}>
						Paste Markdown
					</button>
					<button class="reader-action-btn" type="button" on:click={() => openImportPanel('text')}>
						Paste Text
					</button>
					{#if $readerSelection}
						<button class="reader-action-btn subtle" type="button" on:click={clearReaderSelection}>
							Clear
						</button>
					{/if}
					<button class="reader-action-btn subtle" type="button" on:click={toggleFullscreenMode} title={isFullscreenMode ? 'Exit Fullscreen' : 'Enter Fullscreen'}>
						{isFullscreenMode ? 'Exit ⛶' : 'Fullscreen ⛶'}
					</button>
				</div>
			</div>

			<div class="reader-toolbar-secondary">
				<div class="reader-control">
					<label for="reader-history-select">Recent</label>
					<select
						id="reader-history-select"
						class="reader-select"
						on:change={(event) => {
							const value = (event.currentTarget as HTMLSelectElement).value;
							if (value) openReaderHistoryEntry(value);
							(event.currentTarget as HTMLSelectElement).value = '';
						}}
					>
						<option value="">Recent documents</option>
						{#each $readerHistory as entry}
							<option value={entry.id}>{entry.title}</option>
						{/each}
					</select>
				</div>

				<div class="reader-control">
					<label for="reader-theme-select">Theme</label>
					<select
						id="reader-theme-select"
						class="reader-select"
						value={$readerPreferences.theme}
						on:change={handleThemeChange}
					>
						<option value="paper">Paper</option>
						<option value="sepia">Sepia</option>
						<option value="night">Night</option>
					</select>
				</div>

				<div class="reader-control">
					<label for="reader-font-select">Font</label>
					<select
						id="reader-font-select"
						class="reader-select"
						value={$readerPreferences.fontFamily}
						on:change={handleFontFamilyChange}
					>
						<option value="serif">Serif</option>
						<option value="sans">Sans</option>
					</select>
				</div>

				<div class="reader-control compact">
					<label for="reader-width-select">Width</label>
					<select
						id="reader-width-select"
						class="reader-select"
						value={$readerPreferences.contentWidth}
						on:change={handleContentWidthChange}
					>
						<option value="narrow">Narrow</option>
						<option value="medium">Medium</option>
						<option value="wide">Wide</option>
					</select>
				</div>

				{#if isImageMode}
					<div class="reader-control">
						<label for="reader-image-fit">Fit</label>
						<select
							id="reader-image-fit"
							class="reader-select"
							value={$readerPreferences.imageFit}
							on:change={setImageFit}
						>
							<option value="width">Fit Width</option>
							<option value="height">Fit Height</option>
							<option value="original">Original</option>
						</select>
					</div>

					<div class="reader-control compact">
						<label for="reader-direction">Dir</label>
						<select
							id="reader-direction"
							class="reader-select"
							value={$readerPreferences.readingDirection}
							on:change={setReadingDirection}
						>
							<option value="ltr">LTR</option>
							<option value="rtl">RTL</option>
						</select>
					</div>
				{/if}

				<div class="reader-slider">
					<label for="reader-font-size">Size {$readerPreferences.fontSize}px</label>
					<input
						id="reader-font-size"
						type="range"
						min="14"
						max="28"
						step="1"
						value={$readerPreferences.fontSize}
						on:input={(event) => updateReaderPreferences({ fontSize: Number(event.currentTarget.value) })}
					/>
				</div>

				<div class="reader-slider">
					<label for="reader-line-height">Line {$readerPreferences.lineHeight.toFixed(2)}</label>
					<input
						id="reader-line-height"
						type="range"
						min="1.35"
						max="2.30"
						step="0.05"
						value={$readerPreferences.lineHeight}
						on:input={(event) => updateReaderPreferences({ lineHeight: Number(event.currentTarget.value) })}
					/>
				</div>
			</div>
		</div>
	{:else}
		<button class="reader-focus-return" type="button" on:click={() => (readerChromeHidden = false)}>
			Show Reader Controls
		</button>
	{/if}

	{#if importPanelOpen}
		<ReaderImportSheet
			bind:importTitle
			bind:importContent
			bind:importFormat
			onClose={closeImportPanel}
			onSubmit={submitImportedDocument}
		/>
	{/if}

	<div class="reader-stage">
		{#if $readerSelection}
			{#if isImageMode}
				<div class="reader-image-shell">
					{#if currentImage}
						<button 
							class="image-nav prev" 
							on:click={goToPreviousImage} 
							disabled={isFirstImage}
							title="Previous Image"
						>
							‹
						</button>
						<div class="reader-image-viewport">
							<button
								type="button"
								class="reader-image-open"
								aria-label="Open image viewer"
								on:click={() => openImageViewer(currentImageIndex)}
							>
								<img
									src={currentImage.url}
									alt={currentImage.alt}
									class="reader-image"
									style="object-fit: {$readerPreferences.imageFit};"
								/>
							</button>
						</div>
						<button 
							class="image-nav next" 
							on:click={goToNextImage} 
							disabled={isLastImage}
							title="Next Image"
						>
							›
						</button>
						<div class="image-counter">
							{currentImageIndex + 1} / {currentImages.length}
						</div>
					{:else}
						<div class="reader-empty-state">
							<p>No images loaded</p>
						</div>
					{/if}
				</div>
			{:else}
				<div class="reader-document-shell">
					<div
						class="reader-document-viewport"
						bind:this={articleViewport}
						on:scroll={handleViewportScroll}
					>
						<article
							class="reader-document markdown-content"
							style={`font-size: ${$readerPreferences.fontSize}px; line-height: ${$readerPreferences.lineHeight};`}
						>
							<header class="reader-document-header">
								<h1>{$readerSelection.title}</h1>
								<p class="reader-document-dek">
									{selectedWordCount.toLocaleString()} words | {selectedReadMinutes} min read | {readerProgressPercent}% complete
								</p>
							</header>
							{@html renderedDocumentHtml}
						</article>
					</div>
				</div>
			{/if}
		{:else}
			<div class="reader-empty-state">
				<div class="reader-empty-card">
					<h3>Reader Mode is ready</h3>
					<p>Open a local text file, paste long-form writing, or keep this tab available for future article and publication flows.</p>
					<div class="reader-empty-actions">
						<button class="reader-action-btn primary" type="button" on:click={openFilePicker}>Open File</button>
						<button class="reader-action-btn" type="button" on:click={openImagePicker}>Open Images</button>
						<button class="reader-action-btn" type="button" on:click={() => openImportPanel('markdown')}>Paste Markdown</button>
						<button class="reader-action-btn subtle" type="button" on:click={() => openReaderDocument('Reader Welcome', '# Reader Mode\n\nWabi now has a dedicated long-form reading surface.\n\nUse it for essays, books, issue drafts, and documentation.\n\n## Suggested next steps\n\n- Import a `.md`, `.txt`, or `.html` file\n- Adjust width and typography\n- Re-open recent documents from the toolbar\n- Import images for manga/comic viewing\n', 'markdown', 'generated')}>
							Load Sample
						</button>
					</div>
				</div>
			</div>
		{/if}
	</div>

	<input
		bind:this={fileInput}
		class="hidden-input"
		type="file"
		accept={ACCEPTED_READER_FILE_TYPES}
		on:change={handleFileChange}
	/>

	<input
		bind:this={imageInput}
		class="hidden-input"
		type="file"
		accept={ACCEPTED_IMAGE_FILES}
		multiple
		on:change={handleImageFileChange}
	/>

	{#if imageViewerOpen && currentImage}
		<div
			class="image-viewer-overlay"
			on:click={closeImageViewer}
			role="button"
			tabindex="0"
			aria-label="Close image viewer"
			on:keydown={(e) => {
				if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					closeImageViewer();
				}
			}}
		>
			<div
				class="image-viewer-panel"
				on:click|stopPropagation
				on:keydown|stopPropagation
				role="dialog"
				aria-modal="true"
				tabindex="-1"
				aria-label={currentImage.alt || 'Image viewer'}
			>
				<img src={currentImage.url} alt={currentImage.alt} class="image-viewer-img" style="object-fit: {$readerPreferences.imageFit};" />
				<div class="image-viewer-toolbar">
					<button type="button" on:click={goToPreviousImage} disabled={isFirstImage}>← Prev</button>
					<span>{currentImageIndex + 1} / {currentImages.length}</span>
					<button type="button" on:click={goToNextImage} disabled={isLastImage}>Next →</button>
					<button type="button" on:click={closeImageViewer}>Close</button>
				</div>
			</div>
		</div>
	{/if}
</div>
