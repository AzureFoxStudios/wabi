<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { get } from 'svelte/store';
	import { browser } from '$app/environment';
	import ReaderIcon from './ReaderIcon.svelte';
	import ReaderImportSheet from './ReaderImportSheet.svelte';
	import { countWords, formatSourceLabel, renderReaderHtml } from './readerTabHelpers';
	import {
		captureReaderAnchor, restoreReaderAnchor, readerBlocks, prepareReaderDocument,
		highlightReaderSearch, clearReaderSearch, scrollReaderToElement, readerPageMetrics,
		type ReaderAnchor, type ReaderHeading
	} from './readerDocumentTools';
	import {
		readerSelection, readerHistory, readerPreferences, readerProgressByDocument,
		openReaderDocument, openReaderHistoryEntry, openTemporaryReaderFile,
		openReaderImagesFromFiles, clearReaderSelection, updateReaderPreferences, setReaderDocumentProgress,
		type ReaderDocumentFormat, type ReaderPreferences, type ReaderTheme,
		type ReaderFontFamily, type ReaderContentWidth, type ImageFitMode, type ReadingDirection
	} from '$lib/readerWorkspace';
	import {
		readerLibrary, readerStorageNotice, saveReaderAnchor,
		addReaderBookmark, removeReaderBookmark, addReaderNote, removeReaderNote
	} from '$lib/readerLibrary';

	let root = $state<HTMLElement | null>(null);
	let viewport = $state<HTMLDivElement | null>(null);
	let body = $state<HTMLDivElement | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);
	let imageInput = $state<HTMLInputElement | null>(null);
	let searchInput = $state<HTMLInputElement | null>(null);
	let lightbox = $state<HTMLDialogElement | null>(null);
	let lightboxIndex = $state<number | null>(null);
	let systemDark = $state(false);
	let focusMode = $state(false);
	let settingsOpen = $state(false);
	let sidebarOpen = $state(false);
	let sidebarTab = $state<'contents' | 'notes' | 'bookmarks'>('contents');
	let layout = $state<'scroll' | 'paged'>('scroll');
	let importPanelOpen = $state(false);
	let importTitle = $state('');
	let importContent = $state('');
	let importFormat = $state<ReaderDocumentFormat>('markdown');
	let busy = $state(false);
	let error = $state('');
	let outline = $state<ReaderHeading[]>([]);
	let activeHeading = $state('');
	let wordCount = $state(0);
	let contentHasTitle = $state(false);
	let progress = $state(0);
	let currentPage = $state(1);
	let totalPages = $state(1);
	let atStart = $state(true);
	let atEnd = $state(false);
	let lastAnchor = $state<ReaderAnchor>({ block: 0, offset: 0, progress: 0 });
	let noteDraft = $state('');
	let noteAnchor = $state<ReaderAnchor | null>(null);
	let searchOpen = $state(false);
	let query = $state('');
	let searchGroups = $state.raw<HTMLElement[][]>([]);
	let searchIndex = $state(0);
	let blocks: HTMLElement[] = [];
	let activeDocumentKey = '';
	let restoring = false;
	let scrollFrame = 0;
	let saveTimer: ReturnType<typeof setTimeout> | undefined;

	const isImageMode = $derived($readerSelection?.contentType === 'images');
	const images = $derived($readerSelection?.images || []);
	const horizontal = $derived(isImageMode ? $readerPreferences.readingDirection === 'horizontal' : layout === 'paged');
	const html = $derived($readerSelection && !isImageMode ? renderReaderHtml($readerSelection.content, $readerSelection.format) : '');
	const theme = $derived($readerPreferences.theme === 'auto' ? (systemDark ? 'night' : 'paper') : $readerPreferences.theme);
	const record = $derived($readerSelection ? $readerLibrary[$readerSelection.docKey] : undefined);
	const bookmarks = $derived(record?.bookmarks || []);
	const notes = $derived(record?.notes || []);
	const currentBookmark = $derived(bookmarks.find((mark) => mark.anchor.block === lastAnchor.block && Math.abs(mark.anchor.offset - lastAnchor.offset) < 0.05));
	const minutes = $derived(Math.max(1, Math.ceil(wordCount / 220)));
	const displayTitle = $derived(($readerSelection?.title || '').replace(/\.(txt|text|md|markdown|html|htm)$/i, '').replace(/_/g, ' '));

	$effect(() => {
		if (!browser) return;
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		systemDark = media.matches;
		const update = (event: MediaQueryListEvent) => { systemDark = event.matches; };
		media.addEventListener('change', update);
		try { layout = localStorage.getItem('wabi:reader:layout:v1') === 'paged' ? 'paged' : 'scroll'; } catch { /* optional preference */ }
		return () => media.removeEventListener('change', update);
	});

	$effect(() => {
		if (root) untrack(() => { sidebarOpen = (root?.clientWidth || 0) >= 980; });
	});

	$effect(() => {
		const selection = $readerSelection;
		const view = viewport;
		const content = body;
		html;
		if (!selection || !view || (selection.contentType !== 'images' && !content)) return;
		return untrack(() => {
			let cancelled = false;
			clearTimeout(saveTimer);
			activeDocumentKey = selection.docKey;
			restoring = true;
			noteDraft = '';
			noteAnchor = null;
			query = '';
			searchGroups = [];
			lightboxIndex = null;
			const saved = get(readerLibrary)[selection.docKey]?.anchor || {
				block: -1, offset: 0, progress: get(readerProgressByDocument)[selection.docKey] || 0
			};
			lastAnchor = saved;
			void tick().then(async () => {
				if (cancelled) return;
				wordCount = content ? countWords(content.textContent || '') : 0;
				outline = content ? prepareReaderDocument(content) : [];
				blocks = content ? readerBlocks(content) : Array.from(view.querySelectorAll<HTMLElement>('.reader-image-page'));
				contentHasTitle = !!content?.querySelector('h1');
				await tick();
				if (cancelled) return;
				restoreReaderAnchor(view, blocks, saved, horizontal);
				updateMetrics();
				requestAnimationFrame(() => { if (!cancelled) { restoring = false; rememberPosition(); } });
			});
			return () => {
				cancelled = true;
				clearTimeout(saveTimer);
				if (activeDocumentKey === selection.docKey) persistPosition();
			};
		});
	});

	// Resizing a dock, revealing tools, or entering focus mode must not lose the passage.
	$effect(() => {
		const view = viewport;
		if (!view) return;
		let width = view.clientWidth;
		let height = view.clientHeight;
		let frame = 0;
		const observer = new ResizeObserver(() => {
			if (width === view.clientWidth && height === view.clientHeight) return;
			width = view.clientWidth;
			height = view.clientHeight;
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				if (!restoring) restoreReaderAnchor(view, blocks, lastAnchor, horizontal);
				updateMetrics();
			});
		});
		observer.observe(view);
		return () => { observer.disconnect(); cancelAnimationFrame(frame); };
	});

	$effect(() => {
		const content = body;
		const needle = searchOpen ? query : '';
		html;
		if (!content) return;
		const timer = setTimeout(() => {
			searchGroups = highlightReaderSearch(content, needle);
			searchIndex = 0;
			if (searchGroups.length) showSearchMatch(0);
		}, 160);
		return () => { clearTimeout(timer); clearReaderSearch(content); };
	});

	$effect(() => {
		if (lightboxIndex !== null && lightbox && !lightbox.open) lightbox.showModal();
	});

	onDestroy(() => {
		clearTimeout(saveTimer);
		if (browser) cancelAnimationFrame(scrollFrame);
		persistPosition();
	});

	function updateMetrics(): void {
		if (!viewport) return;
		const size = horizontal ? viewport.clientWidth : viewport.clientHeight;
		const extent = horizontal ? viewport.scrollWidth : viewport.scrollHeight;
		const position = horizontal ? viewport.scrollLeft : viewport.scrollTop;
		const max = Math.max(0, extent - size);
		progress = max > 0 ? Math.round(Math.max(0, Math.min(1, position / max)) * 100) : 0;
		atStart = position <= 2;
		atEnd = position >= max - 2;
		if (horizontal) {
			const pages = readerPageMetrics(position, extent, size);
			currentPage = pages.current;
			totalPages = isImageMode ? images.length : pages.total;
		} else if (isImageMode) {
			const view = viewport.getBoundingClientRect();
			const index = blocks.findIndex((block) => block.getBoundingClientRect().bottom > view.top + size / 2);
			currentPage = index < 0 ? Math.max(1, images.length) : index + 1;
			totalPages = images.length;
		}
	}

	function currentAnchor(): ReaderAnchor {
		return viewport ? captureReaderAnchor(viewport, blocks, horizontal) : lastAnchor;
	}

	function rememberPosition(): void {
		if (restoring || !viewport || !activeDocumentKey) return;
		lastAnchor = currentAnchor();
		const currentBlock = blocks[lastAnchor.block];
		if (currentBlock && body) {
			let found = '';
			for (const heading of outline) {
				const el = findHeading(heading.id);
				if (el && (el === currentBlock || !!(el.compareDocumentPosition(currentBlock) & Node.DOCUMENT_POSITION_FOLLOWING))) found = heading.id;
			}
			activeHeading = found;
		}
		persistPosition();
	}

	function persistPosition(): void {
		if (!activeDocumentKey) return;
		saveReaderAnchor(activeDocumentKey, { ...lastAnchor });
		setReaderDocumentProgress(activeDocumentKey, lastAnchor.progress);
	}

	function handleScroll(): void {
		if (!scrollFrame) scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; updateMetrics(); });
		clearTimeout(saveTimer);
		saveTimer = setTimeout(rememberPosition, 250);
	}

	async function changePreferences(next: Partial<ReaderPreferences>): Promise<void> {
		const anchor = currentAnchor();
		lastAnchor = anchor;
		updateReaderPreferences(next);
		await tick();
		if (viewport) restoreReaderAnchor(viewport, blocks, anchor, horizontal);
		updateMetrics();
	}

	async function toggleLayout(): Promise<void> {
		const anchor = currentAnchor();
		lastAnchor = anchor;
		layout = layout === 'scroll' ? 'paged' : 'scroll';
		try { localStorage.setItem('wabi:reader:layout:v1', layout); } catch { /* optional preference */ }
		await tick();
		if (viewport) restoreReaderAnchor(viewport, blocks, anchor, horizontal);
		updateMetrics();
	}

	function movePage(direction: number): void {
		if (!viewport) return;
		if (horizontal) viewport.scrollTo({ left: Math.max(0, (currentPage - 1 + direction) * viewport.clientWidth) });
		else if (isImageMode) {
			const target = blocks[Math.max(0, Math.min(blocks.length - 1, currentPage - 1 + direction))];
			if (target) scrollReaderToElement(viewport, target, false);
		} else viewport.scrollBy({ top: direction * viewport.clientHeight * 0.85 });
	}

	function seek(value: number): void {
		if (!viewport) return;
		const ratio = Math.max(0, Math.min(1, value / 100));
		if (horizontal) {
			viewport.scrollTo({ left: Math.round(ratio * Math.max(0, totalPages - 1)) * viewport.clientWidth });
		} else viewport.scrollTo({ top: ratio * (viewport.scrollHeight - viewport.clientHeight) });
		updateMetrics();
		rememberPosition();
	}

	function jump(anchor: ReaderAnchor): void {
		if (!viewport) return;
		restoreReaderAnchor(viewport, blocks, anchor, horizontal);
		updateMetrics();
		rememberPosition();
		if ((root?.clientWidth || 0) < 980) sidebarOpen = false;
		viewport.focus({ preventScroll: true });
	}

	function findHeading(id: string): HTMLElement | undefined {
		return Array.from(body?.querySelectorAll<HTMLElement>('[id]') || []).find((el) => el.id === id);
	}

	function goToHeading(id: string): void {
		const el = findHeading(id);
		if (!el || !viewport) return;
		scrollReaderToElement(viewport, el, horizontal);
		activeHeading = id;
		if ((root?.clientWidth || 0) < 980) sidebarOpen = false;
		viewport.focus({ preventScroll: true });
	}

	function toggleBookmark(): void {
		if (!$readerSelection) return;
		const anchor = currentAnchor();
		lastAnchor = anchor;
		const existing = bookmarks.find((mark) => mark.anchor.block === anchor.block && Math.abs(mark.anchor.offset - anchor.offset) < 0.05);
		if (existing) removeReaderBookmark($readerSelection.docKey, existing.id);
		else {
			const label = isImageMode ? `Image ${currentPage}` : (blocks[anchor.block]?.textContent?.trim().slice(0, 100) || displayTitle);
			addReaderBookmark($readerSelection.docKey, label, anchor);
		}
	}

	function saveNote(): void {
		if (!$readerSelection || !noteDraft.trim()) return;
		addReaderNote($readerSelection.docKey, noteDraft, noteAnchor || currentAnchor());
		noteDraft = '';
		noteAnchor = null;
	}

	async function openSearch(): Promise<void> {
		searchOpen = true;
		settingsOpen = false;
		await tick();
		searchInput?.focus();
		searchInput?.select();
	}

	function showSearchMatch(index: number): void {
		if (!searchGroups.length || !viewport) return;
		searchGroups[searchIndex]?.forEach((mark) => mark.classList.remove('reader-search-current'));
		searchIndex = (index + searchGroups.length) % searchGroups.length;
		const group = searchGroups[searchIndex];
		group.forEach((mark) => mark.classList.add('reader-search-current'));
		if (group[0]) scrollReaderToElement(viewport, group[0], horizontal);
	}

	function returnHome(): void {
		rememberPosition();
		clearReaderSelection();
		searchOpen = false;
		settingsOpen = false;
		focusMode = false;
	}

	function openPaste(format: ReaderDocumentFormat = 'text'): void {
		importFormat = format;
		importPanelOpen = true;
	}

	function closeImport(): void {
		importPanelOpen = false;
		importTitle = '';
		importContent = '';
	}

	function submitImport(): void {
		if (!importContent.trim()) return;
		rememberPosition();
		openReaderDocument(importTitle.trim() || 'Pasted document', importContent, importFormat, 'pasted');
		closeImport();
	}

	async function handleFileChange(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		error = '';
		if (file.size > 20 * 1024 * 1024) { error = 'This text file is larger than 20 MB. Open a chapter or smaller document instead.'; return; }
		busy = true;
		try { rememberPosition(); await openTemporaryReaderFile(file); }
		catch { error = 'The file could not be read. Try opening it again.'; }
		finally { busy = false; }
	}

	async function handleImages(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		if (!input.files?.length) return;
		busy = true;
		error = '';
		try {
			rememberPosition();
			// Keep the FileList alive until the importer has consumed it.
			await openReaderImagesFromFiles(input.files.length === 1 ? input.files[0].name : 'Image collection', input.files);
		} catch { error = 'These images could not be opened. Please try again.'; }
		finally { input.value = ''; busy = false; }
	}

	async function handleArticleClick(event: MouseEvent): Promise<void> {
		if (!(event.target instanceof Element)) return;
		const copy = event.target.closest<HTMLButtonElement>('.reader-code-copy');
		if (copy) {
			const pre = copy.closest('pre');
			const text = pre?.querySelector('code')?.textContent || '';
			try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied'; }
			catch { copy.textContent = 'Copy failed'; }
			setTimeout(() => { if (copy.isConnected) copy.textContent = 'Copy'; }, 1500);
			return;
		}
		const link = event.target.closest<HTMLAnchorElement>('a[href^="#"]');
		if (link) {
			event.preventDefault();
			try { goToHeading(decodeURIComponent(link.hash.slice(1))); } catch { /* malformed source link */ }
		}
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || !root?.getClientRects().length || importPanelOpen || lightboxIndex !== null) return;
		const target = event.target instanceof HTMLElement ? event.target : null;
		if (target && !root.contains(target) && target !== document.body) return;
		if (event.key === 'Escape') {
			if (settingsOpen) settingsOpen = false;
			else if (searchOpen) { searchOpen = false; viewport?.focus(); }
			else if (focusMode) focusMode = false;
			else if (sidebarOpen && (root.clientWidth < 980)) sidebarOpen = false;
			return;
		}
		if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f' && !isImageMode && $readerSelection) {
			event.preventDefault(); void openSearch(); return;
		}
		if (event.ctrlKey || event.metaKey || event.altKey || target?.closest('input,textarea,select,[contenteditable="true"]')) return;
		if (event.key.toLowerCase() === 'f' && $readerSelection) { focusMode = !focusMode; settingsOpen = false; return; }
		if (target?.closest('button,a')) return;
		if (event.key === 'PageDown' || event.key === 'PageUp' || (horizontal && ['ArrowLeft', 'ArrowRight', ' '].includes(event.key))) {
			event.preventDefault(); movePage(event.key === 'PageUp' || event.key === 'ArrowLeft' || event.shiftKey ? -1 : 1);
		} else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); seek(event.key === 'Home' ? 0 : 100); }
	}
</script>

<svelte:window onkeydown={handleKeydown} onpagehide={persistPosition} />

<section bind:this={root} class="reader-shell reader-redesign" class:reader-focused={focusMode} class:sidebar-open={sidebarOpen}
	data-reader-theme={theme} aria-label="Reader"
	style={`--reader-font-size:${$readerPreferences.fontSize}px;--reader-line-height:${$readerPreferences.lineHeight};--reader-measure:${$readerPreferences.contentWidth === 'narrow' ? '54ch' : $readerPreferences.contentWidth === 'wide' ? '78ch' : '66ch'};`}
	class:reader-sans={$readerPreferences.fontFamily === 'sans'}>
	<header class="reader-toolbar">
		<div class="reader-breadcrumb">
			<button type="button" class="reader-home-button" onclick={returnHome} title="Reader home"><ReaderIcon name="book" /><span>Reader</span></button>
			{#if $readerSelection}<span class="reader-breadcrumb-slash" aria-hidden="true">/</span><span class="reader-filename" title={$readerSelection.title}>{$readerSelection.title}</span>{/if}
		</div>
		<div class="reader-toolbar-actions">
			{#if $readerSelection}
				{#if !isImageMode}<button type="button" class="reader-search-trigger" onclick={openSearch} aria-label="Search in document" title="Search in document (Ctrl/Cmd+F)"><ReaderIcon name="search" /><span>Search in document…</span></button>{/if}
				<button type="button" class="reader-tool" aria-label="Reading settings" title="Reading settings" aria-expanded={settingsOpen} onclick={() => { settingsOpen = !settingsOpen; }}><span class="reader-type-icon">Aa</span></button>
				<button type="button" class="reader-tool" aria-label="Cycle reader theme" title="Cycle paper, sepia and night themes" onclick={() => { const themes: ReaderTheme[] = ['paper', 'sepia', 'night']; void changePreferences({ theme: themes[(themes.indexOf(theme) + 1) % themes.length] }); }}><ReaderIcon name="theme" /></button>
				{#if !isImageMode}<button type="button" class="reader-tool" aria-label={layout === 'scroll' ? 'Switch to paged reading' : 'Switch to continuous scrolling'} title={layout === 'scroll' ? 'Paged reading' : 'Continuous scrolling'} onclick={toggleLayout}><ReaderIcon name={layout === 'scroll' ? 'pages' : 'scroll'} /></button>{/if}
				<button type="button" class="reader-tool" class:active={!!currentBookmark} aria-pressed={!!currentBookmark} aria-label={currentBookmark ? 'Remove bookmark at this place' : 'Bookmark this place'} title="Bookmark this place" onclick={toggleBookmark}><ReaderIcon name="bookmark" /></button>
				<button type="button" class="reader-tool" aria-label={focusMode ? 'Exit focus mode' : 'Enter focus mode'} title="Focus mode (F)" aria-pressed={focusMode} onclick={() => { lastAnchor = currentAnchor(); focusMode = !focusMode; }}><ReaderIcon name="focus" /></button>
				<button type="button" class="reader-tool" aria-label="Toggle document sidebar" title="Contents, notes and bookmarks" aria-expanded={sidebarOpen} onclick={() => { lastAnchor = currentAnchor(); sidebarOpen = !sidebarOpen; }}><ReaderIcon name="contents" /></button>
			{/if}
			<button type="button" class="reader-open-button" onclick={() => fileInput?.click()} disabled={busy}><ReaderIcon name="file" /><span>Open</span></button>
		</div>
	</header>

	{#if focusMode}<button type="button" class="reader-exit-focus" onclick={() => { focusMode = false; }}><ReaderIcon name="close" size={15} />Exit focus<span>Esc</span></button>{/if}

	{#if settingsOpen && $readerSelection}
		<section class="reader-settings-panel" aria-label="Reading settings">
			<div class="reader-panel-heading"><h2>Reading settings</h2><button class="reader-tool" type="button" aria-label="Close reading settings" onclick={() => { settingsOpen = false; }}><ReaderIcon name="close" /></button></div>
			<label class="reader-field">Theme<select value={$readerPreferences.theme} onchange={(e) => changePreferences({ theme: e.currentTarget.value as ReaderTheme })}><option value="paper">Paper</option><option value="sepia">Sepia</option><option value="night">Night</option><option value="auto">Follow system</option></select></label>
			{#if isImageMode}
				<label class="reader-field">Image size<select value={$readerPreferences.imageFit} onchange={(e) => changePreferences({ imageFit: e.currentTarget.value as ImageFitMode })}><option value="width">Fit width</option><option value="height">Fit height</option><option value="original">Original size</option></select></label>
				<label class="reader-field">Reading direction<select value={$readerPreferences.readingDirection} onchange={(e) => changePreferences({ readingDirection: e.currentTarget.value as ReadingDirection })}><option value="horizontal">Horizontal pages</option><option value="ltr">Vertical · left to right</option><option value="rtl">Vertical · right to left</option></select></label>
			{:else}
				<label class="reader-field">Typeface<select value={$readerPreferences.fontFamily} onchange={(e) => changePreferences({ fontFamily: e.currentTarget.value as ReaderFontFamily })}><option value="serif">Literary serif</option><option value="sans">Clean sans serif</option></select></label>
				<label class="reader-field">Text size <span>{$readerPreferences.fontSize}px</span><input aria-label="Text size" type="range" min="14" max="28" step="1" value={$readerPreferences.fontSize} oninput={(e) => changePreferences({ fontSize: Number(e.currentTarget.value) })} /></label>
				<label class="reader-field">Line spacing <span>{$readerPreferences.lineHeight.toFixed(2)}</span><input aria-label="Line spacing" type="range" min="1.35" max="2.3" step="0.05" value={$readerPreferences.lineHeight} oninput={(e) => changePreferences({ lineHeight: Number(e.currentTarget.value) })} /></label>
				<label class="reader-field">Reading width<select value={$readerPreferences.contentWidth} onchange={(e) => changePreferences({ contentWidth: e.currentTarget.value as ReaderContentWidth })}><option value="narrow">Narrow</option><option value="medium">Comfortable</option><option value="wide">Wide</option></select></label>
				<p class="reader-panel-hint">F · focus mode<br />Ctrl/Cmd + F · find in document<br />Page Up / Page Down · move through text</p>
			{/if}
		</section>
	{/if}

	{#if searchOpen && $readerSelection && !isImageMode}
		<div class="reader-search-bar" role="search" aria-label="Find in document">
			<ReaderIcon name="search" /><input bind:this={searchInput} bind:value={query} aria-label="Find text" placeholder="Find in this document…" onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); showSearchMatch(searchIndex + (e.shiftKey ? -1 : 1)); } }} />
			<span class="reader-search-count" role="status">{query.trim() ? (searchGroups.length ? `${searchIndex + 1} / ${searchGroups.length}${searchGroups.length === 1000 ? ' (limit)' : ''}` : 'No matches') : ''}</span>
			<button type="button" class="reader-tool" disabled={!searchGroups.length} aria-label="Previous match" onclick={() => showSearchMatch(searchIndex - 1)}><ReaderIcon name="left" /></button><button type="button" class="reader-tool" disabled={!searchGroups.length} aria-label="Next match" onclick={() => showSearchMatch(searchIndex + 1)}><ReaderIcon name="right" /></button><button type="button" class="reader-tool" aria-label="Close search" onclick={() => { searchOpen = false; viewport?.focus(); }}><ReaderIcon name="close" /></button>
		</div>
	{/if}

	{#if error || $readerStorageNotice}<div class="reader-notice" role="status">{error || $readerStorageNotice}{#if error}<button type="button" class="reader-tool" aria-label="Dismiss error" onclick={() => { error = ''; }}><ReaderIcon name="close" /></button>{/if}</div>{/if}

	{#if $readerSelection}
		<div class="reader-workspace">
			<!-- svelte-ignore a11y_no_noninteractive_tabindex (The scrollable reading region must be keyboard-focusable.) -->
			<div bind:this={viewport} class="reader-viewport" class:reader-paged={!isImageMode && layout === 'paged'} class:reader-images={isImageMode} class:reader-horizontal={isImageMode && horizontal} tabindex="0" role="region" aria-label={$readerSelection.title} onscroll={handleScroll}>
				{#if isImageMode}
					<div class="reader-gallery" data-fit={$readerPreferences.imageFit} dir={$readerPreferences.readingDirection === 'rtl' ? 'rtl' : 'ltr'}>
						{#each images as image, index (`${index}:${image.url}`)}
							<figure class="reader-image-page"><button class="reader-image-open" type="button" aria-label={`Open image ${index + 1}: ${image.alt || 'Image'}`} onclick={() => { lightboxIndex = index; }}><img src={image.url} alt={image.alt || `Image ${index + 1}`} width={image.width} height={image.height} decoding="async" onload={() => { if (viewport && !restoring) restoreReaderAnchor(viewport, blocks, lastAnchor, horizontal); updateMetrics(); }} /></button><figcaption>{index + 1} / {images.length}<span>{image.alt}</span></figcaption></figure>
						{/each}
					</div>
				{:else}
					<div class="reader-paper">
						<article class="reader-prose">
							<header class="reader-document-header">
								{#if !contentHasTitle}<h1>{displayTitle}</h1>{/if}
								<div class="reader-document-meta"><span>{wordCount.toLocaleString()} words</span><span>~{minutes} min read</span><span>{formatSourceLabel($readerSelection.source)}</span></div>
							</header>
							<!-- The delegated handler only enhances real links and real copy buttons. -->
							<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events (Delegated clicks originate from native links and buttons, which already support keyboard activation.) -->
							<div class="reader-document-body" bind:this={body} onclick={handleArticleClick}>{@html html}</div>
						</article>
					</div>
				{/if}
			</div>

			{#if sidebarOpen && !focusMode}
				<aside class="reader-sidebar" aria-label="Document tools">
					<div class="reader-sidebar-tabs" role="group" aria-label="Choose document tool">
						{#each ['contents', 'notes', 'bookmarks'] as tab}<button type="button" class:active={sidebarTab === tab} aria-pressed={sidebarTab === tab} onclick={() => { sidebarTab = tab as typeof sidebarTab; }}><ReaderIcon name={tab} size={16} /><span>{tab === 'contents' ? 'Contents' : tab === 'notes' ? 'Notes' : 'Bookmarks'}</span></button>{/each}
						<button type="button" class="reader-sidebar-close" aria-label="Close document sidebar" onclick={() => { sidebarOpen = false; }}><ReaderIcon name="close" size={16} /></button>
					</div>
					<div class="reader-sidebar-content">
						{#if sidebarTab === 'contents'}
							{#if isImageMode}
								<h2 class="reader-section-label">Images</h2>{#each images as image, index}<button class="reader-outline-item" class:active={currentPage === index + 1} type="button" onclick={() => { const target = blocks[index]; if (target && viewport) scrollReaderToElement(viewport, target, horizontal); }}><span>{index + 1}.</span>{image.alt || `Image ${index + 1}`}</button>{/each}
							{:else if outline.length}
								<nav aria-label="Table of contents">{#each outline as heading}<button type="button" class="reader-outline-item" class:active={activeHeading === heading.id} style:--outline-indent={`${Math.min(3, heading.level - 1) * 12}px`} onclick={() => goToHeading(heading.id)}>{heading.label}</button>{/each}</nav>
							{:else}<h2 class="reader-section-label">Contents</h2><p class="reader-panel-hint">This document has no headings. Use search or save a bookmark to find your place.</p><button class="reader-secondary-button" type="button" onclick={() => seek(0)}>Back to the beginning</button>{/if}
						{:else if sidebarTab === 'bookmarks'}
							<button type="button" class="reader-secondary-button" onclick={toggleBookmark}><ReaderIcon name="bookmark" size={16} />{currentBookmark ? 'Remove this bookmark' : 'Bookmark this place'}</button>
							{#if !bookmarks.length}<p class="reader-panel-hint">Keep a passage within reach. Bookmarks are saved on this device.</p>{/if}
							{#each bookmarks as mark (mark.id)}<div class="reader-saved-item"><button type="button" class="reader-saved-link" onclick={() => jump(mark.anchor)}><span>{mark.label}</span><small>{Math.round(mark.anchor.progress * 100)}% into document</small></button><button type="button" class="reader-tool" aria-label={`Remove bookmark: ${mark.label}`} onclick={() => { if ($readerSelection) removeReaderBookmark($readerSelection.docKey, mark.id); }}><ReaderIcon name="trash" size={15} /></button></div>{/each}
						{:else}
							<label class="reader-field">Note for this passage<textarea bind:value={noteDraft} maxlength="10000" rows="5" placeholder="Write a note…" onfocus={() => { if (!noteAnchor) noteAnchor = currentAnchor(); }}></textarea></label><button type="button" class="reader-secondary-button" disabled={!noteDraft.trim()} onclick={saveNote}>Save note</button><p class="reader-panel-hint">Notes stay on this device and link back to the passage.</p>
							{#each notes as note (note.id)}<div class="reader-saved-item"><button type="button" class="reader-saved-link" onclick={() => jump(note.anchor)}><span class="reader-note-text">{note.text}</span><small>Return to passage · {Math.round(note.anchor.progress * 100)}%</small></button><button type="button" class="reader-tool" aria-label="Delete note" onclick={() => { if ($readerSelection) removeReaderNote($readerSelection.docKey, note.id); }}><ReaderIcon name="trash" size={15} /></button></div>{/each}
						{/if}
					</div>
				</aside>
			{/if}
		</div>
		<footer class="reader-footer">
			<div class="reader-pagination"><button type="button" class="reader-tool" aria-label="Previous page" disabled={atStart} onclick={() => movePage(-1)}><ReaderIcon name="left" size={16} /></button><span>{isImageMode ? `Image ${currentPage} of ${totalPages}` : layout === 'paged' ? `Page ${currentPage} of ${totalPages}` : 'Continuous scroll'}</span><button type="button" class="reader-tool" aria-label="Next page" disabled={atEnd} onclick={() => movePage(1)}><ReaderIcon name="right" size={16} /></button></div>
			<div class="reader-position"><input type="range" min="0" max="100" value={progress} aria-label="Reading position" aria-valuetext={`${progress}% through document`} oninput={(e) => seek(Number(e.currentTarget.value))} /><span>{progress}%</span></div>
			<span class="reader-footer-hint">{atEnd ? 'End of document' : isImageMode ? '' : `~${Math.max(1, Math.ceil(minutes * (1 - progress / 100)))} min left`}</span>
		</footer>
	{:else}
		<div class="reader-home">
			<div class="reader-home-intro"><span class="reader-eyebrow">YOUR READING SPACE</span><h1>Open something<br />worth keeping.</h1><p>Books, essays, notes, and long-form text.<br />A comfortable place to pick up where you left off.</p></div>
			<div class="reader-home-actions">
				<button type="button" class="reader-import-option reader-import-primary" onclick={() => fileInput?.click()} disabled={busy}><ReaderIcon name="file" size={28} /><span><strong>{busy ? 'Opening…' : 'Open file'}</strong><small>TXT, Markdown, HTML</small></span></button>
				<button type="button" class="reader-import-option" onclick={() => openPaste('text')}><ReaderIcon name="paste" size={28} /><span><strong>Paste text</strong><small>Plain text, Markdown, or HTML</small></span></button>
				<button type="button" class="reader-import-option" onclick={() => imageInput?.click()} disabled={busy}><ReaderIcon name="image" size={28} /><span><strong>Open images</strong><small>Read a collection of image pages</small></span></button>
			</div>
			<div class="reader-home-bottom">
				<section class="reader-recent-card"><div class="reader-panel-heading"><h2><ReaderIcon name="clock" />Recent reads</h2><span>This session</span></div>
					{#if $readerHistory.length}{#each $readerHistory as entry (entry.id)}<button type="button" class="reader-recent-item" onclick={() => openReaderHistoryEntry(entry.id)}><ReaderIcon name={entry.contentType === 'images' ? 'image' : 'file'} size={22} /><span><strong>{entry.title}</strong><small>{entry.contentType === 'images' ? `${entry.images?.length || 0} images` : `${countWords(entry.content).toLocaleString()} words`} · {Math.round(($readerProgressByDocument[entry.docKey] || 0) * 100)}% read</small></span><ReaderIcon name="right" size={16} /></button>{/each}
					{:else}<p class="reader-panel-hint">Your open documents will appear here. Start with a file or paste something to read.</p>{/if}
				</section>
				<section class="reader-home-detail"><ReaderIcon name="bookmark" size={24} /><h2>Your place is kept.</h2><p>Reading position, bookmarks, and notes are saved on this device. Reopen the same document to continue.</p><p class="reader-panel-hint">Local files are not uploaded. Documents remain available in Recent reads for this session.</p></section>
			</div>
		</div>
	{/if}

	<input bind:this={fileInput} class="reader-hidden-input" type="file" accept=".txt,.text,.md,.markdown,.html,.htm" onchange={handleFileChange} />
	<input bind:this={imageInput} class="reader-hidden-input" type="file" accept=".jpg,.jpeg,.png,.gif,.webp,.bmp" multiple onchange={handleImages} />
	{#if importPanelOpen}<ReaderImportSheet bind:importTitle bind:importContent bind:importFormat onClose={closeImport} onSubmit={submitImport} />{/if}
	{#if lightboxIndex !== null && images[lightboxIndex]}
		<dialog bind:this={lightbox} class="reader-lightbox" aria-label="Image viewer" oncancel={() => { lightboxIndex = null; }} onclick={(e) => { if (e.target === lightbox) lightboxIndex = null; }}>
			<div class="reader-lightbox-image"><img src={images[lightboxIndex].url} alt={images[lightboxIndex].alt} /></div>
			<div class="reader-lightbox-toolbar"><button type="button" class="reader-secondary-button" disabled={lightboxIndex === 0} onclick={() => { lightboxIndex = Math.max(0, (lightboxIndex || 0) - 1); }}>Previous</button><span>{lightboxIndex + 1} / {images.length}</span><button type="button" class="reader-secondary-button" disabled={lightboxIndex === images.length - 1} onclick={() => { lightboxIndex = Math.min(images.length - 1, (lightboxIndex || 0) + 1); }}>Next</button><button type="button" class="reader-secondary-button" onclick={() => { lightboxIndex = null; }}>Close</button></div>
		</dialog>
	{/if}
</section>
