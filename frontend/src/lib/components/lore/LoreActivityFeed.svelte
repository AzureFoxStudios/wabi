<script lang="ts">
	interface Props {
		activity: Array<{
			type: 'commit' | 'review' | 'merge' | 'lock' | 'release';
			author_id: string;
			message: string;
			timestamp: number;
			metadata?: Record<string, any>;
		}>;
	}

	let { activity }: Props = $props();

	function timeAgo(ts: number): string {
		const diff = Date.now() / 1000 - ts;
		if (diff < 60) return `${Math.floor(diff)}s ago`;
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
		if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
		return `${Math.floor(diff / 86400)}d ago`;
	}

	function iconFor(type: string): string {
		switch (type) {
			case 'commit': return '📝';
			case 'review': return '🔍';
			case 'merge': return '🔀';
			case 'lock': return '🔒';
			case 'release': return '🚀';
			default: return '📌';
		}
	}
</script>

<div class="activity-feed">
	{#if activity.length === 0}
		<div class="feed-empty">No activity yet</div>
	{:else}
		{#each activity as event}
			<div class="feed-item">
				<span class="feed-icon">{iconFor(event.type)}</span>
				<div class="feed-content">
					<span class="feed-author">@{event.author_id}</span>
					<span class="feed-message">{event.message}</span>
				</div>
				<span class="feed-time">{timeAgo(event.timestamp)}</span>
			</div>
		{/each}
	{/if}
</div>

<style>
	.activity-feed {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.feed-empty {
		color: var(--text-muted);
		text-align: center;
		padding: var(--space-3);
	}

	.feed-item {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-sm);
		transition: background var(--duration-fast);
	}

	.feed-item:hover {
		background: var(--surface-raised);
	}

	.feed-icon {
		font-size: 16px;
		flex-shrink: 0;
	}

	.feed-content {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.feed-author {
		font-size: var(--font-size-xs);
		color: var(--accent-primary);
		font-weight: 600;
	}

	.feed-message {
		font-size: var(--font-size-sm);
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.feed-time {
		font-size: var(--font-size-xs);
		color: var(--text-muted);
		flex-shrink: 0;
	}
</style>