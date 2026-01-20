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
	import { pinnedChannels, channels, currentChannel, joinChannel } from '$lib/socket';

	export let data: any;

	let highlightNodeId: string | null = null;
	let selectedNodeId: string | null = null;
	let forceEditMode = false;
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

	// Chat panel state
	let showChatPanel = true;
	let chatPanelExpanded = false;

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
		if (event?.detail?.type) {
			currentGraph = event.detail.type;
		}
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

	// Save current workspace selection whenever it changes (only in browser)
	$: if (typeof window !== 'undefined' && currentWorkspaceId) {
		localStorage.setItem('currentArtWorkspaceId', currentWorkspaceId);
	}

	function toggleChatPanel() {
		showChatPanel = !showChatPanel;
	}

	function toggleChatExpanded() {
		chatPanelExpanded = !chatPanelExpanded;
	}

	function handleChatChannelSwitch(channelId: string) {
		if (channelId) {
			joinChannel(channelId);
		}
	}

	function handleNodeSelect(nodeId: string) {
		selectedNodeId = nodeId;
		forceEditMode = false;
	}

	function handleNodeContextMenu(event: CustomEvent<{ nodeId: string; x: number; y: number; label: string }>) {
		try {
			if (event?.detail) {
				contextMenuNodeId = event.detail.nodeId;
				contextMenuNodeLabel = event.detail.label;
				contextMenuX = event.detail.x;
				contextMenuY = event.detail.y;
				contextMenuVisible = true;
			}
		} catch (error) {
			console.error('Error handling node context menu:', error);
		}
	}

	function handleEditResource(nodeId: string) {
		selectedNodeId = nodeId;
		forceEditMode = true;
		contextMenuVisible = false;
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

	function centerGraph() {
		// Fit all nodes in view - dispatch to ArtGraph or use fitView if available
		const graphElement = document.querySelector('.svelte-flow__viewport');
		if (graphElement && window && typeof window !== 'undefined') {
			// Try to fit the view to all nodes
			const event = new CustomEvent('fit-view');
			document.querySelector('.art-graph')?.dispatchEvent(event);
		}
	}

	function isYouTubeUrl(url: string): boolean {
		return /(?:youtube\.com|youtu\.be)/.test(url);
	}

	async function handleCreateResource() {
		try {
			if (!newResourceName.trim()) {
				alert('Please enter a resource name');
				return;
			}

		// Verify tags are present before creating resource
		console.log('Creating resource with tags:', newResourceTags);

		// Determine resource type based on URL if provided
		let resourceType = newResourceType;
		let externalUrl: string | undefined = undefined;
		let fileUrl: string | undefined = undefined;
		let preview: string | null = null;
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

		// Handle file upload
		if (newResourceFile) {
			const fileDataUrl = await readFileAsDataUrl(newResourceFile);
			fileUrl = fileDataUrl;
			storageType = 'inline';

			// Auto-detect resource type from MIME type
			const mimeType = newResourceFile.type || '';
			if (mimeType.startsWith('image/')) {
				resourceType = 'image';
				preview = fileDataUrl;
			} else if (mimeType.startsWith('video/')) {
				resourceType = 'video';
			} else if (mimeType.startsWith('audio/')) {
				resourceType = 'audio';
			} else if (mimeType.includes('pdf')) {
				resourceType = 'file';
			} else {
				resourceType = 'file';
			}
		}

		const newResource = {
			id: `res-${Date.now()}`,
			name: newResourceName,
			type: resourceType,
			storageType: storageType,
			externalUrl: externalUrl,
			fileUrl: fileUrl,
			createdAt: Date.now(),
			createdBy: 'You',
			isAnonymous: false,
			tags: newResourceTags,
			preview: preview,
			description: undefined,
			updatedAt: Date.now()
		};

		resources.update(r => [...r, newResource]);

			// Reset form and close dialog
			newResourceName = '';
			newResourceType = 'reference';
			newResourceUrl = '';
			newResourceFile = null;
			newResourceTags = [];
			newTagInput = '';
			if (fileInputRef) fileInputRef.value = '';
			showCreateDialog = false;
		} catch (error) {
			console.error('Error creating resource:', error);
			alert('Failed to create resource. Check the console for details.');
		}
	}

	function closeCreateDialog() {
		showCreateDialog = false;
		newResourceName = '';
		newResourceType = 'reference';
		newResourceUrl = '';
		newResourceFile = null;
		newResourceTags = [];
		newTagInput = '';
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
		<h1>🎨 Art Resource Graph</h1>
		<button class="create-btn" on:click={() => showCreateDialog = true} title="Create a new resource">
			➕ New Resource
		</button>
		<GraphSwitcher {currentGraph} on:graph-change={handleGraphChange} on:create-workspace={handleCreateWorkspace} />
		<div class="header-spacer"></div>
		<button class="center-btn" on:click={() => centerGraph()} title="Center all resources">
			🎯 Center
		</button>
		<div class="header-stats">
			<span class="stat-inline">Resources: <strong>{$resources.length}</strong></span>
			<span class="stat-inline">Connections: <strong>{$graphEdges.length}</strong></span>
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
				on:node-edit={(e) => handleEditResource(e.detail)}
				on:node-context-menu={handleNodeContextMenu}
			/>
		</div>

		<!-- Resource Detail Panel -->
		{#if selectedNodeId}
			<div class="resource-panel">
				<ResourceCard resourceId={selectedNodeId} {forceEditMode} />
			</div>
		{/if}

		<!-- Chat Panel -->
		{#if showChatPanel}
			<div class="chat-panel-art" class:expanded={chatPanelExpanded}>
				<div class="chat-header">
					<div class="chat-title">
						{#if chatPanelExpanded}
							💬 Conversations
						{:else}
							{$channels.find(ch => ch.id === $currentChannel)?.name || 'Chat'}
						{/if}
					</div>
					<div class="chat-controls">
						<button class="chat-btn" on:click={toggleChatExpanded} title={chatPanelExpanded ? 'Show chat' : 'Show channels'}>
							{chatPanelExpanded ? '💬' : '👀'}
						</button>
						<button class="chat-btn" on:click={toggleChatPanel} title="Toggle chat panel">
							✕
						</button>
					</div>
				</div>

				{#if chatPanelExpanded}
					<!-- Channel/DM List -->
					<div class="chat-list">
						{#if $channels.length > 0}
							{#each $channels as channel (channel.id)}
								{#if channel}
									<button
										class="chat-list-item"
										class:active={$currentChannel === channel.id}
										on:click={() => handleChatChannelSwitch(channel.id)}
										title={channel.name}
									>
										<span class="chat-icon">
											{#if channel.type === 'dm'}
												👤
											{:else if channel.type === 'group'}
												👥
											{:else}
												#
											{/if}
										</span>
										<span class="chat-name">{channel.name}</span>
									</button>
								{/if}
							{/each}
						{:else}
							<div class="empty-list">No channels available</div>
						{/if}
					</div>
				{:else}
					<!-- Chat View -->
					<div class="chat-view">
						<Chat />
					</div>
				{/if}
			</div>
		{:else}
			<!-- Collapsed Chat Button -->
			<button class="chat-toggle-btn" on:click={toggleChatPanel} title="Open chat">
				💬
			</button>
		{/if}
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
	<div
		class="modal-overlay"
		role="button"
		tabindex="0"
		on:click={closeCreateDialog}
		on:keydown={(event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				closeCreateDialog();
			}
		}}
	>
		<div
			class="modal-content"
			role="button"
			tabindex="0"
			on:click|stopPropagation
			on:keydown|stopPropagation={(event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
				}
			}}
		>
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
					<label for="resource-file">Upload File (Optional)</label>
					<input
						id="resource-file"
						type="file"
						accept="image/*,video/*,audio/*,.pdf,.txt"
						bind:this={fileInputRef}
						on:change={handleFileSelected}
					/>
					{#if newResourceFile}
						<small class="form-hint">📎 {newResourceFile.name} selected</small>
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

				<div class="form-group">
					<label for="resource-tags">Tags (Optional)</label>
					<input
						id="resource-tags"
						type="text"
						placeholder="e.g., design, inspiration (press Enter or comma to add)"
						bind:value={newTagInput}
						on:input={handleTagInput}
						on:keydown={handleTagKeydown}
					/>
					{#if showTagSuggestions && tagSuggestions.length > 0}
						<div class="tag-suggestions">
							{#each tagSuggestions as suggestion}
								<button
									type="button"
									class="tag-suggestion"
									on:click={() => addTag(suggestion)}
								>
									#{suggestion}
								</button>
							{/each}
						</div>
					{/if}
					{#if newResourceTags.length > 0}
						<div class="selected-tags">
							{#each newResourceTags as tag}
								<span class="tag-chip">
									#{tag}
									<button type="button" class="remove-tag" on:click={() => removeTag(tag)}>✕</button>
								</span>
							{/each}
						</div>
					{/if}
				</div>
			</div>
		</div>

		<div class="modal-footer">
			<button class="btn-cancel" on:click={closeCreateDialog}>Cancel</button>
			<button class="btn-create" on:click={handleCreateResource}>Create Resource</button>
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
		justify-content: flex-start;
		align-items: center;
		padding: 6px 12px;
		background: linear-gradient(135deg, #1a1a20 0%, #232329 100%);
		border-bottom: 2px solid #6366f1;
		gap: 8px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
		backdrop-filter: blur(10px);
		flex-wrap: nowrap;
	}

	.art-header h1 {
		margin: 0;
		font-size: 1rem;
		font-weight: 700;
		background: linear-gradient(135deg, #6366f1 0%, #a78bfa 100%);
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
		letter-spacing: -0.5px;
		line-height: 1.4;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.create-btn,
	.center-btn {
		padding: 4px 10px;
		background: linear-gradient(135deg, #6366f1 0%, #7c3aed 100%);
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 0.75rem;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s;
		box-shadow: 0 2px 8px rgba(99, 102, 241, 0.4);
		position: relative;
		overflow: hidden;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.create-btn:hover,
	.center-btn:hover {
		transform: translateY(-2px);
		box-shadow: 0 8px 25px rgba(99, 102, 241, 0.6);
		background: linear-gradient(135deg, #7c3aed 0%, #a78bfa 100%);
	}

	.create-btn:active,
	.center-btn:active {
		transform: translateY(0);
	}

	.header-spacer {
		flex: 1;
		min-width: 20px;
	}

	.header-stats {
		display: flex;
		gap: 12px;
		flex-shrink: 0;
	}

	.stat-inline {
		font-size: 0.8rem;
		color: #a0a0a0;
		white-space: nowrap;
	}

	.stat-inline strong {
		color: #6366f1;
		font-weight: 700;
		margin-left: 2px;
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
		position: relative;
	}

	.chat-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px;
		border-bottom: 1px solid #333;
		background: #2a2a2e;
		flex-shrink: 0;
	}

	.chat-title {
		font-weight: 600;
		font-size: 0.9rem;
		color: #e0e0e0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chat-controls {
		display: flex;
		gap: 4px;
		flex-shrink: 0;
	}

	.chat-btn {
		background: transparent;
		border: none;
		color: #a0a0a0;
		cursor: pointer;
		font-size: 1rem;
		padding: 4px 8px;
		border-radius: 4px;
		transition: all 0.15s;
	}

	.chat-btn:hover {
		background: rgba(99, 102, 241, 0.2);
		color: #e0e0e0;
	}

	.chat-list {
		flex: 1;
		overflow-y: auto;
		padding: 8px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.chat-list-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		background: #2a2a2e;
		border: 1px solid #333;
		border-radius: 6px;
		color: #a0a0a0;
		cursor: pointer;
		font-size: 0.9rem;
		transition: all 0.15s;
		white-space: nowrap;
		overflow: hidden;
		text-align: left;
		font-family: inherit;
	}

	.chat-list-item:hover {
		background: #3a3a3e;
		color: #e0e0e0;
		border-color: #444;
	}

	.chat-list-item.active {
		background: #6366f1;
		color: white;
		border-color: #6366f1;
	}

	.chat-icon {
		flex-shrink: 0;
		font-size: 1rem;
	}

	.chat-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chat-view {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.empty-list {
		padding: 20px 12px;
		text-align: center;
		color: #808080;
		font-size: 0.85rem;
	}

	.chat-toggle-btn {
		position: fixed;
		bottom: 24px;
		right: 12px;
		width: 48px;
		height: 48px;
		border-radius: 50%;
		background: #6366f1;
		border: none;
		color: white;
		font-size: 1.5rem;
		cursor: pointer;
		box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
		transition: all 0.2s;
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 500;
	}

	.chat-toggle-btn:hover {
		background: #7c3aed;
		transform: scale(1.1);
		box-shadow: 0 6px 16px rgba(99, 102, 241, 0.6);
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
		flex-direction: column;
		align-items: center;
		justify-content: center;
		z-index: 10001;
		backdrop-filter: blur(5px);
		animation: fadeIn 0.2s ease-out;
		padding: 20px;
		gap: 0;
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
		border-radius: 12px 12px 0 0;
		box-shadow: 0 25px 50px rgba(99, 102, 241, 0.2), 0 0 40px rgba(99, 102, 241, 0.1);
		max-width: 500px;
		width: 90%;
		max-height: 70vh;
		display: flex;
		flex-direction: column;
		border: 1px solid rgba(99, 102, 241, 0.3);
		border-bottom: none;
		animation: slideUp 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
		flex-shrink: 0;
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px 16px;
		border-bottom: 1px solid rgba(99, 102, 241, 0.2);
		background: linear-gradient(135deg, rgba(99, 102, 241, 0.1) 0%, transparent 100%);
		flex-shrink: 0;
	}

	.modal-header h2 {
		margin: 0;
		font-size: 1.2rem;
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
		font-size: 1.2rem;
		cursor: pointer;
		padding: 4px;
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.3s;
		border-radius: 6px;
		flex-shrink: 0;
	}

	.close-btn:hover {
		background: rgba(99, 102, 241, 0.4);
		color: #e0e0e0;
		transform: rotate(90deg);
	}

	.modal-body {
		padding: 16px;
		overflow-y: auto;
		flex: 1;
	}

	.form-group {
		margin-bottom: 12px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.form-group label {
		font-size: 0.75rem;
		color: #a78bfa;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.form-group input,
	.form-group select {
		padding: 8px 10px;
		background: rgba(99, 102, 241, 0.05);
		border: 1px solid rgba(99, 102, 241, 0.2);
		border-radius: 6px;
		color: #e0e0e0;
		font-size: 0.85rem;
		font-family: inherit;
		transition: all 0.2s;
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
		padding: 12px 16px;
		border-top: 1px solid rgba(99, 102, 241, 0.2);
		justify-content: flex-end;
		background: linear-gradient(135deg, #1a1a20 0%, #232329 100%);
		flex-shrink: 0;
		border-radius: 0 0 12px 12px;
		border: 1px solid rgba(99, 102, 241, 0.3);
		border-top: 1px solid rgba(99, 102, 241, 0.2);
		max-width: 500px;
		width: 90%;
		margin-top: -1px;
	}

	.btn-cancel,
	.btn-create {
		padding: 8px 16px;
		border-radius: 6px;
		border: none;
		font-size: 0.85rem;
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

	.tag-suggestions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 8px;
		padding: 8px;
		background: rgba(99, 102, 241, 0.05);
		border-radius: 6px;
	}

	.tag-suggestion {
		padding: 4px 10px;
		background: rgba(99, 102, 241, 0.2);
		border: 1px solid rgba(99, 102, 241, 0.3);
		border-radius: 12px;
		color: #6366f1;
		cursor: pointer;
		font-size: 0.85rem;
		transition: all 0.15s;
	}

	.tag-suggestion:hover {
		background: rgba(99, 102, 241, 0.3);
		border-color: #6366f1;
	}

	.selected-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 8px;
	}

	.tag-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 10px;
		background: #6366f1;
		border-radius: 12px;
		color: white;
		font-size: 0.85rem;
	}

	.remove-tag {
		background: none;
		border: none;
		color: white;
		cursor: pointer;
		font-size: 0.9rem;
		padding: 0 4px;
		margin-left: 4px;
		opacity: 0.7;
		transition: opacity 0.15s;
	}

	.remove-tag:hover {
		opacity: 1;
	}

	@media (max-width: 1024px) {
		.art-header {
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
			padding: 6px 8px;
			gap: 12px;
		}

		.art-header h1 {
			font-size: 0.667rem;
		}

		.header-controls {
			gap: 8px;
		}

		.create-btn {
			padding: 3px 6px;
			font-size: 0.317rem;
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


		.modal-content {
			width: 95%;
			max-width: 450px;
		}
	}

	@media (max-width: 480px) {
		.art-header {
			padding: 4px 8px;
		}

		.art-header h1 {
			font-size: 0.667rem;
		}

		.header-controls {
			gap: 6px;
		}

		.create-btn {
			padding: 2px 4px;
			font-size: 0.317rem;
		}

		.header-stats {
			gap: 12px;
		}

		.stat {
			min-width: 45px;
		}

		.stat-label {
			font-size: 0.25rem;
		}

		.stat-value {
			font-size: 0.667rem;
		}

		.pinned-sidebar-wrapper {
			height: 120px;
		}

		.resource-panel {
			height: 30%;
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
