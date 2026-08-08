<script lang="ts">
	interface Props {
		diff: string;
		mode: 'unified' | 'side-by-side';
		onModeChange: (mode: 'unified' | 'side-by-side') => void;
	}

	let { diff, mode, onModeChange }: Props = $props();

	let copied = $state(false);

	function copyDiff() {
		navigator.clipboard.writeText(diff);
		copied = true;
		setTimeout(() => copied = false, 2000);
	}

	function parseHunks(text: string) {
		const hunks: { header: string; lines: { type: 'add' | 'remove' | 'context'; content: string }[] }[] = [];
		const hunkRegex = /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@(.*)?$/;
		let currentHunk: typeof hunks[number] | null = null;

		for (const raw of text.split('\n')) {
			const m = raw.match(hunkRegex);
			if (m) {
				currentHunk = { header: raw, lines: [] };
				hunks.push(currentHunk);
				continue;
			}
			if (currentHunk) {
				if (raw.startsWith('+')) currentHunk.lines.push({ type: 'add', content: raw });
				else if (raw.startsWith('-')) currentHunk.lines.push({ type: 'remove', content: raw });
				else if (raw.startsWith(' ')) currentHunk.lines.push({ type: 'context', content: raw });
				else if (raw.startsWith('\\')) currentHunk.lines.push({ type: 'context', content: raw });
			}
		}
		return hunks;
	}

	let hunks = $derived(parseHunks(diff));
	let added = $derived(hunks.flatMap(h => h.lines).filter(l => l.type === 'add').length);
	let removed = $derived(hunks.flatMap(h => h.lines).filter(l => l.type === 'remove').length);
</script>

<div class="diff-viewer mode-{mode}">
	<div class="diff-toolbar">
		<div class="diff-stats">
			<span class="stat add">+{added}</span>
			<span class="stat remove">-{removed}</span>
		</div>
		<div class="diff-controls">
			<button
				class="mode-btn {mode === 'unified' ? 'active' : ''}"
				onclick={() => onModeChange('unified')}
				aria-label="Unified diff view"
			>Unified</button>
			<button
				class="mode-btn {mode === 'side-by-side' ? 'active' : ''}"
				onclick={() => onModeChange('side-by-side')}
				aria-label="Side-by-side diff view"
			>Side by side</button>
			<button class="copy-btn" onclick={copyDiff} aria-label="Copy diff">
				{copied ? '✓ Copied' : 'Copy diff'}
			</button>
		</div>
	</div>

	{#if mode === 'unified'}
		<div class="diff-content unified">
			{#each hunks as hunk}
				<div class="hunk">
					<button class="hunk-header" aria-label="Toggle hunk">
						<span class="hunk-text">{hunk.header}</span>
					</button>
					<pre class="hunk-lines"><code>
						{#each hunk.lines as line}
							<div class="diff-line {line.type}">{line.content}</div>
						{/each}
					</code></pre>
				</div>
			{/each}
		</div>
	{:else}
		<div class="diff-content side-by-side">
			{#each hunks as hunk}
				<div class="sbs-hunk">
					<div class="sbs-header">{hunk.header}</div>
					<div class="sbs-pans">
						<div class="sbs-pane old">
							{#each hunk.lines as line}
								{#if line.type === 'remove' || line.type === 'context'}
									<div class="diff-line {line.type}">{line.content}</div>
								{/if}
							{/each}
						</div>
						<div class="sbs-pane new">
							{#each hunk.lines as line}
								{#if line.type === 'add' || line.type === 'context'}
									<div class="diff-line {line.type}">{line.content}</div>
								{/if}
							{/each}
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.diff-viewer {
		display: flex;
		flex-direction: column;
		height: 100%;
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
	}

	.diff-toolbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: var(--space-1) var(--space-2);
		background: var(--surface-raised);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
	}

	.diff-stats {
		display: flex;
		gap: var(--space-2);
	}

	.stat {
		padding: 2px 6px;
		border-radius: var(--radius-sm);
		font-size: var(--font-size-xs);
		font-weight: 600;
	}

	.stat.add {
		background: color-mix(in srgb, var(--color-success, #22c55e) 20%, transparent);
		color: var(--color-success, #22c55e);
	}

	.stat.remove {
		background: color-mix(in srgb, var(--color-danger, #ef4444) 20%, transparent);
		color: var(--color-danger, #ef4444);
	}

	.diff-controls {
		display: flex;
		gap: var(--space-1);
	}

	.mode-btn, .copy-btn {
		padding: 2px var(--space-2);
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		color: var(--text-muted);
		cursor: pointer;
		font-size: var(--font-size-xs);
	}

	.mode-btn.active {
		background: var(--accent-primary);
		color: white;
	}

	.mode-btn:hover:not(.active) {
		background: var(--surface-sunken);
	}

	.copy-btn:hover {
		background: var(--surface-raised);
	}

	.diff-content {
		flex: 1;
		overflow: auto;
	}

	.hunk-header {
		width: 100%;
		padding: var(--space-1) var(--space-2);
		background: var(--surface-raised);
		border: none;
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 10%, transparent);
		color: var(--text-heading);
		cursor: pointer;
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
		text-align: left;
	}

	.hunk-lines {
		margin: 0;
		padding: 0;
		overflow: visible;
	}

	.diff-line {
		padding: 0 var(--space-2);
		line-height: 1.6;
		white-space: pre;
	}

	.diff-line.add {
		background: color-mix(in srgb, var(--color-success, #22c55e) 10%, transparent);
	}

	.diff-line.remove {
		background: color-mix(in srgb, var(--color-danger, #ef4444) 10%, transparent);
	}

	.diff-line.context {
		color: var(--text-muted);
	}

	.sbs-pans {
		display: grid;
		grid-template-columns: 1fr 1fr;
	}

	.sbs-pane {
		overflow-x: auto;
	}

	.sbs-header {
		padding: var(--space-1) var(--space-2);
		background: var(--surface-raised);
		color: var(--text-heading);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 10%, transparent);
	}
</style>