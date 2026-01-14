<script lang="ts">
	import { createEventDispatcher } from 'svelte';

	export let currentLayout: 'community' | 'radial' | 'force-directed' | 'timeline' = 'community';

	const dispatch = createEventDispatcher();

	type Layout = 'community' | 'radial' | 'force-directed' | 'timeline';

	const layouts = [
		{ id: 'community', label: '🗂️ Communities', description: 'Grouped by tags' },
		{ id: 'radial', label: '🔘 Radial', description: 'Mind map style' },
		{ id: 'force-directed', label: '🧲 Force-Directed', description: 'Physics-based' },
		{ id: 'timeline', label: '📅 Timeline', description: 'By creation date' }
	];

	function selectLayout(layoutId: Layout) {
		currentLayout = layoutId;
		dispatch('layout-change', { layout: layoutId });
	}
</script>

<div class="layout-switcher">
	{#each layouts as layout}
		<button
			class="layout-btn {currentLayout === layout.id ? 'active' : ''}"
			onclick={() => selectLayout(layout.id)}
			title={layout.description}>
			{layout.label}
		</button>
	{/each}
</div>

<style>
	.layout-switcher {
		display: flex;
		gap: 8px;
		padding: 8px;
		background: #2a2a2e;
		border-radius: 8px;
	}

	.layout-btn {
		padding: 8px 16px;
		background: transparent;
		border: 1px solid #444;
		border-radius: 4px;
		color: #fff;
		cursor: pointer;
		transition: all 0.2s;
		font-family: inherit;
		font-size: 14px;
	}

	.layout-btn:hover {
		background: #3a3a3e;
		border-color: #6366f1;
	}

	.layout-btn.active {
		background: #6366f1;
		border-color: #6366f1;
		font-weight: bold;
	}
</style>
