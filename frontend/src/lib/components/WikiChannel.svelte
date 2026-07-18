<script lang="ts">
	import { onDestroy } from 'svelte';
	import { currentChannel, channels } from '$lib/socket';
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
	import SurfaceHeader from './SurfaceHeader.svelte';
	import SurfaceToolbar from './SurfaceToolbar.svelte';
	import WikiPageTree from './WikiPageTree.svelte';
	import WikiRevisionDrawer from './WikiRevisionDrawer.svelte';
	import { initObjectRefRegistry, registerObjectRef, slugify } from '$lib/objectRefRegistry';
	import { parseMessage } from '$lib/markdown';
	import ObjectShareMenu from './ObjectShareMenu.svelte';

	$: activeChannel = $channels.find((ch) => ch.id === $currentChannel) || null;
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

	$: if (selectedPage && $currentChannel) {
		loadRevisions($currentChannel, selectedPage.pageId);
		showHistory = false;
		editMode = false;
		viewRevision = null;
	}

	$: if ($currentChannel) {
		loadWiki($currentChannel);
	}

	$: revisionsForDrawer = showHistory ? allRevisions : [];

	$: displayTitle = viewRevision ? viewRevision.title : (selectedPage?.title || '');
	$: displayBody = viewRevision ? viewRevision.body : (selectedPage?.body || '');
	$: displayAuthor = selectedPage ? findWikiAuthor(selectedPage.authorUserId) : undefined;
	$: displayTime = selectedPage ? formatWikiTime(selectedPage.updatedAtMicros) : '';
	$: displayRevisionCount = allRevisions.length;

	function selectPage(page: WikiPage) {
		selectedPageId = page.pageId;
		editMode = false;
		showHistory = false;
		viewRevision = null;
	}

	function handleEdit() {
		if (!selectedPage) return;
		editTitle = selectedPage.title;
		editBody = selectedPage.body;
		editMode = true;
		viewRevision = null;
		showHistory = false;
	}

	function handleCancelEdit() {
		editMode = false;
	}

	async function handleSaveEdit() {
		if (!$currentChannel || !selectedPage) return;
		const result = await updateWikiPage($currentChannel, selectedPage.pageId, {
			title: editTitle,
			body: editBody,
		});
		if (result) {
			editMode = false;
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

	onDestroy(() => {
		selectedPageId = null;
	});
</script>

<div class="wiki-channel">
	<SurfaceHeader
		title={activeChannel?.name || 'Wiki'}
		description="Wiki"
		primaryLabel="+ New Page"
		onPrimary={handleOpenNewPage}
	/>

	<SurfaceToolbar
		searchPlaceholder="Search wiki..."
		onSearch={() => {}}
	/>

	<div class="wiki-body" class:has-drawer={showHistory}>
		<WikiPageTree
			pages={allPages}
			activePageId={selectedPageId}
			onSelect={selectPage}
			onNewChild={handleNewChild}
		/>

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
				<div class="wiki-content-toolbar">
					<div class="wiki-content-toolbar-breadcrumb">
						<span>New Page</span>
					</div>
				</div>
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
						<a href="#" on:click|preventDefault={() => { selectedPageId = null; }}>Wiki</a>
						<span>/</span>
						<span>{selectedPage.title}</span>
					</div>
					{#if !editMode}
						<button class="wiki-content-toolbar-btn" on:click={handleEdit}>Edit</button>
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
						<textarea
							class="wiki-edit-body"
							bind:value={editBody}
						></textarea>
						<div class="wiki-edit-footer">
							<button class="wiki-edit-cancel-btn" on:click={handleCancelEdit}>Cancel</button>
							<button class="wiki-edit-save-btn" on:click={handleSaveEdit}>Save</button>
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
