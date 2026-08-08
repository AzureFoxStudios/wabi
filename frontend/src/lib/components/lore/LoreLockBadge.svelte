<script lang="ts">
	interface Props {
		locked: boolean;
		lockedBy: string | null;
		lockedAt: number | null;
		onClick: () => void;
	}

	let { locked, lockedBy, lockedAt, onClick }: Props = $props();

	let timeAgo = $derived.by(() => {
		if (!lockedAt) return '';
		const diff = Date.now() / 1000 - lockedAt;
		if (diff < 60) return `${Math.floor(diff)}s ago`;
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
		if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
		return `${Math.floor(diff / 86400)}d ago`;
	});
</script>

<button
	class="lock-badge {locked ? 'locked' : 'unlocked'}"
	class:locked={locked}
	onclick={() => onClick()}
	aria-label={locked ? `Locked by {lockedBy} {timeAgo}` : 'Not locked'}
	title={locked ? `Locked by {lockedBy} {timeAgo}` : 'Click to lock'}
>
	{#if locked}
		<svg class="lock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
			<path d="M7 11V7a5 5 0 0 1 10 0v4" />
		</svg>
		<span class="lock-info">
			{lockedBy}<span class="lock-time">{timeAgo}</span>
		</span>
	{:else}
		<svg class="lock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
			<path d="M7 11V7a5 5 0 0 1 9.9-1" />
		</svg>
	{/if}
</button>

<style>
	.lock-badge {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: 2px var(--space-2);
		border-radius: var(--radius-sm);
		font-size: var(--font-size-xs);
		cursor: pointer;
		border: 1px solid transparent;
		background: transparent;
		transition: background var(--duration-fast) var(--ease-out);
	}

	.lock-badge:hover {
		background: var(--surface-raised);
	}

	.lock-badge.locked {
		color: var(--color-warning, #f59e0b);
		border-color: color-mix(in srgb, var(--color-warning, #f59e0b) 30%, transparent);
	}

	.lock-badge.unlocked {
		color: var(--text-muted);
	}

	.lock-badge.unlocked:hover {
		color: var(--color-success, #22c55e);
		border-color: color-mix(in srgb, var(--color-success, #22c55e) 30%, transparent);
	}

	.lock-icon {
		width: 12px;
		height: 12px;
		flex-shrink: 0;
	}

	.lock-info {
		display: inline-flex;
		align-items: baseline;
		gap: var(--space-1);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 120px;
	}

	.lock-time {
		color: var(--text-muted);
		font-size: var(--font-size-2xs);
	}
</style>