<script lang="ts">
	import type { WikiPage } from '$lib/wikiStore';

	export let pages: WikiPage[] = [];
	export let activePageId: string | null = null;
	export let onSelect: (page: WikiPage) => void = () => {};
	export let onNewChild: ((parent: WikiPage | null) => void) | undefined = undefined;
	export let searchQuery = '';
	export let onSearch: ((q: string) => void) | undefined = undefined;

	$: topLevel = pages.filter((p) => !p.parentPageId);
	$: filteredPages = searchQuery
		? pages.filter((p) => p.title.toLowerCase().includes(searchQuery.toLowerCase()))
		: pages;

	$: filteredTopLevel = searchQuery
		? filteredPages
		: pages.filter((p) => !p.parentPageId);

	let collapsed = new Set<string>();

	function toggleCollapse(pageId: string) {
		if (collapsed.has(pageId)) {
			collapsed.delete(pageId);
		} else {
			collapsed.add(pageId);
		}
		collapsed = collapsed;
	}

	function hasChildren(pageId: string): boolean {
		return pages.some((p) => p.parentPageId === pageId);
	}

	function getChildren(parentId: string): WikiPage[] {
		return pages.filter((p) => p.parentPageId === parentId);
	}

	function isNewPage(page: WikiPage): boolean {
		const ms = page.updatedAtMicros > 1e12 ? Math.floor(page.updatedAtMicros / 1000) : page.updatedAtMicros;
		return Date.now() - ms < 60000;
	}

	function onChevronKey(e: KeyboardEvent, pageId: string) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			toggleCollapse(pageId);
		}
	}
</script>

<div class="wiki-tree-pane">
	<div class="wiki-tree-header">
		<span class="wiki-tree-header-label">Pages</span>
		{#if onNewChild}
			<button class="wiki-tree-new-btn" on:click={() => onNewChild(null)}>+ New</button>
		{/if}
	</div>
	{#if onSearch}
		<input
			type="text"
			class="wiki-tree-search"
			placeholder="Search pages..."
			bind:value={searchQuery}
			on:input={() => onSearch(searchQuery)}
		/>
	{/if}
	<div class="wiki-tree-list">
		{#if filteredTopLevel.length === 0}
			<div class="wiki-empty" style="padding: var(--space-8);">
				<p>No pages yet</p>
			</div>
		{:else}
			{#each filteredTopLevel as page (page.pageId)}
				<div class="wiki-tree-node">
					<button
						class="wiki-tree-item"
						class:active={page.pageId === activePageId}
						on:click={() => onSelect(page)}
					>
						{#if hasChildren(page.pageId)}
							<span
								class="wiki-tree-chevron"
								class:collapsed={collapsed.has(page.pageId)}
								role="button"
								tabindex="0"
								aria-label={collapsed.has(page.pageId) ? 'Expand page' : 'Collapse page'}
								on:click|stopPropagation={() => toggleCollapse(page.pageId)}
								on:keydown|stopPropagation={(e) => onChevronKey(e, page.pageId)}
							>&#9660;</span>
						{:else}
							<span class="wiki-tree-chevron" style="visibility:hidden" aria-hidden="true">&#9660;</span>
						{/if}
						<span class="wiki-tree-item-icon">&#128196;</span>
						<span class="wiki-tree-item-title">{page.title}</span>
						{#if isNewPage(page)}
							<span class="wiki-tree-item-new-badge">NEW</span>
						{/if}
					</button>
					{#if hasChildren(page.pageId) && !collapsed.has(page.pageId)}
						<div class="wiki-tree-children">
							{#each getChildren(page.pageId) as child (child.pageId)}
								<div class="wiki-tree-node">
									<button
										class="wiki-tree-item"
										class:active={child.pageId === activePageId}
										on:click={() => onSelect(child)}
									>
										{#if hasChildren(child.pageId)}
											<span
												class="wiki-tree-chevron"
												class:collapsed={collapsed.has(child.pageId)}
												role="button"
												tabindex="0"
												aria-label={collapsed.has(child.pageId) ? 'Expand page' : 'Collapse page'}
												on:click|stopPropagation={() => toggleCollapse(child.pageId)}
												on:keydown|stopPropagation={(e) => onChevronKey(e, child.pageId)}
											>&#9660;</span>
										{:else}
											<span class="wiki-tree-chevron" style="visibility:hidden" aria-hidden="true">&#9660;</span>
										{/if}
										<span class="wiki-tree-item-icon">&#128196;</span>
										<span class="wiki-tree-item-title">{child.title}</span>
										{#if isNewPage(child)}
											<span class="wiki-tree-item-new-badge">NEW</span>
										{/if}
									</button>
									{#if hasChildren(child.pageId) && !collapsed.has(child.pageId)}
										<div class="wiki-tree-children">
											{#each getChildren(child.pageId) as grandchild (grandchild.pageId)}
												<button
													class="wiki-tree-item"
													class:active={grandchild.pageId === activePageId}
													on:click={() => onSelect(grandchild)}
												>
													<span class="wiki-tree-item-icon">&#128196;</span>
													<span class="wiki-tree-item-title">{grandchild.title}</span>
													{#if isNewPage(grandchild)}
														<span class="wiki-tree-item-new-badge">NEW</span>
													{/if}
												</button>
											{/each}
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</div>
