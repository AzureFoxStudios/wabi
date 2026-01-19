<script lang="ts">
	interface Props {
		data: {
			label: string;
			type: string;
			preview?: string;
			author?: string;
			isAnonymous?: boolean;
			tags?: string[];
		};
	}

	let { data }: Props = $props();

	// Handles removed: connections are predefined via graphEdges store, not user-created through drag-and-drop

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

	const typeColors: Record<string, string> = {
		brush: '#ec4899',
		image: '#06b6d4',
		url: '#3b82f6',
		note: '#fbbf24',
		file: '#8b5cf6',
		code: '#10b981',
		video: '#f97316',
		audio: '#6366f1'
	};
</script>

<div class="resource-node">
	<div class="node-content">
		<div class="node-header">
			<span class="node-icon" style="font-size: 1.5rem;">
				{typeIcons[data.type] || '📄'}
			</span>
			<div class="node-title">{data.label}</div>
		</div>

		{#if data.preview}
			<img src={data.preview} alt={data.label} class="node-preview" />
		{/if}

		{#if data.tags && data.tags.length > 0}
			<div class="node-tags">
				{#each data.tags.slice(0, 2) as tag}
					<span class="tag">#{tag}</span>
				{/each}
				{#if data.tags.length > 2}
					<span class="tag-more">+{data.tags.length - 2}</span>
				{/if}
			</div>
		{/if}

		{#if data.author}
			<div class="node-meta">
				{#if data.isAnonymous}
					<span class="meta-text">🔒 Anonymous</span>
				{:else}
					<span class="meta-text">by {data.author}</span>
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.resource-node {
		background: #2a2a2e;
		border: 2px solid #6366f1;
		border-radius: 10px;
		padding: 12px;
		min-width: 180px;
		max-width: 220px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
		transition: all 0.2s;
	}

	.resource-node:hover {
		border-color: #10b981;
		box-shadow: 0 0 20px rgba(16, 185, 129, 0.4);
		transform: scale(1.05);
	}

	.node-content {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.node-header {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.node-icon {
		flex-shrink: 0;
	}

	.node-title {
		font-size: 0.85rem;
		font-weight: 600;
		color: #e0e0e0;
		overflow: hidden;
		text-overflow: ellipsis;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		line-height: 1.2;
	}

	.node-preview {
		width: 100%;
		height: 80px;
		object-fit: cover;
		border-radius: 6px;
		border: 1px solid #444;
	}

	.node-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		font-size: 0.7rem;
	}

	.tag {
		background: rgba(99, 102, 241, 0.3);
		color: #6366f1;
		padding: 2px 6px;
		border-radius: 8px;
		white-space: nowrap;
	}

	.tag-more {
		color: #a0a0a0;
		font-size: 0.65rem;
		padding: 2px 6px;
	}

	.node-meta {
		font-size: 0.7rem;
		color: #a0a0a0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.meta-text {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
