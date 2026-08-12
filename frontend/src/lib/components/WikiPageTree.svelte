<script lang="ts">
	import type { WikiPage } from '$lib/wikiStore';
	import { buildWikiTree, sortWikiPages, type WikiTreeNode } from '$lib/wikiHelpers';

	export let pages: WikiPage[] = [];
	export let activePageId: string | null = null;
	export let onSelect: (page: WikiPage) => void = () => {};
	export let onNewChild: ((parent: WikiPage | null) => void) | undefined = undefined;
	export let searchQuery = '';
	export let onSearch: ((q: string) => void) | undefined = undefined;

	let collapsed = new Set<string>();
	let previousSearch = '';

	$: visiblePages = sortWikiPages(pages);
	$: tree = buildWikiTree(visiblePages);
	$: normalizedQuery = searchQuery.trim().toLocaleLowerCase();
	$: matchingIds = new Set(
		visiblePages
			.filter((page) => `${page.title}\n${page.body}`.toLocaleLowerCase().includes(normalizedQuery))
			.map((page) => page.pageId)
	);
	$: visibleTree = normalizedQuery ? filterTree(tree) : tree;
	$: if (normalizedQuery && normalizedQuery !== previousSearch) {
		previousSearch = normalizedQuery;
		for (const page of visiblePages) {
			if (matchingIds.has(page.pageId)) expandAncestors(page.pageId);
		}
	}

	function filterTree(nodes: WikiTreeNode[]): WikiTreeNode[] {
		return nodes
			.map((node) => ({ ...node, children: filterTree(node.children) }))
			.filter((node) => matchingIds.has(node.page.pageId) || node.children.length > 0);
	}

	function expandAncestors(pageId: string) {
		const page = visiblePages.find((candidate) => candidate.pageId === pageId);
		if (!page?.parentPageId) return;
		collapsed.delete(page.parentPageId);
		expandAncestors(page.parentPageId);
		collapsed = collapsed;
	}

	function toggleCollapse(pageId: string) {
		if (collapsed.has(pageId)) collapsed.delete(pageId);
		else collapsed.add(pageId);
		collapsed = collapsed;
	}

	function isNewPage(page: WikiPage): boolean {
		const ms = page.updatedAtMicros > 1e12 ? Math.floor(page.updatedAtMicros / 1000) : page.updatedAtMicros;
		return Date.now() - ms < 60000;
	}

	function handleTreeKey(event: KeyboardEvent, node: WikiTreeNode) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			onSelect(node.page);
		} else if (event.key === 'ArrowRight' && node.children.length > 0) {
			event.preventDefault();
			collapsed.delete(node.page.pageId);
			collapsed = collapsed;
		} else if (event.key === 'ArrowLeft' && node.children.length > 0) {
			event.preventDefault();
			collapsed.add(node.page.pageId);
			collapsed = collapsed;
		}
	}
</script>

{#snippet renderNode(node: WikiTreeNode)}
	<div class="wiki-tree-node">
		<div class="wiki-tree-row">
			{#if node.children.length > 0}
				<button
					type="button"
					class="wiki-tree-chevron"
					class:collapsed={collapsed.has(node.page.pageId)}
					aria-label={collapsed.has(node.page.pageId) ? `Expand ${node.page.title}` : `Collapse ${node.page.title}`}
					on:click={() => toggleCollapse(node.page.pageId)}
				>▾</button>
			{:else}
				<span class="wiki-tree-chevron wiki-tree-chevron-empty" aria-hidden="true">▾</span>
			{/if}
			<button
				type="button"
				class="wiki-tree-item"
				class:active={node.page.pageId === activePageId}
				title={node.page.title}
				on:click={() => onSelect(node.page)}
				on:keydown={(event) => handleTreeKey(event, node)}
			>
				<span class="wiki-tree-item-icon" aria-hidden="true">▱</span>
				<span class="wiki-tree-item-title">{node.page.title}</span>
				{#if isNewPage(node.page)}<span class="wiki-tree-item-new-badge">NEW</span>{/if}
			</button>
		</div>
		{#if node.children.length > 0 && !collapsed.has(node.page.pageId)}
			<div class="wiki-tree-children">
				{#each node.children as child (child.page.pageId)}
					{@render renderNode(child)}
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

<div class="wiki-tree-pane">
	<div class="wiki-tree-header">
		<span class="wiki-tree-header-label">Pages</span>
		{#if onNewChild}
			<button type="button" class="wiki-tree-new-btn" on:click={() => onNewChild(null)}>+ New</button>
		{/if}
	</div>
	{#if onSearch}
		<input
			type="search"
			class="wiki-tree-search"
			placeholder="Search pages..."
			aria-label="Search wiki pages"
			bind:value={searchQuery}
			on:input={() => onSearch?.(searchQuery)}
		/>
	{/if}
	<div class="wiki-tree-list" role="tree" aria-label="Wiki pages">
		{#if visibleTree.length === 0}
			<div class="wiki-empty" style="padding: var(--space-8);">
				<p>{normalizedQuery ? 'No matching pages' : 'No pages yet'}</p>
				{#if normalizedQuery}<button type="button" class="wiki-tree-new-btn" on:click={() => { searchQuery = ''; onSearch?.(''); }}>Clear search</button>{/if}
			</div>
		{:else}
			{#each visibleTree as node (node.page.pageId)}
				{@render renderNode(node)}
			{/each}
		{/if}
	</div>
</div>
