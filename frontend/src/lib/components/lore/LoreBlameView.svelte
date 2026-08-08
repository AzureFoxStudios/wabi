<script lang="ts">
	interface BlameLine {
		line: number;
		content: string;
		author: string;
		timestamp: number;
		hash: string;
	}

	interface Props {
		filePath: string;
		blameData: BlameLine[];
		loading: boolean;
	}

	let { filePath, blameData, loading }: Props = $props();

	function timeAgo(ts: number): string {
		const diff = Date.now() / 1000 - ts;
		if (diff < 60) return `${Math.floor(diff)}s ago`;
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
		if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
		return `${Math.floor(diff / 86400)}d ago`;
	}

	// Group consecutive lines by same author for compact display
	function groupBlame(lines: BlameLine[]) {
		const groups: { author: string; timestamp: number; hash: string; startLine: number; endLine: number; content: string }[] = [];
		let current: typeof groups[number] | null = null;

		for (const line of lines) {
			if (current && current.author === line.author && current.hash === line.hash) {
				current.endLine = line.line;
				current.content += '\n' + line.content;
			} else {
				if (current) groups.push(current);
				current = {
					author: line.author,
					timestamp: line.timestamp,
					hash: line.hash,
					startLine: line.line,
					endLine: line.line,
					content: line.content
				};
			}
		}
		if (current) groups.push(current);
		return groups;
	}

	let groups = $derived(groupBlame(blameData));
</script>

<div class="lore-blame">
	<div class="blame-header">
		<span class="blame-path">{filePath}</span>
		<span class="blame-count">{blameData.length} lines</span>
	</div>

	{#if loading}
		<div class="blame-loading">Loading blame...</div>
	{:else}
		<div class="blame-content">
			{#each groups as group}
				<div class="blame-group">
					<div class="blame-attribution">
						<span class="blame-author">{group.author}</span>
						<span class="blame-hash" title={group.hash}>{group.hash.slice(0, 8)}</span>
						<span class="blame-time">{timeAgo(group.timestamp)}</span>
						<span class="blame-range">
							{group.startLine === group.endLine
								? `L${group.startLine}`
								: `L${group.startLine}-${group.endLine}`}
						</span>
					</div>
					<pre class="blame-code"><code>{group.content}</code></pre>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.lore-blame {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
	}

	.blame-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: var(--space-1) var(--space-2);
		background: var(--surface-raised);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		font-size: var(--font-size-sm);
	}

	.blame-path {
		color: var(--text-heading);
		font-family: var(--font-mono);
	}

	.blame-count {
		color: var(--text-muted);
		font-size: var(--font-size-xs);
	}

	.blame-content {
		flex: 1;
		overflow: auto;
	}

	.blame-group {
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 8%, transparent);
	}

	.blame-attribution {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: 2px var(--space-2);
		background: color-mix(in srgb, var(--surface-raised) 50%, transparent);
		font-size: var(--font-size-xs);
	}

	.blame-author {
		color: var(--accent-primary);
		font-weight: 500;
	}

	.blame-hash {
		color: var(--text-muted);
		font-family: var(--font-mono);
	}

	.blame-time {
		color: var(--text-muted);
	}

	.blame-range {
		margin-left: auto;
		color: var(--text-muted);
		font-family: var(--font-mono);
	}

	.blame-code {
		margin: 0;
		padding: 2px var(--space-2) 2px var(--space-4);
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
		line-height: 1.6;
		color: var(--text-heading);
		white-space: pre;
	}

	.blame-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-4);
		color: var(--text-muted);
	}
</style>