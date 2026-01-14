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

	// Create resource state
	let showCreateDialog = false;
	let newResourceName = '';
	let newResourceType = 'reference';

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

	function handleCreateResource() {
		if (!newResourceName.trim()) {
			alert('Please enter a resource name');
			return;
		}

		const newResource = {
			id: `res-${Date.now()}`,
			name: newResourceName,
			type: newResourceType,
			createdAt: new Date().toISOString(),
			createdBy: 'You',
			isAnonymous: false,
			tags: [],
			preview: null
		};

		resources.update(r => [...r, newResource]);

		// Reset form and close dialog
		newResourceName = '';
		newResourceType = 'reference';
		showCreateDialog = false;
	}

	function closeCreateDialog() {
		showCreateDialog = false;
		newResourceName = '';
		newResourceType = 'reference';
	}
</script>

<div class="art-page">
	<!-- Header -->
	<div class="art-header">
		<div class="header-left">
			<h1>🎨 Art Resource Graph</h1>
			<div class="header-controls">
				<button class="create-btn" on:click={() => showCreateDialog = true} title="Create a new resource">
					➕ New Resource
				</button>
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

<!-- Create Resource Dialog -->
{#if showCreateDialog}
	<div class="modal-overlay" on:click={closeCreateDialog}>
		<div class="modal-content" on:click|stopPropagation>
			<div class="modal-header">
				<h2>➕ Create New Resource</h2>
				<button class="close-btn" on:click={closeCreateDialog}>✕</button>
			</div>

			<div class="modal-body">
				<div class="form-group">
					<label for="resource-name">Resource Name</label>
					<input
						id="resource-name"
						type="text"
						placeholder="e.g., Design Inspiration Board"
						bind:value={newResourceName}
						on:keydown={(e) => e.key === 'Enter' && handleCreateResource()}
					/>
				</div>

				<div class="form-group">
					<label for="resource-type">Type</label>
					<select id="resource-type" bind:value={newResourceType}>
						<option value="reference">Reference Material</option>
						<option value="tutorial">Tutorial</option>
						<option value="inspiration">Inspiration</option>
						<option value="project">Project File</option>
						<option value="tool">Tool/Software</option>
						<option value="other">Other</option>
					</select>
				</div>
			</div>

			<div class="modal-footer">
				<button class="btn-cancel" on:click={closeCreateDialog}>Cancel</button>
				<button class="btn-create" on:click={handleCreateResource}>Create Resource</button>
			</div>
		</div>
	</div>
{/if}

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
		align-items: center;
	}

	.create-btn {
		padding: 8px 16px;
		background: #6366f1;
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 0.9rem;
		font-weight: 500;
		cursor: pointer;
		transition: background 0.2s;
	}

	.create-btn:hover {
		background: #4f46e5;
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

	/* Modal Styles */
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.7);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 10001;
	}

	.modal-content {
		background: #2a2a2e;
		border-radius: 12px;
		box-shadow: 0 20px 25px rgba(0, 0, 0, 0.4);
		max-width: 500px;
		width: 90%;
		overflow: hidden;
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 20px;
		border-bottom: 1px solid #333;
	}

	.modal-header h2 {
		margin: 0;
		font-size: 1.3rem;
		color: #e0e0e0;
	}

	.close-btn {
		background: transparent;
		border: none;
		color: #a0a0a0;
		font-size: 1.5rem;
		cursor: pointer;
		padding: 0;
		width: 30px;
		height: 30px;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: color 0.2s;
	}

	.close-btn:hover {
		color: #e0e0e0;
	}

	.modal-body {
		padding: 20px;
	}

	.form-group {
		margin-bottom: 16px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.form-group label {
		font-size: 0.9rem;
		color: #a0a0a0;
		font-weight: 500;
	}

	.form-group input,
	.form-group select {
		padding: 10px 12px;
		background: #1e1e24;
		border: 1px solid #333;
		border-radius: 6px;
		color: #e0e0e0;
		font-size: 0.95rem;
		font-family: inherit;
	}

	.form-group input:focus,
	.form-group select:focus {
		outline: none;
		border-color: #6366f1;
		box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
	}

	.modal-footer {
		display: flex;
		gap: 12px;
		padding: 16px 20px;
		border-top: 1px solid #333;
		justify-content: flex-end;
	}

	.btn-cancel,
	.btn-create {
		padding: 10px 20px;
		border-radius: 6px;
		border: none;
		font-size: 0.9rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
	}

	.btn-cancel {
		background: #3a3a3e;
		color: #e0e0e0;
	}

	.btn-cancel:hover {
		background: #4a4a4e;
	}

	.btn-create {
		background: #6366f1;
		color: white;
	}

	.btn-create:hover {
		background: #4f46e5;
	}

	@media (max-width: 1024px) {
		.art-header {
			flex-direction: column;
			align-items: flex-start;
			gap: 12px;
		}

		.header-controls {
			gap: 12px;
		}

		.header-stats {
			width: 100%;
			justify-content: flex-start;
		}

		.resource-panel {
			width: 350px;
		}

		.create-btn {
			padding: 6px 12px;
			font-size: 0.85rem;
		}
	}

	@media (max-width: 768px) {
		.art-page {
			height: 100vh;
		}

		.art-header {
			flex-direction: column;
			align-items: flex-start;
			padding: 12px 16px;
			gap: 12px;
		}

		.art-header h1 {
			font-size: 1.4rem;
		}

		.header-controls {
			flex-direction: column;
			width: 100%;
			gap: 8px;
		}

		.create-btn {
			width: 100%;
			padding: 10px 12px;
			font-size: 0.85rem;
		}

		.header-stats {
			flex-wrap: wrap;
			gap: 16px;
			width: 100%;
		}

		.art-content {
			flex-direction: column;
		}

		.pinned-sidebar-wrapper {
			height: 150px;
			width: 100%;
			overflow-y: auto;
			border-bottom: 1px solid #333;
		}

		.resource-panel {
			width: 100%;
			height: 35%;
			border-left: none;
			border-top: 1px solid #333;
		}

		.graph-container {
			flex: 1;
		}

		.art-info {
			padding: 8px 12px;
			font-size: 0.8rem;
		}

		.modal-content {
			width: 95%;
			max-width: 450px;
		}
	}

	@media (max-width: 480px) {
		.art-header {
			padding: 8px 12px;
		}

		.art-header h1 {
			font-size: 1.1rem;
		}

		.header-controls {
			gap: 6px;
		}

		.create-btn {
			width: 100%;
			padding: 8px 10px;
			font-size: 0.8rem;
		}

		.header-stats {
			gap: 12px;
		}

		.stat {
			min-width: 45px;
		}

		.stat-label {
			font-size: 0.6rem;
		}

		.stat-value {
			font-size: 1.2rem;
		}

		.pinned-sidebar-wrapper {
			height: 120px;
		}

		.resource-panel {
			height: 30%;
		}

		.art-info {
			padding: 6px 10px;
			font-size: 0.75rem;
		}

		.modal-content {
			width: 98%;
		}

		.modal-header {
			padding: 16px;
		}

		.modal-body {
			padding: 16px;
		}

		.modal-footer {
			padding: 12px 16px;
			gap: 8px;
		}

		.btn-cancel,
		.btn-create {
			padding: 8px 16px;
			font-size: 0.85rem;
		}
	}
</style>
