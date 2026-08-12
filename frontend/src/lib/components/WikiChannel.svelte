<script lang="ts">
	import { onDestroy } from 'svelte';
	import { currentChannel } from '$lib/socket';
	import {
		wikiPagesStore,
		wikiRevisionsStore,
		wikiLoadingStore,
		wikiErrorStore,
		loadWiki,
		loadRevisions,
		createWikiPage,
		updateWikiPage,
		findWikiAuthor,
		formatWikiTime,
		type WikiPage,
		type WikiRevision,
	} from '$lib/wikiStore';
	import SurfaceToolbar from './SurfaceToolbar.svelte';
	import { uploadFileResumable } from './chat/uploadResumable';
	import WikiPageTree from './WikiPageTree.svelte';
	import WikiRevisionDrawer from './WikiRevisionDrawer.svelte';
	import { initObjectRefRegistry, registerObjectRef, slugify } from '$lib/objectRefRegistry';
	import { parseMessage } from '$lib/markdown';
	import ObjectShareMenu from './ObjectShareMenu.svelte';
	import { peekPendingNav, takePendingNav } from '$lib/pendingNav';
	import {
		extractWikiHeadings,
		formatWikiCitationMarkdown,
		getWikiBreadcrumbs,
		getWikiCitation,
		insertWikiMarkdown,
	} from '$lib/wikiHelpers';

	$: allPages = $wikiPagesStore;
	$: allRevisions = $wikiRevisionsStore;
	$: isLoading = $wikiLoadingStore;
	$: error = $wikiErrorStore;

	let selectedPageId: string | null = null;
	let showHistory = false;
	let editMode = false;
	let viewRevision: WikiRevision | null = null;
	let editTitle = '';
	let editBody = '';
	let showNewPage = false;
	let newPageTitle = '';
	let newPageBody = '';
	let newPageParentId: string | null = null;
	let wikiSearchQuery = '';
	let loadedChannelId: string | null = null;
	let copyError = '';
	let editPreview = false;
	let editBodyElement: HTMLTextAreaElement | null = null;
	let editSavedTitle = '';
	let editSavedBody = '';
	let imageInput: HTMLInputElement | null = null;
	let imageUploading = false;
	let saveState: 'idle' | 'dirty' | 'saving' | 'saved' | 'failed' = 'idle';
	let showTreeOnMobile = true;

	initObjectRefRegistry();

	$: if (allPages.length > 0 && $currentChannel) {
		for (const page of allPages) {
			registerObjectRef({
				kind: 'wiki_page',
				id: page.pageId,
				slug: page.slug || slugify(page.title),
				title: page.title,
				channelId: $currentChannel,
				subtitle: findWikiAuthor(page.authorUserId)?.username || undefined,
				updatedAt: page.updatedAtMicros > 1e12 ? Math.floor(page.updatedAtMicros / 1000) : page.updatedAtMicros,
			});
		}
	}

	$: selectedPage = allPages.find((p) => p.pageId === selectedPageId) || null;
	$: breadcrumbs = selectedPage ? getWikiBreadcrumbs(allPages, selectedPage.pageId) : [];
	$: headings = extractWikiHeadings(displayBody);

	$: if (selectedPage && $currentChannel) {
		loadRevisions($currentChannel, selectedPage.pageId);
		showHistory = false;
		editMode = false;
		viewRevision = null;
	}

	$: if ($currentChannel && $currentChannel !== loadedChannelId) {
		loadedChannelId = $currentChannel;
		loadWiki($currentChannel);
	}

	$: if (!$currentChannel) {
		loadedChannelId = null;
		wikiSearchQuery = '';
	}

	// C2: deep-link handoff after pages load — peek first, take only on hit
	$: if ($currentChannel && allPages.length > 0) {
		const pending = peekPendingNav();
		if (
			pending?.kind === 'wiki_page' &&
			(!pending.channelId || pending.channelId === $currentChannel)
		) {
			const hit = allPages.find((p) => p.pageId === pending.pageId);
			if (hit) {
				takePendingNav('wiki_page', $currentChannel);
				selectPage(hit);
			}
		}
	}

	$: revisionsForDrawer = showHistory ? allRevisions : [];

	$: displayTitle = viewRevision ? viewRevision.title : (selectedPage?.title || '');
	$: displayBody = viewRevision ? viewRevision.body : (selectedPage?.body || '');
	$: displayAuthor = selectedPage ? findWikiAuthor(selectedPage.authorUserId) : undefined;
	$: displayTime = selectedPage ? formatWikiTime(selectedPage.updatedAtMicros) : '';
	$: displayRevisionCount = allRevisions.length;

	function selectPage(page: WikiPage) {
		if (editIsDirty && !window.confirm('Discard unsaved wiki changes?')) return;
		selectedPageId = page.pageId;
		showTreeOnMobile = false;
		editMode = false;
		showHistory = false;
		viewRevision = null;
	}

	function handleEdit() {
		if (!selectedPage) return;
		editTitle = selectedPage.title;
		editBody = selectedPage.body;
		editSavedTitle = editTitle;
		editSavedBody = editBody;
		editPreview = false;
		editMode = true;
		viewRevision = null;
		showHistory = false;
	}

	function handleCancelEdit() {
		if (editIsDirty && !window.confirm('Discard unsaved wiki changes?')) return;
		editMode = false;
		editPreview = false;
		saveState = 'idle';
	}

	function insertEditMarkdown(insertion: string) {
		if (!editBodyElement) return;
		const next = insertWikiMarkdown(editBody, editBodyElement.selectionStart, editBodyElement.selectionEnd, insertion);
		editBody = next.value;
		requestAnimationFrame(() => {
			editBodyElement?.focus();
			editBodyElement?.setSelectionRange(next.selectionStart, next.selectionEnd);
		});
	}

	async function handleSaveEdit() {
		if (!$currentChannel || !selectedPage) return;
		if (!editTitle.trim()) {
			saveState = 'failed';
			return;
		}
		saveState = 'saving';
		const result = await updateWikiPage($currentChannel, selectedPage.pageId, {
			title: editTitle,
			body: editBody,
		});
		if (result) {
			editSavedTitle = editTitle;
			editSavedBody = editBody;
			editMode = false;
			editPreview = false;
			saveState = 'saved';
		} else {
			saveState = 'failed';
		}
	}

	async function handleWikiImage(file: File) {
		if (!$currentChannel || !file.type.startsWith('image/')) return;
		imageUploading = true;
		try {
			const uploaded = await uploadFileResumable(file, $currentChannel, () => {}, false);
			insertEditMarkdown(`![${file.name.replace(/\.[^.]+$/, '')}](${uploaded.fileUrl})`);
		} catch (err) {
			copyError = err instanceof Error ? err.message : 'Image upload failed';
		} finally {
			imageUploading = false;
			if (imageInput) imageInput.value = '';
		}
	}

	function handleHistory() {
		showHistory = !showHistory;
		editMode = false;
	}

	function handleCloseHistory() {
		showHistory = false;
		viewRevision = null;
	}

	function handleSelectRevision(revision: WikiRevision) {
		viewRevision = revision;
	}

	async function handleRestoreRevision(revision: WikiRevision) {
		if (!$currentChannel || !selectedPage) return;
		const result = await updateWikiPage($currentChannel, selectedPage.pageId, {
			title: revision.title,
			body: revision.body,
		});
		if (result) {
			viewRevision = null;
		}
	}

	function handleDismissRevision() {
		viewRevision = null;
	}

	async function copyWikiCitation() {
		if (!selectedPage || !$currentChannel) return;
		const citation = getWikiCitation(window.location.origin, $currentChannel, selectedPage);
		try {
			await navigator.clipboard.writeText(formatWikiCitationMarkdown(citation));
			copyError = '';
		} catch {
			copyError = 'Could not copy citation';
		}
	}

	function handleOpenNewPage() {
		newPageTitle = '';
		newPageBody = '';
		newPageParentId = null;
		showNewPage = true;
	}

	function handleNewChild(parent: WikiPage | null) {
		newPageTitle = '';
		newPageBody = '';
		newPageParentId = parent?.pageId || null;
		showNewPage = true;
	}

	function handleCancelNewPage() {
		showNewPage = false;
	}

	async function handleCreateNewPage() {
		if (!$currentChannel || !newPageTitle.trim()) return;
		const result = await createWikiPage($currentChannel, {
			title: newPageTitle.trim(),
			body: newPageBody,
			parentPageId: newPageParentId || undefined,
		});
		if (result) {
			showNewPage = false;
			selectedPageId = result.pageId;
		}
	}

	$: shareRecord = selectedPage ? {
		kind: 'wiki_page' as const,
		id: selectedPage.pageId,
		slug: selectedPage.slug || slugify(selectedPage.title),
		title: selectedPage.title,
		channelId: $currentChannel || '',
		subtitle: findWikiAuthor(selectedPage.authorUserId)?.username || undefined,
		updatedAt: selectedPage.updatedAtMicros > 1e12 ? Math.floor(selectedPage.updatedAtMicros / 1000) : selectedPage.updatedAtMicros,
	} : null;

	$: renderedBody = displayBody ? parseMessage(displayBody) : '';
	$: editIsDirty = editMode && (editTitle !== editSavedTitle || editBody !== editSavedBody);
	$: if (editMode && editIsDirty && saveState !== 'saving') saveState = 'dirty';
	$: if (editMode && !editIsDirty && saveState === 'dirty') saveState = 'idle';

	onDestroy(() => {
		selectedPageId = null;
	});

	if (typeof window !== 'undefined') {
		const handleBeforeUnload = (event: BeforeUnloadEvent) => {
			if (!editIsDirty) return;
			event.preventDefault();
			event.returnValue = '';
		};
		window.addEventListener('beforeunload', handleBeforeUnload);
		onDestroy(() => window.removeEventListener('beforeunload', handleBeforeUnload));
	}
</script>

<div class="wiki-channel">
	<SurfaceToolbar
		searchPlaceholder="Search wiki..."
		onSearch={(query) => { wikiSearchQuery = query; }}
		primaryLabel="+ New Page"
		onPrimary={handleOpenNewPage}
	/>

	<div class="wiki-body" class:has-drawer={showHistory}>
		<div class:hidden-mobile={!showTreeOnMobile} class="wiki-tree-wrapper">
			<WikiPageTree
				pages={allPages}
			activePageId={selectedPageId}
			onSelect={selectPage}
			onNewChild={handleNewChild}
			searchQuery={wikiSearchQuery}
			/>
			</div>

			<div class="wiki-content-pane">
			{#if isLoading}
				<div class="wiki-loading">
					<div class="wiki-loading-spinner"></div>
					<span>Loading wiki...</span>
				</div>
			{:else if error}
				<div class="wiki-error">
					<span>{error}</span>
					<button on:click={() => $currentChannel && loadWiki($currentChannel)}>Retry</button>
				</div>
			{:else if showNewPage}
				<div class="wiki-edit-area">
					<input
						type="text"
						class="wiki-edit-title"
						placeholder="Page title..."
						bind:value={newPageTitle}
					/>
					<textarea
						class="wiki-edit-body"
						placeholder="Write wiki content in markdown..."
						bind:value={newPageBody}
					></textarea>
					<div class="wiki-edit-footer">
						<button class="wiki-edit-cancel-btn" on:click={handleCancelNewPage}>Cancel</button>
						<button class="wiki-edit-save-btn" on:click={handleCreateNewPage} disabled={!newPageTitle.trim()}>Create</button>
					</div>
				</div>
			{:else if !selectedPage}
				<div class="wiki-empty">
					<div class="wiki-empty-icon">
						<svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5">
							<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
							<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
						</svg>
					</div>
					<h3>Select a page</h3>
					<p>Choose a page from the tree or create a new one.</p>
				</div>
			{:else}
				{#if viewRevision}
					<div class="wiki-revision-banner">
						<span>Viewing revision from {formatWikiTime(viewRevision.createdAtMicros)}</span>
						<button class="wiki-revision-banner-restore" on:click={() => handleRestoreRevision(viewRevision)}>Restore?</button>
						<button class="wiki-revision-banner-close" on:click={handleDismissRevision}>Dismiss</button>
					</div>
				{/if}

				<div class="wiki-content-toolbar">
					<div class="wiki-content-toolbar-breadcrumb">
						<button type="button" class="wiki-content-toolbar-link" on:click={() => { selectedPageId = null; }}>Wiki</button>
						<span>/</span>
						{#each breadcrumbs as crumb, index}
							{#if index > 0}<span>/</span>{/if}
							<span>{crumb.title}</span>
						{/each}
					</div>
					{#if !editMode}
						<button class="wiki-content-toolbar-btn" on:click={handleEdit}>Edit</button>
						<button type="button" class="wiki-content-toolbar-btn wiki-mobile-tree-toggle" on:click={() => { showTreeOnMobile = !showTreeOnMobile; }}>{showTreeOnMobile ? 'Hide pages' : 'Show pages'}</button>
						<button class="wiki-content-toolbar-btn" on:click={() => void copyWikiCitation()}>Copy citation</button>
						{#if copyError}<span class="wiki-copy-error" role="status">{copyError}</span>{/if}
						<button
							class="wiki-content-toolbar-btn"
							class:active={showHistory}
							on:click={handleHistory}
						>History</button>
						{#if shareRecord}
							<ObjectShareMenu record={shareRecord} />
						{/if}
					{/if}
				</div>

				{#if editMode}
					<div class="wiki-edit-area">
						<input
							type="text"
							class="wiki-edit-title"
							bind:value={editTitle}
						/>
						<div class="wiki-editor-toolbar" role="toolbar" aria-label="Markdown formatting">
							<button type="button" on:click={() => insertEditMarkdown('**bold**')}>Bold</button>
							<button type="button" on:click={() => insertEditMarkdown('*italic*')}>Italic</button>
							<button type="button" on:click={() => insertEditMarkdown('[link text](https://)')}>Link</button>
							<button type="button" on:click={() => insertEditMarkdown('## Heading\n')}>Heading</button>
							<button type="button" on:click={() => insertEditMarkdown('> Quote\n')}>Quote</button>
							<button type="button" disabled={imageUploading} on:click={() => imageInput?.click()}>{imageUploading ? 'Uploading…' : 'Image'}</button>
							<input class="wiki-image-input" type="file" accept="image/*" bind:this={imageInput} on:change={(event) => { const file = (event.currentTarget as HTMLInputElement).files?.[0]; if (file) void handleWikiImage(file); }} />
							<button type="button" class:active={editPreview} on:click={() => { editPreview = !editPreview; }}>{editPreview ? 'Edit' : 'Preview'}</button>
						</div>
						{#if editPreview}
							<div class="wiki-edit-preview wiki-content-body">{@html parseMessage(editBody)}</div>
						{:else}
							<textarea
								class="wiki-edit-body"
								bind:this={editBodyElement}
								bind:value={editBody}
							></textarea>
						{/if}
						<div class="wiki-edit-footer">
							<span class="wiki-edit-status" role="status">
								{saveState === 'saving' ? 'Saving…' : saveState === 'failed' ? 'Save failed — your draft is still here' : editIsDirty ? 'Unsaved changes' : saveState === 'saved' ? 'Saved' : 'No changes'}
							</span>
							<button class="wiki-edit-cancel-btn" on:click={handleCancelEdit}>Cancel</button>
							<button class="wiki-edit-save-btn" on:click={handleSaveEdit} disabled={saveState === 'saving' || !editIsDirty}>Save</button>
						</div>
					</div>
				{:else}
					<div class="wiki-content-header">
						<h1 class="wiki-content-header-title">{displayTitle}</h1>
						<div class="wiki-content-header-meta">
							{#if displayAuthor}
								<div
									class="wiki-content-header-meta-avatar"
									style="background: {displayAuthor.color || displayAuthor.roleColor || 'var(--accent-primary)'};"
								>
									{displayAuthor.username.charAt(0).toUpperCase()}
								</div>
								<span class="wiki-content-header-meta-author">{displayAuthor.username}</span>
							{:else if selectedPage}
								<div class="wiki-content-header-meta-avatar" style="background: var(--accent-primary);">?</div>
								<span class="wiki-content-header-meta-author">User #{selectedPage.authorUserId}</span>
							{/if}
							<span>·</span>
							<span>{displayTime}</span>
							{#if !viewRevision}
								<span>·</span>
								<span>{displayRevisionCount} revision{displayRevisionCount !== 1 ? 's' : ''}</span>
							{/if}
						</div>
					</div>
					<div class="wiki-content-body">
						{@html renderedBody}
					</div>
					{#if headings.length > 1}
						<nav class="wiki-table-of-contents" aria-label="On this page">
							<strong>On this page</strong>
							{#each headings.filter((heading) => heading.level <= 3) as heading}
								<a href={`#${heading.id}`} class="wiki-toc-level-{heading.level}">{heading.text}</a>
							{/each}
						</nav>
					{/if}
				{/if}
			{/if}
		</div>

		{#if showHistory}
			<WikiRevisionDrawer
				revisions={allRevisions}
				activeRevisionId={viewRevision?.revisionId || null}
				onSelectRevision={handleSelectRevision}
				onClose={handleCloseHistory}
			/>
		{/if}
	</div>
</div>
