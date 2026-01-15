<script lang="ts">
	import { createEventDispatcher } from 'svelte';

	export let currentLayout: 'community' | 'radial' | 'force-directed' | 'timeline' = 'community';

	const dispatch = createEventDispatcher();

	type Layout = 'community' | 'radial' | 'force-directed' | 'timeline';

	let hoveredLayout: Layout | null = null;

	const layouts = [
		{
			id: 'community',
			label: '🗂️ Communities',
			description: 'Grouped by tags',
			fullDescription: 'Groups resources by their tags/categories. Resources with similar tags cluster together, making it easy to see thematic relationships.'
		},
		{
			id: 'radial',
			label: '🔘 Radial',
			description: 'Mind map style',
			fullDescription: 'Radial layout spreads resources from the center outward like a mind map. Great for seeing hierarchical or central relationships.'
		},
		{
			id: 'force-directed',
			label: '🧲 Force-Directed',
			description: 'Physics-based',
			fullDescription: 'Physics simulation where resources repel each other and connections pull them together. Naturally reveals dense clusters and isolated items.'
		},
		{
			id: 'timeline',
			label: '📅 Timeline',
			description: 'By creation date',
			fullDescription: 'Arranges resources chronologically from oldest to newest. Perfect for visualizing your learning journey and content evolution over time.'
		}
	];

	function selectLayout(layoutId: Layout) {
		currentLayout = layoutId;
		dispatch('layout-change', { layout: layoutId });
	}
</script>

<div class="layout-switcher">
	{#each layouts as layout}
		<div class="layout-btn-wrapper" on:mouseenter={() => hoveredLayout = layout.id} on:mouseleave={() => hoveredLayout = null}>
			<button
				class="layout-btn {currentLayout === layout.id ? 'active' : ''}"
				on:click={() => selectLayout(layout.id)}
				title={layout.description}>
				{layout.label}
			</button>
			{#if hoveredLayout === layout.id}
				<div class="layout-tooltip">
					<div class="tooltip-title">{layout.label}</div>
					<div class="tooltip-description">{layout.fullDescription}</div>
				</div>
			{/if}
		</div>
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

	.layout-btn-wrapper {
		position: relative;
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

	/* Tooltip Styles */
	.layout-tooltip {
		position: absolute;
		bottom: 100%;
		left: 50%;
		transform: translateX(-50%);
		margin-bottom: 12px;
		padding: 12px 16px;
		background: rgba(15, 15, 19, 0.98);
		border: 2px solid #6366f1;
		border-radius: 8px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 0 20px rgba(99, 102, 241, 0.3);
		z-index: 1000;
		min-width: 200px;
		max-width: 250px;
		backdrop-filter: blur(10px);
		white-space: normal;
		animation: tooltipFade 0.2s ease-out;
	}

	.layout-tooltip::after {
		content: '';
		position: absolute;
		top: 100%;
		left: 50%;
		transform: translateX(-50%);
		width: 0;
		height: 0;
		border-left: 6px solid transparent;
		border-right: 6px solid transparent;
		border-top: 8px solid #6366f1;
	}

	.tooltip-title {
		font-weight: 700;
		color: #6366f1;
		font-size: 0.95rem;
		margin-bottom: 6px;
	}

	.tooltip-description {
		color: #a0a0a0;
		font-size: 0.85rem;
		line-height: 1.5;
	}

	@keyframes tooltipFade {
		from {
			opacity: 0;
			transform: translateX(-50%) translateY(4px);
		}
		to {
			opacity: 1;
			transform: translateX(-50%) translateY(0);
		}
	}
</style>
