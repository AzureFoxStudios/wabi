<script lang="ts">
	/**
	 * The wiki's page tree (design contract §8.7): the PAGES kicker with the one "New page"
	 * action, a chrome search field, and 32px rows (44px on touch) in the sidebar's selection
	 * grammar. No page glyph and no NEW badge: a row is its title, with a chevron only on pages
	 * that have sub-pages.
	 *
	 * Keyboard and assistive tech follow the WAI-ARIA tree pattern: role=tree with treeitems that
	 * carry aria-level, aria-expanded (parents) and aria-selected; one tab stop (roving tabindex);
	 * ↑/↓ move, → opens or steps into a parent, ← closes or steps out to the parent, Home/End,
	 * Enter or Space open the page, and typing a letter jumps to the next title that starts with it.
	 */
	import type { WikiPage } from '$lib/wikiStore';
	import { buildWikiTree, sortWikiPages, type WikiTreeNode } from '$lib/wikiHelpers';
	import { _ } from '$lib/i18n';
	import Icon from './ui/Icon.svelte';
	import Skeleton from './ui/Skeleton.svelte';

	export let pages: WikiPage[] = [];
	export let activePageId: string | null = null;
	export let onSelect: (page: WikiPage) => void = () => {};
	export let onNewChild: ((parent: WikiPage | null) => void) | undefined = undefined;
	export let searchQuery = '';
	export let onSearch: ((q: string) => void) | undefined = undefined;
	export let emptyStateLabel: string | null = null;
	/** Pages are still loading: skeleton rows instead of an empty tree. */
	export let loading = false;
	/** In the companion panel "New page" steps back to a quiet button (§2.4: the page owns the primary). */
	export let quiet = false;
	/** While a page is being written or saved, starting another one waits. */
	export let newPageDisabled = false;
	/** Distinguishes the center and panel instances' element ids. */
	export let idPrefix = 'wiki';

	let collapsed = new Set<string>();
	let previousSearch = '';
	let focusId: string | null = null;
	let treeEl: HTMLUListElement | null = null;
	let typeahead = '';
	let typeaheadTimer: ReturnType<typeof setTimeout> | undefined;

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
	$: if (!normalizedQuery) previousSearch = '';
	$: if (activePageId) expandAncestors(activePageId);
	// The one tab stop: the focused row if it is still shown, else the open page, else the first row.
	$: shownIds = flatten(visibleTree, collapsed);
	$: tabStop = focusId && shownIds.includes(focusId) ? focusId : activePageId && shownIds.includes(activePageId) ? activePageId : (shownIds[0] ?? null);
	$: headingId = `${idPrefix}-pages-heading`;

	function flatten(nodes: WikiTreeNode[], closed: Set<string>): string[] {
		return nodes.flatMap((node) => [node.page.pageId, ...(closed.has(node.page.pageId) ? [] : flatten(node.children, closed))]);
	}

	function filterTree(nodes: WikiTreeNode[]): WikiTreeNode[] {
		return nodes
			.map((node) => ({ ...node, children: filterTree(node.children) }))
			.filter((node) => matchingIds.has(node.page.pageId) || node.children.length > 0);
	}

	function expandAncestors(pageId: string) {
		const seen = new Set<string>();
		let page = visiblePages.find((candidate) => candidate.pageId === pageId);
		let changed = false;
		while (page?.parentPageId && !seen.has(page.parentPageId)) {
			seen.add(page.parentPageId);
			if (collapsed.delete(page.parentPageId)) changed = true;
			page = visiblePages.find((candidate) => candidate.pageId === page?.parentPageId);
		}
		if (changed) collapsed = collapsed;
	}

	function setOpen(pageId: string, open: boolean) {
		if (open) collapsed.delete(pageId);
		else collapsed.add(pageId);
		collapsed = collapsed;
	}

	function nodeById(nodes: WikiTreeNode[], pageId: string): WikiTreeNode | null {
		for (const node of nodes) {
			if (node.page.pageId === pageId) return node;
			const inner = nodeById(node.children, pageId);
			if (inner) return inner;
		}
		return null;
	}

	function focusRow(pageId: string | null | undefined) {
		if (!pageId || !treeEl) return;
		focusId = pageId;
		const row = [...treeEl.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((item) => item.dataset.pageId === pageId);
		row?.focus();
	}

	function handleTreeKey(event: KeyboardEvent) {
		const item = (event.target as HTMLElement | null)?.closest<HTMLElement>('[role="treeitem"]');
		const pageId = item?.dataset.pageId;
		if (!pageId) return;
		const node = nodeById(visibleTree, pageId);
		if (!node) return;
		const index = shownIds.indexOf(pageId);
		const parent = node.children.length > 0;
		const open = parent && !collapsed.has(pageId);
		switch (event.key) {
			case 'ArrowDown':
				focusRow(shownIds[index + 1]);
				break;
			case 'ArrowUp':
				focusRow(shownIds[index - 1]);
				break;
			case 'Home':
				focusRow(shownIds[0]);
				break;
			case 'End':
				focusRow(shownIds[shownIds.length - 1]);
				break;
			case 'ArrowRight':
				if (parent && !open) setOpen(pageId, true);
				else if (open) focusRow(node.children[0]?.page.pageId);
				break;
			case 'ArrowLeft':
				if (open) setOpen(pageId, false);
				else focusRow(item?.parentElement?.closest<HTMLElement>('[role="treeitem"]')?.dataset.pageId);
				break;
			case 'Enter':
			case ' ':
				onSelect(node.page);
				break;
			default:
				if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && /\S/.test(event.key)) {
					runTypeahead(event.key, index);
					break;
				}
				return;
		}
		event.preventDefault();
		event.stopPropagation();
	}

	function runTypeahead(char: string, from: number) {
		if (typeaheadTimer) clearTimeout(typeaheadTimer);
		typeahead += char.toLocaleLowerCase();
		typeaheadTimer = setTimeout(() => (typeahead = ''), 600);
		const start = typeahead.length === 1 ? from + 1 : Math.max(from, 0);
		for (let step = 0; step < shownIds.length; step += 1) {
			const id = shownIds[(start + step) % shownIds.length];
			const title = visiblePages.find((page) => page.pageId === id)?.title ?? '';
			if (title.toLocaleLowerCase().startsWith(typeahead)) {
				focusRow(id);
				return;
			}
		}
	}

	function clearSearch() {
		searchQuery = '';
		onSearch?.('');
	}
</script>

{#snippet renderNode(node: WikiTreeNode, level: number)}
	{@const pageId = node.page.pageId}
	{@const parent = node.children.length > 0}
	{@const open = parent && !collapsed.has(pageId)}
	{@const active = pageId === activePageId}
	<!-- The row is the treeitem; its sub-pages are its group. The chevron is a pointer target for
	     open/close only; the keys above do the same from the row. -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<li
		role="treeitem"
		class="wiki-tree-item"
		class:active
		data-page-id={pageId}
		aria-level={level}
		aria-selected={active}
		aria-current={active ? 'page' : undefined}
		aria-expanded={parent ? open : undefined}
		aria-label={node.page.title}
		tabindex={pageId === tabStop ? 0 : -1}
		on:click|stopPropagation={() => {
			focusId = pageId;
			onSelect(node.page);
		}}
		on:focus|self={() => (focusId = pageId)}
	>
		<span class="wiki-tree-row" style="--wiki-tree-level: {level - 1}" title={node.page.title}>
			{#if parent}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<span
					class="wiki-tree-chevron"
					class:open
					aria-hidden="true"
					on:click|stopPropagation={() => setOpen(pageId, !open)}
				><Icon name="chevRight" size={14} /></span>
			{:else}
				<span class="wiki-tree-chevron wiki-tree-chevron--leaf" aria-hidden="true"></span>
			{/if}
			<span class="wiki-tree-title">{node.page.title}</span>
		</span>
		{#if open}
			<ul role="group" class="wiki-tree-group">
				{#each node.children as child (child.page.pageId)}
					{@render renderNode(child, level + 1)}
				{/each}
			</ul>
		{/if}
	</li>
{/snippet}

<div class="wiki-tree-pane" class:quiet>
	<div class="wiki-tree-head">
		<p class="w-kicker wiki-tree-kicker" id={headingId}>{$_('wiki.pages')}</p>
		{#if !loading && visiblePages.length > 0}<span class="w-count wiki-tree-count">{visiblePages.length}</span>{/if}
		{#if onNewChild}
			<button
				type="button"
				class="w-btn wiki-tree-new"
				class:w-btn--primary={!quiet}
				class:w-btn--quiet={quiet}
				disabled={newPageDisabled}
				on:click={() => onNewChild?.(null)}
			><Icon name="plus" size={16} />{$_('wiki.new_page')}</button>
		{/if}
	</div>
	{#if onSearch}
		<label class="w-field w-field--chrome wiki-tree-search">
			<Icon name="search" size={16} />
			<input
				type="search"
				placeholder="Search pages"
				aria-label="Search pages"
				bind:value={searchQuery}
				on:input={() => onSearch?.(searchQuery)}
				on:keydown={(event) => {
					if (event.key === 'Escape' && searchQuery) {
						event.preventDefault();
						event.stopPropagation();
						clearSearch();
					}
				}}
			/>
		</label>
	{/if}
	{#if loading && visiblePages.length === 0}
		<Skeleton variant="row" rows={4} label="Loading pages" class="wiki-tree-skeleton" />
	{:else if visibleTree.length === 0}
		<div class="wiki-tree-empty">
			<p role="status">{emptyStateLabel ?? (normalizedQuery ? `No pages match “${searchQuery.trim()}”.` : 'No pages yet.')}</p>
			{#if normalizedQuery && !emptyStateLabel}<button type="button" class="w-btn w-btn--quiet w-btn--sm" on:click={clearSearch}>Clear search</button>{/if}
		</div>
	{:else}
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<ul class="wiki-tree-list" role="tree" aria-labelledby={headingId} bind:this={treeEl} on:keydown={handleTreeKey}>
			{#each visibleTree as node (node.page.pageId)}
				{@render renderNode(node, 1)}
			{/each}
		</ul>
	{/if}
</div>
