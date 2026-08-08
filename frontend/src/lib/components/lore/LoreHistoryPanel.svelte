<script lang="ts">
	interface Revision {
		hash: string;
		message: string;
		author: string;
		timestamp: number;
		branch?: string;
		filesChanged?: number;
	}

	interface Branch {
		name: string;
		lastCommit: string;
		lastCommitAt: number;
	}

	interface Props {
		revisions: Revision[];
		branches: Branch[];
		loading: boolean;
		onRevisionSelect: (hash: string) => void;
		onCompare: (from: string, to: string) => void;
	}

	let { revisions, branches, loading, onRevisionSelect, onCompare }: Props = $props();

	let selectedHash = $state<string | null>(null);
	let compareFrom = $state<string | null>(null);
	let showLoadMore = $state(false);
	let filterAuthor = $state('');
	let filterBranch = $state('');

	let filtered = $derived(revisions.filter(r => {
		if (filterAuthor && !r.author.toLowerCase().includes(filterAuthor.toLowerCase())) return false;
		if (filterBranch && r.branch !== filterBranch) return false;
		return true;
	}));

	function timeAgo(ts: number): string {
		const diff = Date.now() / 1000 - ts;
		if (diff < 60) return `${Math.floor(diff)}s ago`;
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
		if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
		return `${Math.floor(diff / 86400)}d ago`;
	}

	function selectRevision(hash: string) {
		if (selectedHash === hash) {
			selectedHash = null;
		} else if (selectedHash) {
			onCompare(selectedHash, hash);
			selectedHash = null;
		} else {
			selectedHash = hash;
		}
	}
</script>

<div class="lore-history">
	<div class="history-filters">
		<input type="text" bind:value={filterAuthor} placeholder="Filter by author..." aria-label="Filter by author" />
		<select bind:value={filterBranch} aria-label="Filter by branch">
			<option value="">All branches</option>
			{#each branches as b}
				<option value={b.name}>{b.name}</option>
			{/each}
		</select>
		{#if selectedHash}
			<span class="compare-mode">Select another to compare (1/2)</span>
		{/if}
	</div>

	{#if loading}
		<div class="history-loading">Loading history...</div>
	{:else}
		<ul class="history-list">
			{#each filtered.slice(0, 50) as rev}
				<li
					class="history-item {selectedHash === rev.hash ? 'selected' : ''}"
					onclick={() => selectRevision(rev.hash)}
				>
					<div class="rev-header">
						<span class="rev-hash" title={rev.hash}>{rev.hash.slice(0, 8)}</span>
						{#if rev.branch}
							<span class="rev-branch">{rev.branch}</span>
						{/if}
					</div>
					<div class="rev-message">{rev.message}</div>
					<div class="rev-meta">
						<span class="rev-author">{rev.author}</span>
						<span class="rev-time">{timeAgo(rev.timestamp)}</span>
						{#if rev.filesChanged}
							<span class="rev-files">{rev.filesChanged} file{rev.filesChanged !== 1 ? 's' : ''}</span>
						{/if}
					</div>
				</li>
			{/each}
		</ul>

		{#if filtered.length > 50}
			<button class="load-more">Load more ({filtered.length - 50} remaining)</button>
		{/if}

		{#if filtered.length === 0}
			<div class="history-empty">No revisions match your filters</div>
		{/if}
	{/if}
</div>

<style>
	.lore-history {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
	}

	.history-filters {
		display: flex;
		gap: var(--space-1);
		padding: var(--space-1) var(--space-2);
		background: var(--surface-raised);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		align-items: center;
	}

	.history-filters input, .history-filters select {
		padding: 2px var(--space-1);
		background: var(--surface-sunken);
		border: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		border-radius: var(--radius-sm);
		color: var(--text-heading);
		font-size: var(--font-size-xs);
	}

	.compare-mode {
		font-size: var(--font-size-xs);
		color: var(--accent-primary);
		margin-left: auto;
	}

	.history-list {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		flex: 1;
	}

	.history-item {
		padding: var(--space-2);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 8%, transparent);
		cursor: pointer;
		transition: background var(--duration-fast) var(--ease-out);
	}

	.history-item:hover {
		background: var(--surface-raised);
	}

	.history-item.selected {
		background: color-mix(in srgb, var(--accent-primary) 15%, transparent);
	}

	.rev-header {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}

	.rev-hash {
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
		color: var(--accent-primary);
	}

	.rev-branch {
		font-size: var(--font-size-xs);
		color: var(--text-muted);
		background: var(--surface-sunken);
		padding: 1px 4px;
		border-radius: var(--radius-sm);
	}

	.rev-message {
		color: var(--text-heading);
		font-size: var(--font-size-sm);
		margin-top: 2px;
	}

	.rev-meta {
		display: flex;
		gap: var(--space-2);
		margin-top: 2px;
		font-size: var(--font-size-xs);
		color: var(--text-muted);
	}

	.history-loading, .history-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-4);
		color: var(--text-muted);
	}

	.load-more {
		width: 100%;
		padding: var(--space-2);
		background: var(--surface-raised);
		border: none;
		border-top: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		color: var(--accent-primary);
		cursor: pointer;
		font-size: var(--font-size-sm);
	}

	.load-more:hover {
		background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
	}
</style>