<script lang="ts">
	interface Props {
		citation: {
			file_path: string;
			start_line: number;
			end_line: number;
			mode: 'Pinned' | 'Tracking';
			branch?: string;
			revision?: string;
			label?: string;
		};
		drift?: 'Current' | 'Drifted' | 'Missing';
		onClick: () => void;
		onPin?: () => void;
		onUpdate?: () => void;
	}

	let { citation, drift, onClick, onPin, onUpdate }: Props = $props();

	let isPinned = $derived(citation.mode === 'Pinned');
	let refLabel = $derived(() => {
		if (isPinned && citation.revision) return citation.revision.slice(0, 8);
		if (!isPinned && citation.branch) return citation.branch;
		return '';
	});

	let lineLabel = $derived(() => {
		if (citation.start_line === 1 && citation.end_line === Number.MAX_SAFE_INTEGER) return '';
		if (citation.start_line === citation.end_line) return `:${citation.start_line}`;
		return `:${citation.start_line}-${citation.end_line}`;
	});
</script>

<button class="citation-chip {citation.mode} {drift ?? 'Current'}" onclick={onClick} title={citation.file_path}>
	<span class="citation-icon">
		{#if drift === 'Missing'}
			⚠️
		{:else if drift === 'Drifted'}
			🔄
		{:else}
			{#if isPinned}📌{:else}🔗{/if}
		{/if}
	</span>
	<span class="citation-path">{citation.file_path}</span>
	{#if lineLabel}<span class="citation-lines">{lineLabel}</span>{/if}
	<span class="citation-ref" title={isPinned ? 'Pinned' : 'Tracking'}>{refLabel}</span>
	{#if isPinned}<span class="citation-badge pinned">pinned</span>{/if}
	{#if drift === 'Drifted' && onUpdate}
		<button class="drift-action" onclick={(e) => { e.stopPropagation(); onUpdate(); }} title="Update citation">↻</button>
	{/if}
	{#if !isPinned && onPin}
		<button class="drift-action" onclick={(e) => { e.stopPropagation(); onPin(); }} title="Pin citation">📌</button>
	{/if}
</button>

<style>
	.citation-chip {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: 2px var(--space-1);
		background: var(--surface-raised);
		border: 1px solid color-mix(in srgb, var(--text-muted) 20%, transparent);
		border-radius: var(--radius-sm);
		cursor: pointer;
		font-size: var(--font-size-xs);
		font-family: var(--font-mono);
		color: var(--text-secondary);
		transition: all var(--duration-fast) var(--ease-out);
		max-width: 100%;
		overflow: hidden;
	}

	.citation-chip:hover {
		background: var(--surface-hover);
		border-color: color-mix(in srgb, var(--accent-primary) 40%, transparent);
		color: var(--text-heading);
	}

	.citation-chip.Tracking {
		border-left: 3px solid var(--accent-primary);
	}

	.citation-chip.Pinned {
		border-left: 3px solid var(--color-success, #22c55e);
	}

	.citation-chip.Drifted {
		border-color: color-mix(in srgb, var(--color-warning, #f59e0b) 50%, transparent);
		background: color-mix(in srgb, var(--color-warning, #f59e0b) 10%, var(--surface-raised));
	}

	.citation-chip.Missing {
		border-color: color-mix(in srgb, var(--color-danger, #ef4444) 50%, transparent);
		opacity: 0.7;
	}

	.citation-icon {
		font-size: 12px;
		flex-shrink: 0;
	}

	.citation-path {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.citation-lines {
		color: var(--text-muted);
	}

	.citation-ref {
		color: var(--text-muted);
		font-size: var(--font-size-2xs);
	}

	.citation-badge {
		font-size: var(--font-size-2xs);
		padding: 0 4px;
		border-radius: 2px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.citation-badge.pinned {
		background: color-mix(in srgb, var(--color-success, #22c55e) 20%, transparent);
		color: var(--color-success, #22c55e);
	}

	.drift-action {
		background: transparent;
		border: none;
		cursor: pointer;
		font-size: 12px;
		padding: 0 2px;
		opacity: 0.7;
		transition: opacity var(--duration-fast);
	}

	.drift-action:hover {
		opacity: 1;
	}
</style>