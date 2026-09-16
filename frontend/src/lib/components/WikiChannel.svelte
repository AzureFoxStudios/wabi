<script lang="ts">
	import { onDestroy } from 'svelte';
	import { wikiDrafts, type WikiDraft } from '$lib/wikiDraftState';
	import { captureGroupAccess, groupMembership } from '$lib/groupAccess';
	import { onAuthSessionCleared } from '$lib/authSession';
	import { currentChannel } from '$lib/socket';
	import { createWikiWorkspace, type WikiPage, type WikiRevision } from '$lib/wikiStore';
	const wikiWorkspace = createWikiWorkspace();
	const { wikiPagesStore, wikiRevisionsStore, wikiLoadingStore, wikiErrorStore, loadWiki, loadRevisions, createWikiPage, updateWikiPage, findWikiAuthor, formatWikiTime } = wikiWorkspace;

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

	export let channelId: string | undefined = undefined;
	export let draftSurface = 'center';
	$: effectiveChannel = channelId || $currentChannel;

	$: allPages = $wikiPagesStore;
	$: allRevisions = $wikiRevisionsStore;
	$: isLoading = $wikiLoadingStore;
	$: error = $wikiErrorStore;

	let selectedPageId: string | null = null;
	let loadedPageKey = '';
	let creatingPage = false;
	let createError = '';
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

	let draftOwner: ReturnType<typeof wikiDrafts.open> | undefined;
	let stopDraftEvents: (() => void) | undefined;
	let draftChannel = '';
	let mounted = true;
	let editorEpoch = 0;
	function snapshot(): WikiDraft {
		return { selectedPageId, editMode, editTitle, editBody, editSavedTitle, editSavedBody,
			showNewPage, newPageTitle, newPageBody, newPageParentId };
	}
	function restoreDraft(draft?: WikiDraft) {
		editorEpoch += 1;
		imageUploading = false;
		selectedPageId = draft?.selectedPageId ?? null;
		loadedPageKey = selectedPageId ? `${draftChannel}/${selectedPageId}` : '';
		editMode = draft?.editMode ?? false;
		editTitle = draft?.editTitle ?? '';
		editBody = draft?.editBody ?? '';
		editSavedTitle = draft?.editSavedTitle ?? '';
		editSavedBody = draft?.editSavedBody ?? '';
		showNewPage = draft?.showNewPage ?? false;
		newPageTitle = draft?.newPageTitle ?? '';
		newPageBody = draft?.newPageBody ?? '';
		newPageParentId = draft?.newPageParentId ?? null;
		showTreeOnMobile = !selectedPageId;
		showHistory = false;
		viewRevision = null;
		createError = '';
		saveState = 'idle';
	}
	function openDraft(channel: string) {
		if (mounted) draftOwner?.save(snapshot());
		stopDraftEvents?.();
		draftChannel = channel;
		draftOwner = wikiDrafts.open(channel, captureGroupAccess(channel), draftSurface);
		if (draftOwner.current()) restoreDraft(draftOwner.read());
		else restoreDraft();
		const owner = draftOwner;
		const applyPending = (pending: boolean) => {
			creatingPage = pending && showNewPage;
			if (pending && !showNewPage) saveState = 'saving';
			else if (saveState === 'saving') saveState = 'idle';
		};
		applyPending(owner.isSending());
		stopDraftEvents = owner.onSendState((pending, update) => {
			if (!mounted || !owner.current()) return;
			if (update) {
				restoreDraft(update(snapshot()));
				owner.save(snapshot());
				void loadWiki(draftChannel);
			}
			applyPending(pending);
		});
	}
	function retireDraft() {
		if (draftOwner?.current()) draftOwner.save(snapshot());
		loadedChannelId = null;
		stopDraftEvents?.();
		draftOwner = undefined;
		restoreDraft();
		creatingPage = false;
	}
	const stopAuth = onAuthSessionCleared(retireDraft);
	const stopContext = groupMembership.onContextChanged(retireDraft);
	const stopRevocation = groupMembership.onRevoked(({ channelId }) => {
		if (channelId === draftChannel) retireDraft();
	});

	initObjectRefRegistry();

	$: if (allPages.length > 0 && effectiveChannel) {
		for (const page of allPages) {
			registerObjectRef({
				kind: 'wiki_page',
				id: page.pageId,
				slug: page.slug || slugify(page.title),
				title: page.title,
				channelId: effectiveChannel,
				subtitle: findWikiAuthor(page.authorUserId)?.username || undefined,
				updatedAt: page.updatedAtMicros > 1e12 ? Math.floor(page.updatedAtMicros / 1000) : page.updatedAtMicros,
			});
		}
	}

	$: selectedPage = allPages.find((p) => p.pageId === selectedPageId) || null;
	$: breadcrumbs = selectedPage ? getWikiBreadcrumbs(allPages, selectedPage.pageId) : [];
	$: headings = extractWikiHeadings(displayBody);

	$: if (selectedPage && effectiveChannel && loadedPageKey !== `${effectiveChannel}/${selectedPage.pageId}`) {
		loadedPageKey = `${effectiveChannel}/${selectedPage.pageId}`;
		loadRevisions(effectiveChannel, selectedPage.pageId);
		showHistory = false;
		editMode = false;
		viewRevision = null;
	}

	$: if (effectiveChannel && effectiveChannel !== loadedChannelId) {
		loadedChannelId = effectiveChannel;
		openDraft(effectiveChannel);
		loadWiki(effectiveChannel);
	}

	$: if (!effectiveChannel) {
		if (loadedChannelId) { draftOwner?.save(snapshot()); retireDraft(); }
		loadedChannelId = null;
		wikiSearchQuery = '';
	}

	// C2: deep-link handoff after pages load — peek first, take only on hit
	$: if (effectiveChannel && allPages.length > 0) {
		const pending = peekPendingNav();
		if (
			pending?.kind === 'wiki_page' &&
			(!pending.channelId || pending.channelId === effectiveChannel)
		) {
			const hit = allPages.find((p) => p.pageId === pending.pageId);
			if (hit) {
				takePendingNav('wiki_page', effectiveChannel);
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
		if (draftOwner?.isSending()) return;
		if (editIsDirty && !window.confirm('Discard unsaved wiki changes?')) return;
		editorEpoch += 1; imageUploading = false;
		selectedPageId = page.pageId;
		showTreeOnMobile = false;
		editMode = false;
		showHistory = false;
		viewRevision = null;
	}

	function handleEdit() {
		if (!selectedPage || draftOwner?.isSending()) return;
		editorEpoch += 1; imageUploading = false;
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
		if (draftOwner?.isSending()) return;
		if (editIsDirty && !window.confirm('Discard unsaved wiki changes?')) return;
		editorEpoch += 1; imageUploading = false;
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

	// New-page mode gets the same editor affordances as edit mode.
	// (Legacy-mode file: plain lets, matching the rest of WikiChannel.)
	let newPageBodyElement: HTMLTextAreaElement | undefined;
	let newPageImageInput: HTMLInputElement | undefined;
	let newPagePreview = false;
	function insertNewPageMarkdown(insertion: string) {
		if (creatingPage || !newPageBodyElement) return;
		const next = insertWikiMarkdown(newPageBody, newPageBodyElement.selectionStart, newPageBodyElement.selectionEnd, insertion);
		newPageBody = next.value;
		requestAnimationFrame(() => {
			newPageBodyElement?.focus();
			newPageBodyElement?.setSelectionRange(next.selectionStart, next.selectionEnd);
		});
	}
	async function handleNewPageImage(file: File) {
		if (!effectiveChannel || !file.type.startsWith('image/')) return;
		const owner = draftOwner;
		const epoch = editorEpoch;
		const isCurrent = () => mounted && owner === draftOwner && !!owner?.current() && epoch === editorEpoch;
		imageUploading = true;
		try {
			const uploaded = await uploadFileResumable(file, effectiveChannel, () => {}, false, undefined, isCurrent);
			if (!isCurrent()) return;
			insertNewPageMarkdown(`![${file.name.replace(/\.[^.]+$/, '')}](${uploaded.fileUrl})`);
		} catch (err) {
			if (isCurrent()) copyError = err instanceof Error ? err.message : 'Image upload failed';
		} finally {
			if (!isCurrent()) return;
			imageUploading = false;
			if (newPageImageInput) newPageImageInput.value = '';
		}
	}

	async function handleSaveEdit() {
		if (!effectiveChannel || !selectedPage || saveState === 'saving') return;
		if (!editTitle.trim()) {
			saveState = 'failed';
			return;
		}
		const owner = draftOwner;
		if (owner === draftOwner) owner?.save(snapshot());
		const transaction = owner?.beginSend();
		if (!transaction) return;
		const savingChannel = effectiveChannel;
		const savingPage = selectedPage.pageId;
		const title = editTitle;
		const body = editBody;
		saveState = 'saving';
		const result = await updateWikiPage(effectiveChannel, selectedPage.pageId, {
			title,
			body,
		});
		if (mounted && owner === draftOwner) owner?.save(snapshot());
		if (result) transaction.settle(draft => ({ ...draft,
			editSavedTitle: title, editSavedBody: body,
			editMode: draft.editTitle !== title || draft.editBody !== body
		}));
		transaction.finish();
		if (!mounted || !owner?.current() || effectiveChannel !== savingChannel || selectedPageId !== savingPage) return;
		editPreview = false;
		saveState = result ? 'saved' : 'failed';
		if (result) void loadWiki(effectiveChannel);
	}

	async function handleWikiImage(file: File) {
		if (!effectiveChannel || !file.type.startsWith('image/')) return;
		const owner = draftOwner;
		const epoch = editorEpoch;
		const isCurrent = () => mounted && owner === draftOwner && !!owner?.current() && epoch === editorEpoch;
		imageUploading = true;
		try {
			const uploaded = await uploadFileResumable(file, effectiveChannel, () => {}, false, undefined, isCurrent);
			if (!isCurrent()) return;
			insertEditMarkdown(`![${file.name.replace(/\.[^.]+$/, '')}](${uploaded.fileUrl})`);
		} catch (err) {
			if (isCurrent()) copyError = err instanceof Error ? err.message : 'Image upload failed';
		} finally {
			if (!isCurrent()) return;
			imageUploading = false;
			if (imageInput) imageInput.value = '';
		}
	}

	function handleHistory() {
		if (draftOwner?.isSending()) return;
		if (editIsDirty && !window.confirm('Discard unsaved wiki changes?')) return;
		showHistory = !showHistory;
		if (showHistory && effectiveChannel && selectedPage) void loadRevisions(effectiveChannel, selectedPage.pageId);
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
		if (!effectiveChannel || !selectedPage) return;
		const owner = draftOwner;
		const restoringPage = selectedPage.pageId;
		const result = await updateWikiPage(effectiveChannel, selectedPage.pageId, {
			title: revision.title,
			body: revision.body,
		});
		if (result && mounted && owner === draftOwner && owner?.current() && selectedPageId === restoringPage) {
			viewRevision = null;
		}
	}

	function handleDismissRevision() {
		viewRevision = null;
	}

	async function copyWikiCitation() {
		if (!selectedPage || !effectiveChannel) return;
		const citation = getWikiCitation(window.location.origin, effectiveChannel, selectedPage);
		try {
			await navigator.clipboard.writeText(formatWikiCitationMarkdown(citation));
			copyError = '';
		} catch {
			copyError = 'Could not copy citation';
		}
	}

	function handleOpenNewPage() {
		if (draftOwner?.isSending()) return;
		if (showNewPage) return;
		if (editIsDirty && !window.confirm('Discard unsaved wiki changes?')) return;
		editorEpoch += 1; imageUploading = false;
		editMode = false;
		createError = '';
		newPageTitle = '';
		newPageBody = '';
		newPageParentId = null;
		showNewPage = true;
	}

	function handleNewChild(parent: WikiPage | null) {
		if (draftOwner?.isSending()) return;
		if ((editIsDirty || (showNewPage && (newPageTitle.trim() || newPageBody.trim()))) && !window.confirm('Discard unsaved wiki changes?')) return;
		editorEpoch += 1; imageUploading = false;
		editMode = false;
		newPageTitle = '';
		newPageBody = '';
		newPageParentId = parent?.pageId || null;
		showNewPage = true;
	}

	function handleCancelNewPage() {
		if (creatingPage) return;
		if ((newPageTitle.trim() || newPageBody.trim()) && !window.confirm('Discard this unsaved wiki page?')) return;
		editorEpoch += 1; imageUploading = false;
		showNewPage = false;
		newPageTitle = '';
		newPageBody = '';
	}

	async function handleCreateNewPage() {
		if (!effectiveChannel || !newPageTitle.trim() || creatingPage) return;
		const owner = draftOwner;
		if (owner === draftOwner) owner?.save(snapshot());
		const transaction = owner?.beginSend();
		if (!transaction) return;
		creatingPage = true;
		createError = '';
		const creatingChannel = effectiveChannel;
		const result = await createWikiPage(effectiveChannel, {
			title: newPageTitle.trim(),
			body: newPageBody,
			parentPageId: newPageParentId || undefined,
		});
		if (mounted && owner === draftOwner) owner?.save(snapshot());
		if (result) transaction.settle(draft => ({ ...draft, showNewPage: false,
			newPageTitle: '', newPageBody: '', newPageParentId: null, selectedPageId: result.pageId }));
		transaction.finish();
		if (!mounted || !owner?.current() || effectiveChannel !== creatingChannel) return;
		creatingPage = false;
		if (!result) createError = 'Page could not be created. Your draft is still here.';
		if (result) void loadWiki(effectiveChannel);
	}

	$: shareRecord = selectedPage ? {
		kind: 'wiki_page' as const,
		id: selectedPage.pageId,
		slug: selectedPage.slug || slugify(selectedPage.title),
		title: selectedPage.title,
		channelId: effectiveChannel || '',
		subtitle: findWikiAuthor(selectedPage.authorUserId)?.username || undefined,
		updatedAt: selectedPage.updatedAtMicros > 1e12 ? Math.floor(selectedPage.updatedAtMicros / 1000) : selectedPage.updatedAtMicros,
	} : null;

	$: renderedBody = displayBody ? parseMessage(displayBody) : '';
	$: editIsDirty = editMode && (editTitle !== editSavedTitle || editBody !== editSavedBody);
	$: if (editMode && editIsDirty && (saveState === 'idle' || saveState === 'saved')) saveState = 'dirty';
	$: if (editMode && !editIsDirty && saveState === 'dirty') saveState = 'idle';

	onDestroy(() => {
		draftOwner?.save(snapshot());
		mounted = false;
		stopDraftEvents?.();
		stopAuth(); stopContext(); stopRevocation();
		wikiWorkspace.dispose();
		selectedPageId = null;
	});

	if (typeof window !== 'undefined') {
		const handleBeforeUnload = (event: BeforeUnloadEvent) => {
			if (!editIsDirty && !(showNewPage && (newPageTitle.trim() || newPageBody.trim()))) return;
			event.preventDefault();
			event.returnValue = '';
		};
		window.addEventListener('beforeunload', handleBeforeUnload);
		onDestroy(() => window.removeEventListener('beforeunload', handleBeforeUnload));
	}
</script>

<div class="wiki-channel">
	{#if !showNewPage}
	<SurfaceToolbar
		searchPlaceholder="Search wiki..."
		onSearch={(query) => { wikiSearchQuery = query; }}
		primaryLabel="+ New Page"
		onPrimary={handleOpenNewPage}
	>
		<button class="surface-pill" disabled={isLoading || saveState === 'saving'} on:click={() => effectiveChannel && loadWiki(effectiveChannel)}>Refresh pages</button>
	</SurfaceToolbar>

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
			{:else if error && !editMode}
				<div class="wiki-error">
					<span>{error}</span>
					<button on:click={() => effectiveChannel && loadWiki(effectiveChannel)}>Retry</button>
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
						<button type="button" class="wiki-content-toolbar-link" on:click={() => { if (draftOwner?.isSending() || (editIsDirty && !window.confirm('Discard unsaved wiki changes?'))) return; editorEpoch += 1; imageUploading = false; editMode = false; selectedPageId = null; }}>Wiki</button>
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

	{:else}
		<div
			class="wiki-draft-drawer"
			role="dialog"
			aria-modal="false"
			tabindex="-1"
			aria-label="New page draft"
			on:keydown={(e) => { if (e.key === 'Escape') handleCancelNewPage(); }}
		>
			<div class="wiki-draft-drawer-header">
				<div class="wiki-draft-drawer-titles">
					<span class="wiki-draft-drawer-kicker">Focused writing</span>
					<h2 class="wiki-draft-drawer-title">New page</h2>
					<span class="wiki-draft-drawer-channel">{newPageParentId ? `Child of ${allPages.find((p) => p.pageId === newPageParentId)?.title || 'page'}` : 'Top-level page'}</span>
				</div>
				<button
					class="wiki-draft-drawer-close"
					on:click={handleCancelNewPage}
					title="Close draft"
					aria-label="Close draft"
				>&#10005;</button>
			</div>
			<div class="wiki-draft-drawer-body">
				<div class="wiki-edit-area">
					<input
						type="text"
						class="wiki-edit-title"
						placeholder="Page title..."
						bind:value={newPageTitle}
						disabled={creatingPage}
					/>
					<div class="wiki-editor-toolbar" role="toolbar" aria-label="Markdown formatting">
						<button type="button" on:click={() => insertNewPageMarkdown('**bold**')}>Bold</button>
						<button type="button" on:click={() => insertNewPageMarkdown('*italic*')}>Italic</button>
						<button type="button" on:click={() => insertNewPageMarkdown('[link text](https://)')}>Link</button>
						<button type="button" on:click={() => insertNewPageMarkdown('## Heading\n')}>Heading</button>
						<button type="button" on:click={() => insertNewPageMarkdown('> Quote\n')}>Quote</button>
						<button type="button" disabled={imageUploading} on:click={() => newPageImageInput?.click()}>{imageUploading ? 'Uploading…' : 'Image'}</button>
						<input class="wiki-image-input" type="file" accept="image/*" bind:this={newPageImageInput} on:change={(event) => { const file = (event.currentTarget as HTMLInputElement).files?.[0]; if (file) void handleNewPageImage(file); }} />
						<button type="button" class:active={newPagePreview} on:click={() => { newPagePreview = !newPagePreview; }}>{newPagePreview ? 'Edit' : 'Preview'}</button>
					</div>
					{#if newPagePreview}
						<div class="wiki-edit-preview wiki-content-body">{@html parseMessage(newPageBody)}</div>
					{:else}
						<textarea
							class="wiki-edit-body"
							placeholder="Write wiki content in markdown..."
							bind:this={newPageBodyElement}
							bind:value={newPageBody}
							disabled={creatingPage}
						></textarea>
					{/if}
					<div class="wiki-edit-footer">
						<span class="wiki-edit-status" role="status">{creatingPage ? 'Creating…' : createError || (newPageTitle.trim() || newPageBody.trim() ? 'Unsaved draft' : 'New draft')}</span>
						<button class="wiki-edit-cancel-btn" on:click={handleCancelNewPage}>Cancel</button>
						<button class="wiki-edit-save-btn" on:click={handleCreateNewPage} disabled={creatingPage || !newPageTitle.trim()}>{creatingPage ? 'Creating…' : 'Create'}</button>
					</div>
				</div>
			</div>
		</div>
	{/if}
</div>
