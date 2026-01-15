<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import ArtGraph from '$lib/components/ArtGraph.svelte';
	import LayoutSwitcher from '$lib/components/LayoutSwitcher.svelte';
	import GraphSwitcher from '$lib/components/GraphSwitcher.svelte';
	import ResourceCard from '$lib/components/ResourceCard.svelte';
	import NodeContextMenu from '$lib/components/NodeContextMenu.svelte';
	import PinnedChannelsSidebar from '$lib/components/PinnedChannelsSidebar.svelte';
	import Chat from '$lib/components/Chat.svelte';
	import { resources, graphEdges, deleteResource } from '$lib/business/store';
	import { pinnedChannels } from '$lib/socket';

	export let data: any;

	let highlightNodeId: string | null = null;
	let selectedNodeId: string | null = null;
	let currentLayout: 'community' | 'radial' | 'force-directed' | 'timeline' = 'community';
	let currentGraph: 'workspace' | 'personal' = 'workspace';

	// Workspace state
	interface Workspace {
		id: string;
		name: string;
		method: 'blank' | 'template' | 'import';
		createdAt: number;
	}
	let workspaces: Workspace[] = [];
	let currentWorkspaceId: string = 'default-workspace';

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
	let newResourceUrl = '';
	let newResourceFile: File | null = null;
	let fileInputRef: HTMLInputElement;
	let newResourceTags: string[] = [];
	let newTagInput = '';
	let tagSuggestions: string[] = [];
	let showTagSuggestions = false;

	onMount(() => {
		// Parse highlight from URL: /art?highlight=res-123
		const params = new URLSearchParams($page.url.search);
		const highlight = params.get('highlight');
		if (highlight) {
			highlightNodeId = highlight;
			selectedNodeId = highlight;
		}

		// Load workspaces from localStorage
		const savedWorkspaces = localStorage.getItem('artWorkspaces');
		if (savedWorkspaces) {
			try {
				workspaces = JSON.parse(savedWorkspaces);
			} catch (e) {
				console.error('Failed to load workspaces:', e);
				workspaces = [];
			}
		}

		// Load current workspace selection from localStorage
		const savedCurrentWorkspaceId = localStorage.getItem('currentArtWorkspaceId');
		if (savedCurrentWorkspaceId && workspaces.some(w => w.id === savedCurrentWorkspaceId)) {
			currentWorkspaceId = savedCurrentWorkspaceId;
		}
	});

	function handleLayoutChange(event: CustomEvent<{ layout: any }>) {
		currentLayout = event.detail.layout;
	}

	function handleGraphChange(event: CustomEvent<{ type: 'workspace' | 'personal' }>) {
		currentGraph = event.detail.type;
	}

	function handleCreateWorkspace(event: CustomEvent<{ name: string; method: 'blank' | 'template' | 'import' }>) {
		const { name, method } = event.detail;

		const newWorkspace: Workspace = {
			id: `workspace-${Date.now()}`,
			name,
			method,
			createdAt: Date.now()
		};

		workspaces = [...workspaces, newWorkspace];
		currentWorkspaceId = newWorkspace.id;
		currentGraph = 'workspace';

		// Save to localStorage
		localStorage.setItem('artWorkspaces', JSON.stringify(workspaces));
		localStorage.setItem('currentArtWorkspaceId', currentWorkspaceId);

		console.log('Created workspace:', newWorkspace);
	}

	// Save current workspace selection whenever it changes
	$: if (currentWorkspaceId) {
		localStorage.setItem('currentArtWorkspaceId', currentWorkspaceId);
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

	function isYouTubeUrl(url: string): boolean {
		return /(?:youtube\.com|youtu\.be)/.test(url);
	}

	function handleCreateResource() {
		if (!newResourceName.trim()) {
			alert('Please enter a resource name');
			return;
		}

		// Determine resource type based on URL if provided
		let resourceType = newResourceType;
		let externalUrl: string | undefined = undefined;
		let storageType: 'inline' | 'upload' | 'external' = 'inline';

		if (newResourceUrl.trim()) {
			externalUrl = newResourceUrl.trim();
			storageType = 'external';

			// Auto-detect YouTube URLs
			if (isYouTubeUrl(externalUrl)) {
				resourceType = 'youtube';
			} else {
				resourceType = 'url';
			}
		}

		const newResource = {
			id: `res-${Date.now()}`,
			name: newResourceName,
			type: resourceType,
			storageType: storageType,
			externalUrl: externalUrl,
			createdAt: Date.now(),
			createdBy: 'You',
			isAnonymous: false,
			tags: [],
			preview: null,
			description: undefined,
			updatedAt: Date.now()
		};

		resources.update(r => [...r, newResource]);

		// Reset form and close dialog
		newResourceName = '';
		newResourceType = 'reference';
		newResourceUrl = '';
		showCreateDialog = false;
	}

	function closeCreateDialog() {
		showCreateDialog = false;
		newResourceName = '';
		newResourceType = 'reference';
		newResourceUrl = '';
		newResourceFile = null;
		if (fileInputRef) fileInputRef.value = '';
	}

	function handleFileSelected(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (file) {
			newResourceFile = file;
			// Auto-set name if not already set
			if (!newResourceName.trim()) {
				newResourceName = file.name.replace(/\.[^/.]+$/, ''); // Remove extension
			}
		}
	}

	async function readFileAsDataUrl(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = (e) => resolve(e.target?.result as string);
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}

	// Tag management functions
	function getExistingTags(): string[] {
		// Get all unique tags from existing resources
		const allTags = new Set<string>();
		$resources.forEach(resource => {
			resource.tags?.forEach(tag => allTags.add(tag));
		});
		return Array.from(allTags).sort();
	}

	function updateTagSuggestions() {
		if (newTagInput.trim()) {
			const allTags = getExistingTags();
			const input = newTagInput.toLowerCase();
			tagSuggestions = allTags
				.filter(tag => tag.toLowerCase().includes(input) && !newResourceTags.includes(tag))
				.slice(0, 5);
			showTagSuggestions = true;
		} else {
			showTagSuggestions = false;
		}
	}

	function addTag(tag?: string) {
		const tagToAdd = (tag || newTagInput).trim().toLowerCase();
		if (tagToAdd && !newResourceTags.includes(tagToAdd)) {
			newResourceTags = [...newResourceTags, tagToAdd];
			newTagInput = '';
			tagSuggestions = [];
			showTagSuggestions = false;
		}
	}

	function removeTag(tag: string) {
		newResourceTags = newResourceTags.filter(t => t !== tag);
	}

	function handleTagInput(e: Event) {
		const input = (e.target as HTMLInputElement).value;
		newTagInput = input;
		if (input.trim()) {
			updateTagSuggestions();
		} else {
			showTagSuggestions = false;
		}
	}

	function handleTagKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			addTag();
		} else if (e.key === ',' || e.key === ' ') {
			// Allow comma or space as tag separator
			if (newTagInput.trim()) {
				e.preventDefault();
				addTag();
			}
		}
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
				<GraphSwitcher {currentGraph} on:graph-change={handleGraphChange} on:create-workspace={handleCreateWorkspace} />
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

		<!-- Chat Panel -->
		<div class="chat-panel-art">
			<Chat />
		</div>
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
					<label for="resource-url">URL (Optional)</label>
					<input
						id="resource-url"
						type="text"
						placeholder="e.g., https://youtu.be/... or https://example.com"
						bind:value={newResourceUrl}
						on:keydown={(e) => e.key === 'Enter' && handleCreateResource()}
					/>
					{#if newResourceUrl && isYouTubeUrl(newResourceUrl)}
						<small class="form-hint">🎬 YouTube link detected - will be saved as YouTube resource</small>
					{:else if newResourceUrl}
						<small class="form-hint">🔗 URL resource</small>
					{/if}
				</div>

				<div class="form-group">
					<label for="resource-type">Type (Auto-selected if URL provided)</label>
					<select id="resource-type" bind:value={newResourceType} disabled={newResourceUrl.length > 0}>
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
		background: linear-gradient(135deg, #0f0f13 0%, #1a1a1e 100%);
		color: #e0e0e0;
	}

	.art-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 20px 32px;
		background: linear-gradient(135deg, #1a1a20 0%, #232329 100%);
		border-bottom: 2px solid #6366f1;
		gap: 24px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
		backdrop-filter: blur(10px);
	}

	.header-left {
		flex: 1;
	}

	.art-header h1 {
		margin: 0 0 8px 0;
		font-size: 2rem;
		font-weight: 700;
		background: linear-gradient(135deg, #6366f1 0%, #a78bfa 100%);
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
		letter-spacing: -0.5px;
	}

	.header-controls {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
		align-items: center;
	}

	.create-btn {
		padding: 10px 20px;
		background: linear-gradient(135deg, #6366f1 0%, #7c3aed 100%);
		color: white;
		border: none;
		border-radius: 8px;
		font-size: 0.95rem;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
		box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4);
		position: relative;
		overflow: hidden;
	}

	.create-btn:hover {
		transform: translateY(-2px);
		box-shadow: 0 8px 25px rgba(99, 102, 241, 0.6);
		background: linear-gradient(135deg, #7c3aed 0%, #a78bfa 100%);
	}

	.create-btn:active {
		transform: translateY(0);
	}

	.header-stats {
		display: flex;
		gap: 20px;
	}

	.stat {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 12px 16px;
		background: rgba(99, 102, 241, 0.1);
		border-radius: 8px;
		border: 1px solid rgba(99, 102, 241, 0.3);
		backdrop-filter: blur(10px);
		transition: all 0.3s;
	}

	.stat:hover {
		background: rgba(99, 102, 241, 0.15);
		border-color: rgba(99, 102, 241, 0.5);
		transform: translateY(-2px);
	}

	.stat-label {
		font-size: 0.75rem;
		color: #a0a0a0;
		text-transform: uppercase;
		letter-spacing: 1px;
		font-weight: 600;
	}

	.stat-value {
		font-size: 2rem;
		font-weight: 700;
		background: linear-gradient(135deg, #6366f1 0%, #a78bfa 100%);
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
		margin-top: 4px;
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

	.chat-panel-art {
		width: 350px;
		flex-shrink: 0;
		background: #1e1e24;
		border-left: 1px solid #333;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.art-info {
		padding: 16px 24px;
		background: linear-gradient(135deg, #1a1a20 0%, #232329 100%);
		border-top: 1px solid rgba(99, 102, 241, 0.3);
		font-size: 0.9rem;
		color: #a0a0a0;
		text-align: center;
		box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.2);
	}

	.art-info p {
		margin: 0;
		font-weight: 500;
	}

	/* Modal Styles */
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.85);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 10001;
		backdrop-filter: blur(5px);
		animation: fadeIn 0.2s ease-out;
	}

	@keyframes fadeIn {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	@keyframes slideUp {
		from {
			transform: translateY(20px);
			opacity: 0;
		}
		to {
			transform: translateY(0);
			opacity: 1;
		}
	}

	.modal-content {
		background: linear-gradient(135deg, #1a1a20 0%, #232329 100%);
		border-radius: 16px;
		box-shadow: 0 25px 50px rgba(99, 102, 241, 0.2), 0 0 40px rgba(99, 102, 241, 0.1);
		max-width: 500px;
		width: 90%;
		overflow: hidden;
		border: 1px solid rgba(99, 102, 241, 0.3);
		animation: slideUp 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 24px;
		border-bottom: 1px solid rgba(99, 102, 241, 0.2);
		background: linear-gradient(135deg, rgba(99, 102, 241, 0.1) 0%, transparent 100%);
	}

	.modal-header h2 {
		margin: 0;
		font-size: 1.5rem;
		font-weight: 700;
		background: linear-gradient(135deg, #6366f1 0%, #a78bfa 100%);
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	.close-btn {
		background: rgba(99, 102, 241, 0.2);
		border: none;
		color: #a0a0a0;
		font-size: 1.5rem;
		cursor: pointer;
		padding: 8px;
		width: 40px;
		height: 40px;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.3s;
		border-radius: 8px;
	}

	.close-btn:hover {
		background: rgba(99, 102, 241, 0.4);
		color: #e0e0e0;
		transform: rotate(90deg);
	}

	.modal-body {
		padding: 24px;
	}

	.form-group {
		margin-bottom: 20px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.form-group label {
		font-size: 0.95rem;
		color: #a78bfa;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.form-group input,
	.form-group select {
		padding: 12px 14px;
		background: rgba(99, 102, 241, 0.05);
		border: 2px solid rgba(99, 102, 241, 0.2);
		border-radius: 8px;
		color: #e0e0e0;
		font-size: 0.95rem;
		font-family: inherit;
		transition: all 0.3s;
	}

	.form-group input:focus,
	.form-group select:focus {
		outline: none;
		border-color: #6366f1;
		background: rgba(99, 102, 241, 0.1);
		box-shadow: 0 0 20px rgba(99, 102, 241, 0.3);
	}

	.form-group input::placeholder {
		color: #666;
	}

	.form-group input:disabled,
	.form-group select:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.form-hint {
		display: block;
		margin-top: 6px;
		font-size: 0.85rem;
		color: #a0a0a0;
		font-style: italic;
	}

	.modal-footer {
		display: flex;
		gap: 12px;
		padding: 20px 24px;
		border-top: 1px solid rgba(99, 102, 241, 0.2);
		justify-content: flex-end;
		background: rgba(99, 102, 241, 0.03);
	}

	.btn-cancel,
	.btn-create {
		padding: 12px 24px;
		border-radius: 8px;
		border: none;
		font-size: 0.95rem;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
	}

	.btn-cancel {
		background: rgba(99, 102, 241, 0.1);
		color: #a0a0a0;
		border: 1px solid rgba(99, 102, 241, 0.2);
	}

	.btn-cancel:hover {
		background: rgba(99, 102, 241, 0.2);
		color: #e0e0e0;
		transform: translateY(-2px);
	}

	.btn-create {
		background: linear-gradient(135deg, #6366f1 0%, #7c3aed 100%);
		color: white;
		box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4);
	}

	.btn-create:hover {
		transform: translateY(-2px);
		box-shadow: 0 8px 25px rgba(99, 102, 241, 0.6);
		background: linear-gradient(135deg, #7c3aed 0%, #a78bfa 100%);
	}

	.btn-create:active {
		transform: translateY(0);
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
