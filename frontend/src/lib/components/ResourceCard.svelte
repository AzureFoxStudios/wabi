<script lang="ts">
	import { get } from 'svelte/store';
	import { resources, deleteResource } from '$lib/business/store';
	import type { Resource } from '$lib/business/store';

	export let resourceId: string;

	$: resource = get(resources).find(r => r.id === resourceId);
	$: isEditing = false;
	$: editName = resource?.name || '';
	$: editDescription = resource?.description || '';

	function handleDownload() {
		if (!resource) return;

		if (resource.type === 'brush' || resource.type === 'file') {
			const link = document.createElement('a');
			link.href = resource.fileUrl || '';
			link.download = resource.name;
			link.click();
		} else if (resource.type === 'url') {
			window.open(resource.externalUrl || resource.fileUrl, '_blank');
		}
	}

	function handleDelete() {
		if (resourceId && confirm(`Delete "${resource?.name}"?`)) {
			deleteResource(resourceId);
		}
	}

	function openInGraph() {
		window.open(`/art?highlight=${resourceId}`, '_blank');
	}

	function copyLink() {
		const url = `${window.location.origin}/art?highlight=${resourceId}`;
		navigator.clipboard.writeText(url);
		alert('Link copied to clipboard!');
	}

	function handleContextMenu(event: MouseEvent) {
		event.preventDefault();
		// Context menu handled by browser right-click on buttons
	}

	const typeIcons: Record<string, string> = {
		brush: '🖌️',
		image: '🖼️',
		url: '🔗',
		note: '📝',
		file: '📁',
		code: '💻',
		video: '🎬',
		audio: '🎵'
	};
</script>

{#if resource}
	<div class="resource-card">
		<div class="card-header">
			<div class="card-title">
				<span class="icon">{typeIcons[resource.type] || '📄'}</span>
				<h2>{resource.name}</h2>
			</div>
			<button class="close-btn" on:click={() => {}}>✕</button>
		</div>

		<div class="card-meta">
			<span class="meta-item">
				<strong>Type:</strong> {resource.type}
			</span>
			<span class="meta-item">
				{#if resource.isAnonymous}
					<strong>👤 Anonymous</strong>
				{:else}
					<strong>Creator:</strong> {resource.createdBy}
				{/if}
			</span>
			{#if resource.createdAt}
				<span class="meta-item">
					<strong>Created:</strong> {new Date(resource.createdAt).toLocaleDateString()}
				</span>
			{/if}
		</div>

		{#if resource.tags && resource.tags.length > 0}
			<div class="card-tags">
				{#each resource.tags as tag}
					<span class="tag">#{tag}</span>
				{/each}
			</div>
		{/if}

		<!-- Preview based on type -->
		{#if resource.type === 'image' && resource.preview}
			<div class="card-preview">
				<img src={resource.preview} alt={resource.name} />
			</div>
		{:else if resource.type === 'brush' && resource.preview}
			<div class="card-preview">
				<img src={resource.preview} alt={resource.name} />
			</div>
		{/if}

		{#if resource.description}
			<div class="card-description">
				<h3>Description</h3>
				<p>{resource.description}</p>
			</div>
		{/if}

		<!-- URL display -->
		{#if resource.type === 'url' && (resource.externalUrl || resource.fileUrl)}
			<div class="card-url">
				<strong>Link:</strong>
				<a href={resource.externalUrl || resource.fileUrl} target="_blank">
					{resource.externalUrl || resource.fileUrl}
				</a>
			</div>
		{/if}

		<!-- Actions -->
		<div class="card-actions">
			<button class="action-btn primary" on:click={handleDownload}>
				{#if resource.type === 'url'}
					🔗 Open Link
				{:else}
					⬇️ Download
				{/if}
			</button>
			<button class="action-btn" on:click={copyLink} title="Copy shareable link to clipboard">
				🔗 Copy Link
			</button>
			<button class="action-btn" on:click={openInGraph}>
				👁️ View in Graph
			</button>
			<button class="action-btn danger" on:click={handleDelete}>
				🗑️ Delete
			</button>
		</div>
	</div>
{:else}
	<div class="resource-card empty">
		<p>No resource selected</p>
	</div>
{/if}

<style>
	.resource-card {
		background: #1e1e24;
		border-radius: 8px;
		padding: 20px;
		max-width: 100%;
		color: #e0e0e0;
	}

	.resource-card.empty {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 200px;
		color: #808080;
	}

	.card-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		margin-bottom: 16px;
		gap: 12px;
	}

	.card-title {
		display: flex;
		align-items: center;
		gap: 12px;
		flex: 1;
	}

	.icon {
		font-size: 2rem;
	}

	.card-title h2 {
		margin: 0;
		font-size: 1.5rem;
		color: #fff;
	}

	.close-btn {
		background: none;
		border: none;
		color: #808080;
		font-size: 1.5rem;
		cursor: pointer;
		padding: 0;
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		transition: background 0.15s;
	}

	.close-btn:hover {
		background: #2a2a2e;
		color: #e0e0e0;
	}

	.card-meta {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-bottom: 16px;
		font-size: 0.9rem;
		color: #a0a0a0;
	}

	.meta-item {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.meta-item strong {
		color: #e0e0e0;
		min-width: 80px;
	}

	.card-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin: 12px 0;
	}

	.tag {
		background: #6366f1;
		color: white;
		padding: 4px 12px;
		border-radius: 12px;
		font-size: 0.85rem;
		cursor: pointer;
		transition: background 0.15s;
	}

	.tag:hover {
		background: #7c3aed;
	}

	.card-preview {
		background: #000;
		border-radius: 8px;
		overflow: hidden;
		max-height: 250px;
		margin: 16px 0;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.card-preview img {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}

	.card-description {
		margin: 16px 0;
		padding: 12px;
		background: #2a2a2e;
		border-radius: 6px;
		border-left: 3px solid #6366f1;
	}

	.card-description h3 {
		margin: 0 0 8px 0;
		font-size: 0.95rem;
		color: #e0e0e0;
	}

	.card-description p {
		margin: 0;
		line-height: 1.5;
		color: #a0a0a0;
	}

	.card-url {
		margin: 16px 0;
		padding: 12px;
		background: #2a2a2e;
		border-radius: 6px;
	}

	.card-url strong {
		color: #e0e0e0;
	}

	.card-url a {
		display: block;
		margin-top: 8px;
		color: #6366f1;
		text-decoration: none;
		word-break: break-all;
		transition: color 0.15s;
	}

	.card-url a:hover {
		color: #7c3aed;
		text-decoration: underline;
	}

	.card-actions {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
		margin-top: 20px;
	}

	.action-btn {
		padding: 10px 12px;
		background: #2a2a2e;
		border: 1px solid #444;
		border-radius: 6px;
		color: #e0e0e0;
		cursor: pointer;
		font-size: 0.85rem;
		transition: all 0.15s;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.action-btn:hover {
		background: #333333;
		border-color: #666;
	}

	.action-btn.primary {
		background: #6366f1;
		border-color: #6366f1;
		color: white;
	}

	.action-btn.primary:hover {
		background: #7c3aed;
		border-color: #7c3aed;
	}

	.action-btn.danger:hover {
		background: #ef4444;
		border-color: #ef4444;
		color: white;
	}
</style>
