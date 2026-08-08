<script lang="ts">
	import type { LoreFileInfo } from '$lib/api/lore';
	import TreeNode from './LoreTreeNode.svelte';

	interface TreeNodeData {
		name: string;
		path: string;
		isFolder: boolean;
		children: TreeNodeData[];
		file?: LoreFileInfo;
	}

	interface Props {
		node: TreeNodeData;
		selectedPath: string | null;
		onSelect: (path: string) => void;
		onOpen: (path: string) => void;
		onContextMenu: (path: string, event: MouseEvent) => void;
	}

	let { node, selectedPath, onSelect, onOpen, onContextMenu }: Props = $props();

	let expanded = $state(false);

	function fileIcon(file: LoreFileInfo): string {
		const ext = file.path.split('.').pop()?.toLowerCase() || '';
		const codeExts = ['ts', 'js', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'css', 'scss', 'html', 'svelte', 'vue', 'jsx', 'tsx', 'json', 'yaml', 'yml', 'toml', 'md', 'sh', 'bash', 'sql', 'rb', 'php', 'swift', 'kt'];
		const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'];
		if (codeExts.includes(ext)) return '📄';
		if (imageExts.includes(ext)) return '🖼';
		if (file.size > 1024 * 1024) return '📦';
		return '📃';
	}

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes}B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
</script>

{#if node.isFolder}
	<li role="treeitem" aria-expanded={expanded}>
		<button class="tree-folder" onclick={() => expanded = !expanded}>
			<span class="folder-arrow">{expanded ? '▼' : '▶'}</span>
			<span class="folder-icon">📁</span>
			<span class="node-name">{node.name}</span>
		</button>
		{#if expanded && node.children.length > 0}
			<ul class="tree-children" role="group">
				{#each node.children as child}
					<TreeNode
						node={child}
						{selectedPath}
						{onSelect}
						{onOpen}
						{onContextMenu}
					/>
				{/each}
			</ul>
		{/if}
	</li>
{:else}
	<li role="treeitem">
		<button
			class="tree-file"
			class:selected={selectedPath === node.path}
			onclick={() => { onSelect(node.path); onOpen(node.path); }}
			oncontextmenu={(e) => { e.preventDefault(); onContextMenu(node.path, e); }}
		>
			<span class="file-icon">{node.file ? fileIcon(node.file) : '📃'}</span>
			<span class="node-name">{node.name}</span>
			{#if node.file}
				<span class="file-size">{formatSize(node.file.size)}</span>
			{/if}
		</button>
	</li>
{/if}

<style>
	.tree-children {
		list-style: none;
		margin: 0;
		padding: 0;
		padding-left: var(--space-3);
	}

	.tree-folder, .tree-file {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		width: 100%;
		padding: 3px var(--space-1);
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
		color: var(--text-secondary);
		cursor: pointer;
		font-size: var(--font-size-sm);
		text-align: left;
		transition: background var(--duration-fast) var(--ease-out);
	}

	.tree-folder:hover, .tree-file:hover {
		background: var(--surface-raised);
	}

	.tree-file.selected {
		background: color-mix(in srgb, var(--accent-primary) 20%, transparent);
		color: var(--text-heading);
	}

	.folder-arrow {
		width: 12px;
		font-size: 10px;
		color: var(--text-muted);
	}

	.folder-icon, .file-icon {
		font-size: 14px;
	}

	.node-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-size {
		font-size: var(--font-size-xs);
		color: var(--text-muted);
		margin-left: auto;
		flex-shrink: 0;
	}
</style>