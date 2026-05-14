<script lang="ts">
	export let node: any;
	export let selected = false;

	function handleKeydown(event: KeyboardEvent) {
		if ((event.key === 'Enter' || event.key === ' ') && event.currentTarget instanceof HTMLElement) {
			event.preventDefault();
			event.currentTarget.click();
		}
	}

	const icons: Record<string, string> = {
		brush: '🖌️',
		image: '🖼️',
		url: '🔗',
		note: '📝',
		file: '📁',
		code: '💻'
	};
</script>

<div
	class="resource-node {selected ? 'selected' : ''} {node.data?.isAnonymous ? 'anonymous' : ''}"
	role="button"
	tabindex="0"
	aria-label={node.data?.label || node.label || 'Resource node'}
	on:click
	on:click|stopPropagation
	on:keydown={handleKeydown}
	on:keydown|stopPropagation
>
	<div class="node-icon">
		{icons[node.data?.type] || '📄'}
	</div>
	<div class="node-label">
		{node.data?.label || node.label}
	</div>
	{#if node.data && !node.data.isAnonymous && node.data.author}
		<div class="node-author">
			{node.data.author}
		</div>
	{/if}
</div>

<style>
	.resource-node {
		background: #2a2a2e;
		border: 2px solid #6366f1;
		border-radius: 50%;
		width: 80px;
		height: 80px;
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
		cursor: pointer;
		transition: all 0.2s;
		font-size: 11px;
		padding: 4px;
	}

	.resource-node:hover {
		transform: scale(1.1);
		box-shadow: 0 0 20px rgba(99, 102, 241, 0.5);
	}

	.resource-node.selected {
		border-color: #10b981;
		box-shadow: 0 0 30px rgba(16, 185, 129, 0.5);
	}

	.resource-node.anonymous {
		border-style: dashed;
		border-color: #a855f7;
	}

	.node-icon {
		font-size: 24px;
		margin-bottom: 4px;
	}

	.node-label {
		font-weight: bold;
		color: #fff;
		text-align: center;
		max-width: 75px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.node-author {
		font-size: 9px;
		color: #aaa;
		margin-top: 2px;
	}
</style>
