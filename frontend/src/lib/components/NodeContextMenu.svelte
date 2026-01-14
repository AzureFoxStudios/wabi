<script lang="ts">
	export let x: number = 0;
	export let y: number = 0;
	export let visible: boolean = false;
	export let nodeId: string | null = null;
	export let nodeLabel: string = '';
	export let onClose: () => void = () => {};
	export let onEdit: (id: string) => void = () => {};
	export let onDelete: (id: string) => void = () => {};
	export let onCopyLink: (id: string) => void = () => {};

	function handleClickOutside(e: MouseEvent) {
		const menu = document.querySelector('.node-context-menu');
		if (menu && !menu.contains(e.target as Node)) {
			onClose();
		}
	}

	function handleEdit() {
		if (nodeId) onEdit(nodeId);
		onClose();
	}

	function handleDelete() {
		if (nodeId && confirm(`Delete "${nodeLabel}"?`)) {
			onDelete(nodeId);
		}
		onClose();
	}

	function handleCopyLink() {
		if (nodeId) onCopyLink(nodeId);
		onClose();
	}
</script>

<svelte:window on:click={handleClickOutside} />

{#if visible && nodeId}
	<div class="node-context-menu" style="left: {x}px; top: {y}px;">
		<button class="menu-item" on:click={handleEdit}>
			✏️ Edit
		</button>
		<button class="menu-item" on:click={handleCopyLink}>
			🔗 Copy Link
		</button>
		<div class="menu-divider"></div>
		<button class="menu-item danger" on:click={handleDelete}>
			🗑️ Delete
		</button>
	</div>
{/if}

<style>
	.node-context-menu {
		position: fixed;
		background: #2a2a2e;
		border: 1px solid #444;
		border-radius: 8px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
		z-index: 10000;
		min-width: 160px;
		overflow: hidden;
	}

	.menu-item {
		display: block;
		width: 100%;
		padding: 10px 16px;
		background: transparent;
		border: none;
		color: #e0e0e0;
		text-align: left;
		cursor: pointer;
		font-size: 0.9rem;
		transition: background 0.15s;
	}

	.menu-item:hover {
		background: #3a3a3e;
		color: #fff;
	}

	.menu-item.danger:hover {
		background: #ef4444;
		color: white;
	}

	.menu-divider {
		height: 1px;
		background: #444;
		margin: 4px 0;
	}
</style>
