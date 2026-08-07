<script lang="ts">
	import { tick } from 'svelte';
	import { browser } from '$app/environment';
	import { brandName } from '$lib/branding';
	import '$lib/prism-theme.css';
	import ReaderImportSheet from './ReaderImportSheet.svelte';
	import { countWords, formatSourceLabel, renderReaderHtml } from './readerTabHelpers';
	import {
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
	const THEME_ORDER: ReaderTheme[] = ['paper', 'sepia', 'night'];
	const MIN_FONT_SIZE = 14;
	const MAX_FONT_SIZE = 28;

	let articleViewport = $state<HTMLDivElement | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);
	let imageInput = $state<HTMLInputElement | null>(null);
	let importPanelOpen = $state(false);
	let readerChromeHidden = $state(false);
	let settingsOpen = $state(false);
	let importTitle = $state('');
	let importContent = $state('');
	let importFormat = $state<ReaderDocumentFormat>('markdown');
	let importBusy = $state(false);
	let readerProgressPercent = $state(0);
	let lastRestoredDocKey = $state('');
	let isFullscreenMode = $state(false);
	let isAtDocumentStart = $state(true);
	let isAtDocumentEnd = $state(false);
	let currentPageEstimate = $state(1);
	let totalPagesEstimate = $state(1);
	let imageViewerOpen = $state(false);
	let currentImageIndex = $state(0);
	let imageImportTitle = $state('');

	if (browser) {
		const saved = localStorage.getItem('wabi:reader:fullscreen');
		if (saved === 'true') isFullscreenMode = true;
	}

	const isImageMode = $derived($readerSelection?.contentType === 'images');
	const currentImages = $derived(($readerSelection?.images || []) as ImagePage[]);
	const currentImage = $derived(currentImages[currentImageIndex] || null);
	const isFirstImage = $derived(currentImageIndex <= 0);
	const isLastImage = $derived(
		currentImages.length > 0 && currentImageIndex >= currentImages.length - 1
	);
	const renderedDocumentHtml = $derived(
		$readerSelection ? renderReaderHtml($readerSelection.content, $readerSelection.format) : ''
	);
	const selectedWordCount = $derived($readerSelection ? countWords($readerSelection.content) : 0);
	const selectedReadMinutes = $derived(Math.max(1, Math.ceil(selectedWordCount / 220)));

	$effect(() => {
		if (!$readerSelection) {
			lastRestoredDocKey = '';
			readerProgressPercent = 0;
		}
	});

	$effect(() => {
		const currentDoc = $readerSelection;
		if (currentDoc && articleViewport && currentDoc.docKey !== lastRestoredDocKey) {
			const currentDocKey = currentDoc.docKey;
			lastRestoredDocKey = currentDocKey;
			const nextProgress = $readerProgressByDocument[currentDocKey] ?? 0;
			void tick().then(() => {
				if (!articleViewport || $readerSelection?.docKey !== currentDocKey) return;
				const maxScroll = Math.max(
					0,
					articleViewport.scrollHeight - articleViewport.clientHeight
				);
				articleViewport.scrollTop = maxScroll * nextProgress;
				readerProgressPercent = Math.round(nextProgress * 100);
				updatePageEstimate();
			});
		}
	});

	function isTypingTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		const tag = target.tagName;
		return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
	}

	function handleReaderKeydown(event: KeyboardEvent): void {
		if (!isTypingTarget(event.target) && event.key.toLowerCase() === 'f') {
			if (!readerChromeHidden) settingsOpen = false;
			readerChromeHidden = !readerChromeHidden;
			return;
		}
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
		await openReaderImagesFromFiles(imageImportTitle.trim() || 'Image Gallery', files);
		imageImportTitle = '';
	}

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
		if (isFullscreenMode) settingsOpen = false;
		if (browser) {
			localStorage.setItem('wabi:reader:fullscreen', isFullscreenMode ? 'true' : 'false');
		}
	}

	function increaseFontSize(): void {
		updateReaderPreferences({ fontSize: Math.min(MAX_FONT_SIZE, $readerPreferences.fontSize + 1) });
	}

	function decreaseFontSize(): void {
		updateReaderPreferences({ fontSize: Math.max(MIN_FONT_SIZE, $readerPreferences.fontSize - 1) });
	}

	function cycleTheme(): void {
		const current = $readerPreferences.theme;
		const index = THEME_ORDER.indexOf(current);
		updateReaderPreferences({ theme: THEME_ORDER[(index + 1) % THEME_ORDER.length] });
	}

	function enterFocusMode(): void {
		settingsOpen = false;
		readerChromeHidden = true;
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
</script>

<svelte:window on:keydown={handleReaderKeydown} />

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
	<div class="reader-progress-track" aria-hidden="true">
		<div class="reader-progress-fill" style:width={`${readerProgressPercent}%`}></div>
	</div>

	{#if !readerChromeHidden}
		<div class="reader-toolbar">
			<div class="reader-toolbar-main">
				{#if !$readerSelection}
					<span class="reader-kicker">Reader Mode</span>
				{/if}

				<div class="reader-toolbar-actions">
					{#if $readerSelection}
						<button
							class="reader-icon-btn"
							type="button"
							onclick={goToPreviousPage}
							disabled={isAtDocumentStart}
							title="Previous Page"
							aria-label="Previous Page"
						>
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="m18 15-6-6-6 6"></path>
							</svg>
						</button>
						<span class="reader-page-indicator">{currentPageEstimate} / {totalPagesEstimate}</span>
						<button
							class="reader-icon-btn"
							type="button"
							onclick={goToNextPage}
							disabled={isAtDocumentEnd}
							title="Next Page"
							aria-label="Next Page"
						>
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="m6 9 6 6 6-6"></path>
							</svg>
						</button>
						<span class="reader-icon-divider" aria-hidden="true"></span>
						<button
							class="reader-icon-btn"
							type="button"
							onclick={decreaseFontSize}
							title="Decrease font size"
							aria-label="Decrease font size"
						>
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<line x1="5" y1="12" x2="19" y2="12"></line>
							</svg>
						</button>
						<button
							class="reader-icon-btn"
							type="button"
							onclick={increaseFontSize}
							title="Increase font size"
							aria-label="Increase font size"
						>
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<line x1="12" y1="5" x2="12" y2="19"></line>
								<line x1="5" y1="12" x2="19" y2="12"></line>
							</svg>
						</button>
						<button
							class="reader-icon-btn"
							type="button"
							onclick={cycleTheme}
							title="Cycle theme"
							aria-label="Cycle theme"
						>
							{#if $readerPreferences.theme === 'night'}
								<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"></path>
								</svg>
							{:else}
								<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<circle cx="12" cy="12" r="4"></circle>
									<path d="M12 2v2"></path>
									<path d="M12 20v2"></path>
									<path d="m4.93 4.93 1.41 1.41"></path>
									<path d="m17.66 17.66 1.41 1.41"></path>
									<path d="M2 12h2"></path>
									<path d="M20 12h2"></path>
									<path d="m6.34 17.66-1.41 1.41"></path>
									<path d="m19.07 4.93-1.41 1.41"></path>
								</svg>
							{/if}
						</button>
						<button
							class="reader-icon-btn"
							type="button"
							onclick={toggleFullscreenMode}
							title={isFullscreenMode ? 'Exit Fullscreen' : 'Enter Fullscreen'}
							aria-label={isFullscreenMode ? 'Exit Fullscreen' : 'Enter Fullscreen'}
						>
							{#if isFullscreenMode}
								<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M8 3v3a2 2 0 0 1-2 2H3"></path>
									<path d="M21 8h-3a2 2 0 0 1-2-2V3"></path>
									<path d="M3 16h3a2 2 0 0 1 2 2v3"></path>
									<path d="M16 21v-3a2 2 0 0 1 2-2h3"></path>
								</svg>
							{:else}
								<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M8 3H5a2 2 0 0 0-2 2v3"></path>
									<path d="M21 8V5a2 2 0 0 0-2-2h-3"></path>
									<path d="M3 16v3a2 2 0 0 0 2 2h3"></path>
									<path d="M16 21h3a2 2 0 0 0 2-2v-3"></path>
								</svg>
							{/if}
						</button>
						<button
							class="reader-icon-btn"
							type="button"
							onclick={enterFocusMode}
							title="Focus mode"
							aria-label="Enter focus mode"
						>
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path>
								<circle cx="12" cy="12" r="3"></circle>
							</svg>
						</button>
						<button
							class="reader-icon-btn"
							class:active={settingsOpen}
							type="button"
							onclick={() => (settingsOpen = !settingsOpen)}
							title="Reader settings"
							aria-label="Reader settings"
							aria-expanded={settingsOpen}
						>
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
								<circle cx="12" cy="12" r="3"></circle>
							</svg>
						</button>
					{:else}
						<button class="reader-action-btn primary" type="button" onclick={openFilePicker} disabled={importBusy}>
							{importBusy ? 'Opening...' : 'Open File'}
						</button>
						<button class="reader-action-btn" type="button" onclick={openImagePicker}>
							Images
						</button>
						<button class="reader-action-btn" type="button" onclick={() => openImportPanel('markdown')}>
							Paste Markdown
						</button>
						<button class="reader-action-btn" type="button" onclick={() => openImportPanel('text')}>
							Paste Text
						</button>
					{/if}
				</div>
			</div>

			<div class="reader-settings-panel" class:open={settingsOpen}>
				<div class="reader-control">
					<label for="reader-history-select">Recent</label>
					<select
						id="reader-history-select"
						class="reader-select"
						onchange={(event) => {
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
						onchange={handleThemeChange}
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
						onchange={handleFontFamilyChange}
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
						onchange={handleContentWidthChange}
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
							onchange={setImageFit}
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
							onchange={setReadingDirection}
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
						oninput={(event) => updateReaderPreferences({ fontSize: Number(event.currentTarget.value) })}
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
						oninput={(event) => updateReaderPreferences({ lineHeight: Number(event.currentTarget.value) })}
					/>
				</div>
			</div>
		</div>
	{:else}
		<button class="reader-focus-return" type="button" onclick={() => (readerChromeHidden = false)}>
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path>
				<circle cx="12" cy="12" r="3"></circle>
			</svg>
			<span>Exit Focus</span>
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
							onclick={goToPreviousImage} 
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
								onclick={() => openImageViewer(currentImageIndex)}
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
							onclick={goToNextImage} 
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
						onscroll={handleViewportScroll}
					>
						<header class="reader-article-header">
							<span class="reader-kicker">Reader Mode</span>
							<h2 class="reader-article-title">{$readerSelection.title}</h2>
							<div class="reader-article-meta">
								<span>{selectedWordCount.toLocaleString()} words</span>
								<span>{selectedReadMinutes} min read</span>
								<span>{readerProgressPercent}%</span>
								<span>{formatSourceLabel($readerSelection.source)}</span>
							</div>
						</header>
						<article
							class="reader-document markdown-content"
							style={`font-size: ${$readerPreferences.fontSize}px; line-height: ${$readerPreferences.lineHeight};`}
						>
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
						<button class="reader-action-btn primary" type="button" onclick={openFilePicker}>Open File</button>
						<button class="reader-action-btn" type="button" onclick={openImagePicker}>Open Images</button>
						<button class="reader-action-btn" type="button" onclick={() => openImportPanel('markdown')}>Paste Markdown</button>
						<button class="reader-action-btn subtle" type="button" onclick={() => openReaderDocument('Reader Welcome', `# Reader Mode\n\n${brandName} now has a dedicated long-form reading surface.\n\nUse it for essays, books, issue drafts, and documentation.\n\n## Suggested next steps\n\n- Import a \`.md\`, \`.txt\`, or \`.html\` file\n- Adjust width and typography\n- Re-open recent documents from the settings panel\n- Import images for manga/comic viewing\n`, 'markdown', 'generated')}>
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
		onchange={handleFileChange}
	/>

	<input
		bind:this={imageInput}
		class="hidden-input"
		type="file"
		accept={ACCEPTED_IMAGE_FILES}
		multiple
		onchange={handleImageFileChange}
	/>

	{#if imageViewerOpen && currentImage}
		<div
			class="image-viewer-overlay"
			onclick={closeImageViewer}
			role="button"
			tabindex="0"
			aria-label="Close image viewer"
			onkeydown={(e) => {
				if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					closeImageViewer();
				}
			}}
		>
			<div
			class="image-viewer-panel"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
			tabindex="-1"
			aria-label={currentImage.alt || 'Image viewer'}
			>
				<img src={currentImage.url} alt={currentImage.alt} class="image-viewer-img" style="object-fit: {$readerPreferences.imageFit};" />
				<div class="image-viewer-toolbar">
					<button type="button" onclick={goToPreviousImage} disabled={isFirstImage}>← Prev</button>
					<span>{currentImageIndex + 1} / {currentImages.length}</span>
					<button type="button" onclick={goToNextImage} disabled={isLastImage}>Next →</button>
					<button type="button" onclick={closeImageViewer}>Close</button>
				</div>
			</div>
		</div>
	{/if}
</div>
