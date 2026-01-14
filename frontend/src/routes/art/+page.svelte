<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import ArtGraph from '$lib/components/ArtGraph.svelte';
	import LayoutSwitcher from '$lib/components/LayoutSwitcher.svelte';
	import GraphSwitcher from '$lib/components/GraphSwitcher.svelte';
	import ResourceCard from '$lib/components/ResourceCard.svelte';
	import { resources, graphEdges } from '$lib/business/store';

	export let data: any;

	let highlightNodeId: string | null = null;
	let selectedNodeId: string | null = null;
	let currentLayout: 'community' | 'radial' | 'force-directed' | 'timeline' = 'community';
	let currentGraph: 'workspace' | 'personal' = 'workspace';

	onMount(() => {
		// Parse highlight from URL: /art?highlight=res-123
		const params = new URLSearchParams($page.url.search);
		const highlight = params.get('highlight');
		if (highlight) {
			highlightNodeId = highlight;
			selectedNodeId = highlight;
		}
	});

	function handleLayoutChange(event: CustomEvent<{ layout: any }>) {
		currentLayout = event.detail.layout;
	}

	function handleGraphSwitch(graphType: 'workspace' | 'personal') {
		currentGraph = graphType;
	}

	function handleNodeSelect(nodeId: string) {
		selectedNodeId = nodeId;
	}
</script>

<div class="art-page">
	<!-- Header -->
	<div class="art-header">
		<div class="header-left">
			<h1>🎨 Art Resource Graph</h1>
			<div class="header-controls">
				<LayoutSwitcher on:layout-change={handleLayoutChange} />
				<GraphSwitcher {currentGraph} onSwitch={handleGraphSwitch} />
			</div>
		</div>
		<div class="header-stats">
			<div class="stat">
				<span class="stat-label">Resources</span>
				<span class="stat-value">{$resources.length}</span>
			</div>
			<div class="stat">
				<span class="stat-label">Connections</span>
				<span class="stat-value">{$graphEdges.length}</span>
			</div>
		</div>
	</div>

	<!-- Main Content -->
	<div class="art-content">
		<!-- Graph Canvas -->
		<div class="graph-container">
			<ArtGraph
				bind:highlightNodeId
				{currentLayout}
				on:node-select={(e) => handleNodeSelect(e.detail)}
			/>
		</div>

		<!-- Resource Detail Panel -->
		{#if selectedNodeId}
			<div class="resource-panel">
				<ResourceCard resourceId={selectedNodeId} />
			</div>
		{/if}
	</div>

	<!-- Help Info -->
	<div class="art-info">
		<p>💡 Click nodes to view details • Right-click for options • Use layout switcher to change view</p>
	</div>
</div>

<style>
	.art-page {
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100vh;
		background: #1a1a1e;
		color: #e0e0e0;
	}

	.art-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 16px 24px;
		background: #2a2a2e;
		border-bottom: 1px solid #333;
		gap: 24px;
	}

	.header-left {
		flex: 1;
	}

	.art-header h1 {
		margin: 0 0 12px 0;
		font-size: 1.8rem;
		color: #fff;
	}

	.header-controls {
		display: flex;
		gap: 16px;
		flex-wrap: wrap;
	}

	.header-stats {
		display: flex;
		gap: 24px;
	}

	.stat {
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.stat-label {
		font-size: 0.8rem;
		color: #a0a0a0;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.stat-value {
		font-size: 1.8rem;
		font-weight: bold;
		color: #6366f1;
	}

	.art-content {
		display: flex;
		flex: 1;
		overflow: hidden;
		gap: 0;
	}

	.graph-container {
		flex: 1;
		min-width: 0;
		background: #1a1a1e;
		overflow: hidden;
		position: relative;
	}

	.resource-panel {
		width: 400px;
		background: #1e1e24;
		border-left: 1px solid #333;
		overflow-y: auto;
		padding: 0;
	}

	.art-info {
		padding: 12px 24px;
		background: #2a2a2e;
		border-top: 1px solid #333;
		font-size: 0.9rem;
		color: #a0a0a0;
		text-align: center;
	}

	.art-info p {
		margin: 0;
	}

	@media (max-width: 1024px) {
		.art-header {
			flex-direction: column;
			align-items: flex-start;
		}

		.header-stats {
			width: 100%;
			justify-content: flex-start;
		}

		.resource-panel {
			width: 350px;
		}
	}

	@media (max-width: 768px) {
		.art-content {
			flex-direction: column;
		}

		.resource-panel {
			width: 100%;
			height: 40%;
			border-left: none;
			border-top: 1px solid #333;
		}

		.graph-container {
			flex: 1;
		}
	}
</style>
