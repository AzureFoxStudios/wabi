<script lang="ts">
	import Prism from 'prismjs';
	import 'prismjs/components/prism-javascript';
	import 'prismjs/components/prism-typescript';
	import 'prismjs/components/prism-python';
	import 'prismjs/components/prism-java';
	import 'prismjs/components/prism-c';
	import 'prismjs/components/prism-cpp';
	import 'prismjs/components/prism-go';
	import 'prismjs/components/prism-rust';
	import 'prismjs/components/prism-bash';
	import 'prismjs/components/prism-json';
	import 'prismjs/components/prism-css';

	interface Props {
		diff: string;
		mode: 'unified' | 'side-by-side';
		onModeChange: (mode: 'unified' | 'side-by-side') => void;
		/** File path — used to pick the Prism grammar for highlighted hunks. */
		filePath?: string;
	}

	let { diff, mode, onModeChange, filePath }: Props = $props();

	let copied = $state(false);

	function copyDiff() {
		navigator.clipboard.writeText(diff);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}

	interface DiffLine {
		type: 'add' | 'remove' | 'context';
		content: string;
		/** 1-based line numbers in the old/new file (null when not present). */
		oldNo: number | null;
		newNo: number | null;
	}
	interface Hunk {
		header: string;
		lines: DiffLine[];
	}

	function parseHunks(text: string): Hunk[] {
		const hunks: Hunk[] = [];
		const hunkRegex = /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@(.*)?$/;
		let currentHunk: Hunk | null = null;
		let oldNo = 0;
		let newNo = 0;

		for (const raw of text.split('\n')) {
			const m = raw.match(hunkRegex);
			if (m) {
				oldNo = parseInt(m[1], 10);
				newNo = parseInt(m[3], 10);
				currentHunk = { header: raw, lines: [] };
				hunks.push(currentHunk);
				continue;
			}
			if (!currentHunk) continue;
			const h = currentHunk;
			if (raw.startsWith('+')) {
				h.lines.push({ type: 'add', content: raw, oldNo: null, newNo: newNo++ });
			} else if (raw.startsWith('-')) {
				h.lines.push({ type: 'remove', content: raw, oldNo: oldNo++, newNo: null });
			} else if (raw.startsWith(' ')) {
				h.lines.push({ type: 'context', content: raw, oldNo: oldNo++, newNo: newNo++ });
			} else if (raw.startsWith('\\')) {
				// "\ No newline at end of file" — annotate without numbers.
				h.lines.push({ type: 'context', content: raw, oldNo: null, newNo: null });
			}
		}
		return hunks;
	}

	/** Prism grammar for the file's language (null → plain text). */
	function grammarFor(path: string | undefined): { grammar: object; lang: string } | null {
		if (!path) return null;
		const ext = path.includes('.') ? path.split('.').pop()!.toLowerCase() : '';
		const map: Record<string, string> = {
			js: 'javascript',
			mjs: 'javascript',
			ts: 'typescript',
			py: 'python',
			java: 'java',
			c: 'c',
			h: 'c',
			cpp: 'cpp',
			cc: 'cpp',
			hpp: 'cpp',
			go: 'go',
			rs: 'rust',
			sh: 'bash',
			bash: 'bash',
			json: 'json',
			css: 'css',
			tsx: 'typescript',
			jsx: 'javascript'
		};
		const lang = map[ext];
		if (!lang) return null;
		const grammar = (Prism.languages as Record<string, object | undefined>)[lang];
		return grammar ? { grammar, lang } : null;
	}

	/**
	 * Highlight a diff line's code portion (after the +/-/space marker).
	 * Prism escapes &, <, > while tokenizing, so the output is safe to embed.
	 */
	const highlightCache = new Map<string, string>();
	function highlight(line: DiffLine): string {
		const code = line.content.slice(1);
		const g = grammarFor(filePath);
		if (!g) return escapeHtml(code);
		const key = `${g.lang}\u0000${code}`;
		let html = highlightCache.get(key);
		if (html === undefined) {
			html = Prism.highlight(code, g.grammar as Prism.Grammar, g.lang);
			if (highlightCache.size > 5000) highlightCache.clear();
			highlightCache.set(key, html);
		}
		return html;
	}

	function escapeHtml(s: string): string {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	let hunks = $derived(parseHunks(diff));
	let added = $derived(hunks.flatMap((h) => h.lines).filter((l) => l.type === 'add').length);
	let removed = $derived(hunks.flatMap((h) => h.lines).filter((l) => l.type === 'remove').length);
</script>

<div class="diff-viewer mode-{mode}">
	<div class="diff-toolbar">
		<div class="diff-stats">
			<span class="stat add">+{added}</span>
			<span class="stat remove">-{removed}</span>
			{#if filePath}
				<span class="stat path" title={filePath}>{filePath.split('/').pop()}</span>
			{/if}
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
					<div class="hunk-header">
						<span class="hunk-text">{hunk.header}</span>
					</div>
					<pre class="hunk-lines"><code>
						{#each hunk.lines as line}
							<div class="diff-line {line.type}">
								<span class="ln old">{line.oldNo ?? ''}</span>
								<span class="ln new">{line.newNo ?? ''}</span>
								<span class="marker">{line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}</span>
								<span class="code"><!-- eslint-disable-next-line svelte/no-at-html-tags -->{@html highlight(line)}</span>
							</div>
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
									<div class="diff-line {line.type}">
										<span class="ln">{line.oldNo ?? ''}</span>
										<span class="marker">{line.type === 'remove' ? '−' : ' '}</span>
										<span class="code"><!-- eslint-disable-next-line svelte/no-at-html-tags -->{@html highlight(line)}</span>
									</div>
								{/if}
							{/each}
						</div>
						<div class="sbs-pane new">
							{#each hunk.lines as line}
								{#if line.type === 'add' || line.type === 'context'}
									<div class="diff-line {line.type}">
										<span class="ln">{line.newNo ?? ''}</span>
										<span class="marker">{line.type === 'add' ? '+' : ' '}</span>
										<span class="code"><!-- eslint-disable-next-line svelte/no-at-html-tags -->{@html highlight(line)}</span>
									</div>
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
		align-items: center;
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

	.stat.path {
		background: var(--surface-sunken);
		color: var(--text-muted);
		font-weight: 400;
		font-family: var(--font-mono);
	}

	.diff-controls {
		display: flex;
		gap: var(--space-1);
	}

	.mode-btn,
	.copy-btn {
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
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 10%, transparent);
		color: var(--text-heading);
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
		display: flex;
		padding: 0 var(--space-2) 0 0;
		line-height: 1.6;
		white-space: pre;
	}

	.ln {
		display: inline-block;
		width: 3.5em;
		text-align: right;
		padding-right: 6px;
		color: var(--text-muted);
		opacity: 0.7;
		user-select: none;
		flex-shrink: 0;
		font-size: var(--font-size-xs);
	}

	.marker {
		display: inline-block;
		width: 1.2em;
		text-align: center;
		user-select: none;
		flex-shrink: 0;
		font-weight: 700;
	}

	.code {
		flex: 1;
		min-width: 0;
	}

	.diff-line.add {
		background: color-mix(in srgb, var(--color-success, #22c55e) 10%, transparent);
	}

	.diff-line.add .marker {
		color: var(--color-success, #22c55e);
	}

	.diff-line.remove {
		background: color-mix(in srgb, var(--color-danger, #ef4444) 10%, transparent);
	}

	.diff-line.remove .marker {
		color: var(--color-danger, #ef4444);
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

	/* Prism token colors (namespaced to diff code) */
	.code :global(.token.comment),
	.code :global(.token.prolog),
	.code :global(.token.doctype),
	.code :global(.token.cdata) {
		color: #7f848e;
		font-style: italic;
	}
	.code :global(.token.punctuation) {
		color: #abb2bf;
	}
	.code :global(.token.keyword),
	.code :global(.token.selector),
	.code :global(.token.important) {
		color: #c678dd;
	}
	.code :global(.token.string),
	.code :global(.token.char),
	.code :global(.token.attr-value) {
		color: #98c379;
	}
	.code :global(.token.function) {
		color: #61afef;
	}
	.code :global(.token.number),
	.code :global(.token.boolean) {
		color: #d19a66;
	}
	.code :global(.token.class-name),
	.code :global(.token.builtin) {
		color: #e5c07b;
	}
	.code :global(.token.operator) {
		color: #56b6c2;
	}
</style>
