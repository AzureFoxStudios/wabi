<script lang="ts">
	import type { LoreFileInfo } from '$lib/api/lore';

	interface Props {
		filePath: string;
		fileContent: string | null;
		fileInfo: LoreFileInfo | null;
		loading: boolean;
		onClose: () => void;
	}

	let { filePath, fileContent, fileInfo, loading, onClose }: Props = $props();

	let copied = $state(false);

	function copyContent() {
		if (fileContent) {
			navigator.clipboard.writeText(fileContent);
			copied = true;
			setTimeout(() => copied = false, 2000);
		}
	}

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes}B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}

	function isBinary(content: string | null): boolean {
		return content === null;
	}

	function isLarge(): boolean {
		return fileInfo ? fileInfo.size > 1024 * 1024 : false;
	}

	let lines = $derived(fileContent ? fileContent.split('\n') : []);
</script>

<div class="lore-file-viewer">
	<div class="viewer-toolbar">
		<div class="file-meta">
			<span class="file-path">{filePath}</span>
			{#if fileInfo}
				<span class="file-size">{formatSize(fileInfo.size)}</span>
			{/if}
		</div>
		<div class="viewer-actions">
			{#if !isBinary(fileContent) && fileContent}
				<button class="action-btn" onclick={copyContent} aria-label="Copy file content">
					{copied ? '✓' : '📋'}
				</button>
			{/if}
			<button class="action-btn close-btn" onclick={onClose} aria-label="Close file">✕</button>
		</div>
	</div>

	{#if loading}
		<div class="viewer-loading">Loading...</div>
	{:else if isBinary(fileContent)}
		<div class="viewer-binary">
			<span class="binary-icon">📦</span>
			<p>Binary file — download to view</p>
			{#if fileInfo}
				<p class="binary-info">{fileInfo.path.split('.').pop()} · {formatSize(fileInfo.size)}</p>
			{/if}
		</div>
	{:else if isLarge() && fileContent}
		<div class="viewer-large">
			<p>File too large for inline view ({formatSize(fileInfo!.size)})</p>
			<pre class="preview-lines"><code>{lines.slice(0, 100).join('\n')}</code></pre>
			<p class="large-note">Showing first 100 lines. Download for full content.</p>
		</div>
	{:else if fileContent}
		<pre class="code-content"><code>
			{#each lines as line, i}
				<div class="code-line">
					<span class="line-number">{i + 1}</span>
					<span class="line-text">{line}</span>
				</div>
			{/each}
		</code></pre>
	{:else}
		<div class="viewer-empty">No content</div>
	{/if}
</div>

<style>
	.lore-file-viewer {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
	}

	.viewer-toolbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: var(--space-1) var(--space-2);
		background: var(--surface-raised);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
	}

	.file-meta {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--font-size-sm);
	}

	.file-path {
		color: var(--text-heading);
		font-family: var(--font-mono);
		max-width: 300px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-size, .file-hash {
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
	}

	.viewer-actions {
		display: flex;
		gap: var(--space-1);
	}

	.action-btn {
		padding: 2px 6px;
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		cursor: pointer;
		font-size: var(--font-size-sm);
		color: var(--text-muted);
	}

	.action-btn:hover {
		background: var(--surface-sunken);
		color: var(--text-heading);
	}

	.code-content {
		flex: 1;
		margin: 0;
		padding: var(--space-2);
		overflow: auto;
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
		line-height: 1.6;
	}

	.code-line {
		display: flex;
	}

	.line-number {
		display: inline-block;
		width: 4em;
		text-align: right;
		padding-right: var(--space-2);
		color: var(--text-muted);
		user-select: none;
		flex-shrink: 0;
	}

	.line-text {
		white-space: pre;
		color: var(--text-heading);
	}

	.viewer-loading, .viewer-binary, .viewer-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-4);
		color: var(--text-muted);
	}

	.viewer-binary {
		flex-direction: column;
		gap: var(--space-2);
	}

	.binary-icon {
		font-size: 48px;
	}

	.binary-info {
		font-size: var(--font-size-sm);
		color: var(--text-muted);
	}

	.viewer-large {
		display: flex;
		flex-direction: column;
		padding: var(--space-2);
	}

	.preview-lines {
		flex: 1;
		margin: var(--space-2) 0;
		padding: var(--space-2);
		overflow: auto;
		background: var(--surface-sunken);
		border-radius: var(--radius-sm);
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
	}

	.large-note {
		color: var(--text-muted);
		font-size: var(--font-size-sm);
	}
</style>