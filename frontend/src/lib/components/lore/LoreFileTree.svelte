<script lang="ts">
	import type { LoreFileInfo } from '$lib/api/lore';
	import { buildLoreFileTree } from '$lib/lore/fileTree';
	import TreeNode from './LoreTreeNode.svelte';

	interface Props {
		files: LoreFileInfo[];
		selectedPath: string | null;
		loading: boolean;
		onSelect: (path: string) => void;
		onOpen: (path: string) => void;
		onContextMenu: (path: string, event: MouseEvent, isFolder?: boolean) => void;
	}

	let { files, selectedPath, loading, onSelect, onOpen, onContextMenu }: Props = $props();

	let searchQuery = $state('');

	let tree = $derived(
		buildLoreFileTree(
			files.filter((f) => !searchQuery || f.path.toLowerCase().includes(searchQuery.toLowerCase()))
		)
	);
</script>

<div class="lore-file-tree">
	<input
		type="text"
		class="tree-search"
		bind:value={searchQuery}
		placeholder="Search files..."
		aria-label="Search files"
	/>

	{#if loading}
		<div class="tree-skeleton">
			{#each Array(8) as _}
				<div class="skeleton-line"></div>
			{/each}
		</div>
	{:else}
		<ul class="tree-root" role="tree" aria-label="File tree">
			<!-- Keyed by path: without keys, filtering/rebuilding the tree
			     scrambles per-node expansion state across unrelated folders. -->
			{#each tree as node (node.path)}
				<TreeNode
					{node}
					{selectedPath}
					{onSelect}
					{onOpen}
					{onContextMenu}
				/>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.lore-file-tree {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
	}

	.tree-search {
		padding: var(--space-1) var(--space-2);
		background: var(--surface-sunken);
		border: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		border-radius: var(--radius-sm);
		color: var(--text-heading);
		font-size: var(--font-size-sm);
		margin: var(--space-1);
	}

	.tree-search::placeholder {
		color: var(--text-muted);
	}

	.tree-root {
		list-style: none;
		margin: 0;
		padding: 0 var(--space-1);
		overflow-y: auto;
		flex: 1;
	}

	.skeleton-line {
		height: 20px;
		margin: 2px var(--space-2);
		background: var(--surface-raised);
		border-radius: var(--radius-sm);
		animation: pulse 1.5s ease-in-out infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 0.4; }
		50% { opacity: 0.8; }
	}
</style>
