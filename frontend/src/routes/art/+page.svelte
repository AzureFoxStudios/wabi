<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import ArtGraph from '$lib/components/ArtGraph.svelte';
	import LayoutSwitcher from '$lib/components/LayoutSwitcher.svelte';
	import GraphSwitcher from '$lib/components/GraphSwitcher.svelte';
	import ResourceCard from '$lib/components/ResourceCard.svelte';
	import NodeContextMenu from '$lib/components/NodeContextMenu.svelte';
	import PinnedChannelsSidebar from '$lib/components/PinnedChannelsSidebar.svelte';
	import { resources, graphEdges, deleteResource } from '$lib/business/store';
	import { pinnedChannels } from '$lib/socket';

	export let data: any;

	let highlightNodeId: string | null = null;
	let selectedNodeId: string | null = null;
	let currentLayout: 'community' | 'radial' | 'force-directed' | 'timeline' = 'community';
	let currentGraph: 'workspace' | 'personal' = 'workspace';

	// Context menu state
	let contextMenuVisible = false;
	let contextMenuX = 0;
	let contextMenuY = 0;
	let contextMenuNodeId: string | null = null;
	let contextMenuNodeLabel = '';

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

	function handleNodeContextMenu(event: CustomEvent<{ nodeId: string; x: number; y: number; label: string }>) {
		contextMenuNodeId = event.detail.nodeId;
		contextMenuNodeLabel = event.detail.label;
		contextMenuX = event.detail.x;
		contextMenuY = event.detail.y;
		contextMenuVisible = true;
	}

	function handleEditResource(nodeId: string) {
		// TODO: Open edit dialog for resource
		console.log('Edit resource:', nodeId);
	}

	function handleDeleteResource(nodeId: string) {
		deleteResource(nodeId);
		selectedNodeId = null;
	}

	function handleCopyResourceLink(nodeId: string) {
		const url = `${window.location.origin}/art?highlight=${nodeId}`;
		navigator.clipboard.writeText(url);
		alert('Link copied to clipboard!');
	}

	function closeContextMenu() {
		contextMenuVisible = false;
		contextMenuNodeId = null;
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
		<!-- Pinned Channels Sidebar -->
		{#if $pinnedChannels.length > 0}
			<div class="pinned-sidebar-wrapper">
				<PinnedChannelsSidebar />
			</div>
		{/if}

		<!-- Graph Canvas -->
		<div class="graph-container">
			<ArtGraph
				bind:highlightNodeId
				{currentLayout}
				on:node-select={(e) => handleNodeSelect(e.detail)}
				on:node-context-menu={handleNodeContextMenu}
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

<!-- Context Menu -->
<NodeContextMenu
	visible={contextMenuVisible}
	x={contextMenuX}
	y={contextMenuY}
	nodeId={contextMenuNodeId}
	nodeLabel={contextMenuNodeLabel}
	onClose={closeContextMenu}
	onEdit={handleEditResource}
	onDelete={handleDeleteResource}
	onCopyLink={handleCopyResourceLink}
/>

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

	.pinned-sidebar-wrapper {
		flex-shrink: 0;
		overflow: hidden;
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

		.pinned-sidebar-wrapper {
			height: 200px;
			width: 100%;
			overflow-y: auto;
			border-bottom: 1px solid #333;
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
