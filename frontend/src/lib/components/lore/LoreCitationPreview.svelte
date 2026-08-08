<script lang="ts">
	interface Props {
		citation: {
			file_path: string;
			start_line: number;
			end_line: number;
			mode: 'Pinned' | 'Tracking';
			branch?: string;
			revision?: string;
		};
		content: string;
		language?: string;
		drift?: 'Current' | 'Drifted' | 'Missing';
		onOpen: () => void;
	}

	let { citation, content, language, drift, onOpen }: Props = $props();

	let lineCount = $derived(content.split('\n').length);
	let previewLines = $derived(() => {
		const lines = content.split('\n');
		return lines.slice(0, 12).join('\n');
	});
	let hasMore = $derived(lineCount > 12);
</script>

<div class="citation-preview {drift ?? 'Current'}" onclick={onOpen}>
	<div class="preview-header">
		<span class="preview-path">{citation.file_path}</span>
		<span class="preview-meta">
			{citation.start_line}-{citation.end_line} · {lineCount} lines
			{#if language}<span class="preview-lang">{language}</span>{/if}
		</span>
	</div>
	{#if drift !== 'Missing'}
		<pre class="preview-content"><code>{previewLines}</code></pre>
		{#if hasMore}
			<div class="preview-more">+{lineCount - 12} more lines...</div>
		{/if}
	{:else}
		<div class="preview-missing">File no longer exists at this path</div>
	{/if}
	{#if drift === 'Drifted'}
		<div class="drift-notice">⚠️ Content has changed since this citation was created</div>
	{/if}
</div>

<style>
	.citation-preview {
		background: var(--surface-sunken);
		border: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		border-radius: var(--radius-md);
		overflow: hidden;
		cursor: pointer;
		transition: border-color var(--duration-fast) var(--ease-out);
	}

	.citation-preview:hover {
		border-color: color-mix(in srgb, var(--accent-primary) 40%, transparent);
	}

	.citation-preview.Drifted {
		border-color: color-mix(in srgb, var(--color-warning, #f59e0b) 40%, transparent);
	}

	.citation-preview.Missing {
		opacity: 0.6;
	}

	.preview-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: var(--space-1) var(--space-2);
		background: var(--surface-raised);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 10%, transparent);
	}

	.preview-path {
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
		color: var(--text-heading);
	}

	.preview-meta {
		font-size: var(--font-size-xs);
		color: var(--text-muted);
		display: flex;
		gap: var(--space-1);
	}

	.preview-lang {
		background: color-mix(in srgb, var(--accent-primary) 20%, transparent);
		padding: 1px 6px;
		border-radius: var(--radius-sm);
		font-size: var(--font-size-2xs);
	}

	.preview-content {
		margin: 0;
		padding: var(--space-2);
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
		line-height: 1.5;
		color: var(--text-secondary);
		overflow-x: auto;
		max-height: 200px;
		white-space: pre;
	}

	.preview-more {
		padding: var(--space-1) var(--space-2);
		color: var(--text-muted);
		font-size: var(--font-size-xs);
		text-align: center;
		background: var(--surface-raised);
	}

	.preview-missing {
		padding: var(--space-3);
		color: var(--text-muted);
		text-align: center;
		font-style: italic;
	}

	.drift-notice {
		padding: var(--space-1) var(--space-2);
		background: color-mix(in srgb, var(--color-warning, #f59e0b) 10%, transparent);
		color: var(--color-warning, #f59e0b);
		font-size: var(--font-size-xs);
		border-top: 1px solid color-mix(in srgb, var(--color-warning, #f59e0b) 20%, transparent);
	}
</style>