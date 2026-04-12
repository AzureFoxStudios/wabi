<script lang="ts">
	import { tick } from 'svelte';
	import DOMPurify from 'dompurify';
	import '$lib/prism-theme.css';
	import { parseMessage } from '$lib/markdown';
	import {
		clearReaderSelection,
		openReaderDocument,
		openReaderHistoryEntry,
		openTemporaryReaderFile,
		type ReaderContentWidth,
		readerHistory,
		type ReaderFontFamily,
		readerPreferences,
		readerProgressByDocument,
		readerSelection,
		setReaderDocumentProgress,
		type ReaderTheme,
		updateReaderPreferences,
		type ReaderDocumentFormat
	} from '$lib/readerWorkspace';

	const ACCEPTED_READER_FILE_TYPES = '.md,.markdown,.txt,.text,.html,.htm';
	const SANITIZE_CONFIG = {
		USE_PROFILES: { html: true }
	};

	let articleViewport: HTMLDivElement | null = null;
	let fileInput: HTMLInputElement | null = null;
	let importPanelOpen = false;
	let readerChromeHidden = false;
	let importTitle = '';
	let importContent = '';
	let importFormat: ReaderDocumentFormat = 'markdown';
	let importBusy = false;
	let readerProgressPercent = 0;
	let lastRestoredDocKey = '';

	function escapeHtml(value: string): string {
		return value
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	function renderPlainText(content: string): string {
		const normalized = content.replace(/\r\n/g, '\n').trim();
		if (!normalized) return '<p></p>';
		return normalized
			.split(/\n{2,}/)
			.map((block) => `<p>${block.split('\n').map((line) => escapeHtml(line)).join('<br>')}</p>`)
			.join('');
	}

	function renderReaderHtml(
		content: string,
		format: ReaderDocumentFormat
	): string {
		if (!content.trim()) {
			return '<p class="reader-empty-copy">No content loaded yet.</p>';
		}
		if (format === 'markdown') return parseMessage(content);
		if (format === 'html') return DOMPurify.sanitize(content, SANITIZE_CONFIG);
		return renderPlainText(content);
	}

	function countWords(value: string): number {
		return value
			.trim()
			.split(/\s+/)
			.filter(Boolean).length;
	}

	function formatSourceLabel(source: string): string {
		if (source === 'local-temp') return 'Local file';
		if (source === 'pasted') return 'Pasted';
		if (source === 'chat') return 'Chat';
		if (source === 'notes') return 'Notes';
		return 'Reader';
	}

	function openImportPanel(format: ReaderDocumentFormat): void {
		importFormat = format;
		importPanelOpen = true;
	}

	function closeImportPanel(): void {
		importPanelOpen = false;
		importTitle = '';
		importContent = '';
		importFormat = 'markdown';
	}

	function submitImportedDocument(): void {
		if (!importContent.trim()) return;
		openReaderDocument(
			importTitle.trim() || 'Pasted Document',
			importContent,
			importFormat,
			'pasted'
		);
		closeImportPanel();
	}

	function openFilePicker(): void {
		fileInput?.click();
	}

	async function handleFileChange(event: Event): Promise<void> {
		const target = event.currentTarget as HTMLInputElement;
		const file = target.files?.[0];
		target.value = '';
		if (!file) return;
		importBusy = true;
		try {
			await openTemporaryReaderFile(file);
		} finally {
			importBusy = false;
		}
	}

	function handleViewportScroll(): void {
		if (!$readerSelection || !articleViewport) {
			readerProgressPercent = 0;
			return;
		}
		const maxScroll = Math.max(0, articleViewport.scrollHeight - articleViewport.clientHeight);
		const progress = maxScroll <= 0 ? 0 : articleViewport.scrollTop / maxScroll;
		readerProgressPercent = Math.round(progress * 100);
		setReaderDocumentProgress($readerSelection.docKey, progress);
	}

	function handleThemeChange(event: Event): void {
		const value = (event.currentTarget as HTMLSelectElement).value as ReaderTheme;
		updateReaderPreferences({ theme: value });
	}

	function handleFontFamilyChange(event: Event): void {
		const value = (event.currentTarget as HTMLSelectElement).value as ReaderFontFamily;
		updateReaderPreferences({ fontFamily: value });
	}

	function handleContentWidthChange(event: Event): void {
		const value = (event.currentTarget as HTMLSelectElement).value as ReaderContentWidth;
		updateReaderPreferences({ contentWidth: value });
	}

	$: renderedDocumentHtml = $readerSelection
		? renderReaderHtml($readerSelection.content, $readerSelection.format)
		: '';
	$: selectedWordCount = $readerSelection ? countWords($readerSelection.content) : 0;
	$: selectedReadMinutes = Math.max(1, Math.ceil(selectedWordCount / 220));
	$: selectedStoredProgress = $readerSelection
		? $readerProgressByDocument[$readerSelection.docKey] ?? 0
		: 0;
	$: if (!$readerSelection) {
		lastRestoredDocKey = '';
		readerProgressPercent = 0;
	}
	$: if ($readerSelection && articleViewport && $readerSelection.docKey !== lastRestoredDocKey) {
		lastRestoredDocKey = $readerSelection.docKey;
		const nextProgress = selectedStoredProgress;
		void tick().then(() => {
			if (!articleViewport) return;
			const maxScroll = Math.max(0, articleViewport.scrollHeight - articleViewport.clientHeight);
			articleViewport.scrollTop = maxScroll * nextProgress;
			readerProgressPercent = Math.round(nextProgress * 100);
		});
	}
</script>

<div
	class="reader-shell"
	class:theme-paper={$readerPreferences.theme === 'paper'}
	class:theme-sepia={$readerPreferences.theme === 'sepia'}
	class:theme-night={$readerPreferences.theme === 'night'}
	class:font-serif={$readerPreferences.fontFamily === 'serif'}
	class:font-sans={$readerPreferences.fontFamily === 'sans'}
	class:width-narrow={$readerPreferences.contentWidth === 'narrow'}
	class:width-medium={$readerPreferences.contentWidth === 'medium'}
	class:width-wide={$readerPreferences.contentWidth === 'wide'}
>
	{#if !readerChromeHidden}
		<div class="reader-toolbar">
			<div class="reader-toolbar-main">
				<div class="reader-title-group">
					<span class="reader-kicker">Reader Mode</span>
					{#if $readerSelection}
						<h2>{$readerSelection.title}</h2>
						<div class="reader-meta">
							<span>{selectedWordCount.toLocaleString()} words</span>
							<span>{selectedReadMinutes} min read</span>
							<span>{readerProgressPercent}%</span>
							<span>{formatSourceLabel($readerSelection.source)}</span>
						</div>
					{:else}
						<h2>Open a long-form document</h2>
						<div class="reader-meta">
							<span>Markdown, text, or HTML</span>
							<span>Recent history stays available during this session</span>
						</div>
					{/if}
				</div>

				<div class="reader-toolbar-actions">
					<button class="reader-action-btn" type="button" on:click={openFilePicker} disabled={importBusy}>
						{importBusy ? 'Opening...' : 'Open File'}
					</button>
					<button class="reader-action-btn" type="button" on:click={() => openImportPanel('markdown')}>
						Paste Markdown
					</button>
					<button class="reader-action-btn" type="button" on:click={() => openImportPanel('text')}>
						Paste Text
					</button>
					{#if $readerSelection}
						<button class="reader-action-btn subtle" type="button" on:click={clearReaderSelection}>
							Clear
						</button>
					{/if}
					<button class="reader-action-btn subtle" type="button" on:click={() => (readerChromeHidden = true)}>
						Focus
					</button>
				</div>
			</div>

			<div class="reader-toolbar-secondary">
				<div class="reader-control">
					<label for="reader-history-select">Recent</label>
					<select
						id="reader-history-select"
						class="reader-select"
						on:change={(event) => {
							const value = (event.currentTarget as HTMLSelectElement).value;
							if (value) openReaderHistoryEntry(value);
							(event.currentTarget as HTMLSelectElement).value = '';
						}}
					>
						<option value="">Recent documents</option>
						{#each $readerHistory as entry}
							<option value={entry.id}>{entry.title}</option>
						{/each}
					</select>
				</div>

				<div class="reader-control">
					<label for="reader-theme-select">Theme</label>
					<select
						id="reader-theme-select"
						class="reader-select"
						value={$readerPreferences.theme}
						on:change={handleThemeChange}
					>
						<option value="paper">Paper</option>
						<option value="sepia">Sepia</option>
						<option value="night">Night</option>
					</select>
				</div>

				<div class="reader-control">
					<label for="reader-font-select">Font</label>
					<select
						id="reader-font-select"
						class="reader-select"
						value={$readerPreferences.fontFamily}
						on:change={handleFontFamilyChange}
					>
						<option value="serif">Serif</option>
						<option value="sans">Sans</option>
					</select>
				</div>

				<div class="reader-control compact">
					<label for="reader-width-select">Width</label>
					<select
						id="reader-width-select"
						class="reader-select"
						value={$readerPreferences.contentWidth}
						on:change={handleContentWidthChange}
					>
						<option value="narrow">Narrow</option>
						<option value="medium">Medium</option>
						<option value="wide">Wide</option>
					</select>
				</div>

				<div class="reader-slider">
					<label for="reader-font-size">Size {$readerPreferences.fontSize}px</label>
					<input
						id="reader-font-size"
						type="range"
						min="14"
						max="28"
						step="1"
						value={$readerPreferences.fontSize}
						on:input={(event) => updateReaderPreferences({ fontSize: Number(event.currentTarget.value) })}
					/>
				</div>

				<div class="reader-slider">
					<label for="reader-line-height">Line {$readerPreferences.lineHeight.toFixed(2)}</label>
					<input
						id="reader-line-height"
						type="range"
						min="1.35"
						max="2.30"
						step="0.05"
						value={$readerPreferences.lineHeight}
						on:input={(event) => updateReaderPreferences({ lineHeight: Number(event.currentTarget.value) })}
					/>
				</div>
			</div>
		</div>
	{:else}
		<button class="reader-focus-return" type="button" on:click={() => (readerChromeHidden = false)}>
			Show Reader Controls
		</button>
	{/if}

	{#if importPanelOpen}
		<div class="reader-import-sheet">
			<div class="reader-import-card">
				<div class="reader-import-header">
					<h3>Import Into Reader</h3>
					<button class="reader-action-btn subtle" type="button" on:click={closeImportPanel}>Close</button>
				</div>
				<div class="reader-import-grid">
					<label class="reader-field">
						<span>Title</span>
						<input
							type="text"
							bind:value={importTitle}
							placeholder="Document title"
						/>
					</label>
					<label class="reader-field">
						<span>Format</span>
						<select bind:value={importFormat}>
							<option value="markdown">Markdown</option>
							<option value="text">Plain text</option>
							<option value="html">HTML</option>
						</select>
					</label>
				</div>
				<label class="reader-field block">
					<span>Content</span>
					<textarea
						bind:value={importContent}
						rows="14"
						placeholder="Paste an article, chapter, essay, or issue draft here."
					></textarea>
				</label>
				<div class="reader-import-actions">
					<button class="reader-action-btn" type="button" on:click={submitImportedDocument} disabled={!importContent.trim()}>
						Open In Reader
					</button>
				</div>
			</div>
		</div>
	{/if}

	<div class="reader-stage">
		{#if $readerSelection}
			<div class="reader-document-shell">
				<div
					class="reader-document-viewport"
					bind:this={articleViewport}
					on:scroll={handleViewportScroll}
				>
					<article
						class="reader-document markdown-content"
						style={`font-size: ${$readerPreferences.fontSize}px; line-height: ${$readerPreferences.lineHeight};`}
					>
						<header class="reader-document-header">
							<h1>{$readerSelection.title}</h1>
							<p class="reader-document-dek">
								{selectedWordCount.toLocaleString()} words | {selectedReadMinutes} min read | {readerProgressPercent}% complete
							</p>
						</header>
						{@html renderedDocumentHtml}
					</article>
				</div>
			</div>
		{:else}
			<div class="reader-empty-state">
				<div class="reader-empty-card">
					<h3>Reader Mode is ready</h3>
					<p>Open a local text file, paste long-form writing, or keep this tab available for future article and publication flows.</p>
					<div class="reader-empty-actions">
						<button class="reader-action-btn" type="button" on:click={openFilePicker}>Open File</button>
						<button class="reader-action-btn" type="button" on:click={() => openImportPanel('markdown')}>Paste Markdown</button>
						<button class="reader-action-btn subtle" type="button" on:click={() => openReaderDocument('Reader Welcome', '# Reader Mode\n\nWabi now has a dedicated long-form reading surface.\n\nUse it for essays, books, issue drafts, and documentation.\n\n## Suggested next steps\n\n- Import a `.md`, `.txt`, or `.html` file\n- Adjust width and typography\n- Re-open recent documents from the toolbar\n', 'markdown', 'generated')}>
							Load Sample
						</button>
					</div>
				</div>
			</div>
		{/if}
	</div>

	<input
		bind:this={fileInput}
		class="hidden-input"
		type="file"
		accept={ACCEPTED_READER_FILE_TYPES}
		on:change={handleFileChange}
	/>
</div>

<style>
	.reader-shell {
		height: 100%;
		min-height: 0;
		display: flex;
		flex-direction: column;
		position: relative;
		overflow: hidden;
		background:
			radial-gradient(circle at top, rgba(255, 255, 255, 0.38), transparent 32%),
			linear-gradient(180deg, rgba(0, 0, 0, 0.02), transparent 18%),
			var(--reader-bg, #f5f0e6);
		color: var(--reader-text, #2f2418);
	}

	.reader-shell.theme-paper {
		--reader-bg: #f7f4ec;
		--reader-surface: rgba(255, 252, 245, 0.86);
		--reader-text: #2f2418;
		--reader-muted: #776b5e;
		--reader-border: rgba(87, 71, 54, 0.14);
		--reader-accent: #9d5a2f;
	}

	.reader-shell.theme-sepia {
		--reader-bg: #efe2ca;
		--reader-surface: rgba(252, 244, 228, 0.9);
		--reader-text: #3f2f21;
		--reader-muted: #7b6752;
		--reader-border: rgba(108, 79, 46, 0.18);
		--reader-accent: #8c4f2a;
	}

	.reader-shell.theme-night {
		--reader-bg: #13161d;
		--reader-surface: rgba(21, 26, 35, 0.88);
		--reader-text: #e7ebf3;
		--reader-muted: #a8b2c3;
		--reader-border: rgba(168, 178, 195, 0.16);
		--reader-accent: #6fa8ff;
	}

	.reader-shell.font-serif {
		font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif;
	}

	.reader-shell.font-sans {
		font-family: "Aptos", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
	}

	.reader-toolbar {
		padding: 1rem 1.1rem 0.85rem;
		border-bottom: 1px solid var(--reader-border);
		background: linear-gradient(180deg, rgba(255, 255, 255, 0.08), transparent), var(--reader-surface);
		backdrop-filter: blur(14px);
	}

	.reader-toolbar-main {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}

	.reader-title-group {
		min-width: 0;
	}

	.reader-kicker {
		display: inline-flex;
		font-size: 0.73rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--reader-accent);
		font-weight: 700;
	}

	.reader-title-group h2 {
		margin: 0.25rem 0 0;
		font-size: 1.45rem;
		line-height: 1.15;
	}

	.reader-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.55rem;
		margin-top: 0.45rem;
		font-size: 0.78rem;
		color: var(--reader-muted);
	}

	.reader-meta span {
		padding: 0.08rem 0.45rem;
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.04);
	}

	.reader-shell.theme-night .reader-meta span {
		background: rgba(255, 255, 255, 0.06);
	}

	.reader-toolbar-actions,
	.reader-toolbar-secondary,
	.reader-empty-actions,
	.reader-import-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.55rem;
	}

	.reader-toolbar-actions {
		justify-content: flex-end;
	}

	.reader-toolbar-secondary {
		align-items: flex-end;
		margin-top: 0.9rem;
	}

	.reader-control,
	.reader-slider {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.reader-control label,
	.reader-slider label,
	.reader-field span {
		font-size: 0.73rem;
		font-weight: 700;
		letter-spacing: 0.03em;
		color: var(--reader-muted);
	}

	.reader-select,
	.reader-field input,
	.reader-field select,
	.reader-field textarea,
	.reader-action-btn {
		border: 1px solid var(--reader-border);
		border-radius: 12px;
		background: rgba(255, 255, 255, 0.7);
		color: inherit;
	}

	.reader-shell.theme-night .reader-select,
	.reader-shell.theme-night .reader-field input,
	.reader-shell.theme-night .reader-field select,
	.reader-shell.theme-night .reader-field textarea,
	.reader-shell.theme-night .reader-action-btn {
		background: rgba(10, 14, 20, 0.78);
	}

	.reader-select,
	.reader-field input,
	.reader-field select {
		padding: 0.5rem 0.7rem;
		min-height: 2.2rem;
	}

	.reader-select {
		min-width: 8.5rem;
	}

	.reader-slider input {
		accent-color: var(--reader-accent);
	}

	.reader-action-btn {
		padding: 0.55rem 0.8rem;
		font-size: 0.8rem;
		font-weight: 700;
		cursor: pointer;
		transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
	}

	.reader-action-btn:hover {
		transform: translateY(-1px);
		border-color: color-mix(in srgb, var(--reader-accent) 45%, var(--reader-border));
	}

	.reader-action-btn.subtle {
		background: transparent;
	}

	.reader-focus-return {
		position: absolute;
		top: 0.85rem;
		right: 0.85rem;
		z-index: 10;
		border: 1px solid var(--reader-border);
		border-radius: 999px;
		background: var(--reader-surface);
		color: inherit;
		padding: 0.55rem 0.9rem;
		cursor: pointer;
	}

	.reader-stage,
	.reader-document-shell,
	.reader-document-viewport {
		flex: 1;
		min-height: 0;
	}

	.reader-document-viewport {
		overflow-y: auto;
		padding: 1.5rem 1rem 2rem;
	}

	.reader-document {
		margin: 0 auto;
		max-width: 52rem;
		padding: 2.1rem clamp(1.2rem, 2vw, 2rem) 3rem;
		border: 1px solid var(--reader-border);
		border-radius: 24px;
		background: var(--reader-surface);
		box-shadow: 0 18px 44px rgba(0, 0, 0, 0.08);
		color: inherit;
	}

	.reader-shell.width-narrow .reader-document {
		max-width: 42rem;
	}

	.reader-shell.width-medium .reader-document {
		max-width: 54rem;
	}

	.reader-shell.width-wide .reader-document {
		max-width: 66rem;
	}

	.reader-document-header {
		margin-bottom: 1.7rem;
		padding-bottom: 1rem;
		border-bottom: 1px solid var(--reader-border);
	}

	.reader-document-header h1 {
		margin: 0;
		font-size: clamp(2rem, 3.6vw, 3.2rem);
		line-height: 0.98;
		letter-spacing: -0.03em;
	}

	.reader-document-dek {
		margin: 0.7rem 0 0;
		color: var(--reader-muted);
		font-size: 0.92rem;
	}

	.reader-document :global(h1),
	.reader-document :global(h2),
	.reader-document :global(h3),
	.reader-document :global(h4),
	.reader-document :global(h5),
	.reader-document :global(h6) {
		line-height: 1.12;
		letter-spacing: -0.02em;
		margin-top: 1.65em;
		margin-bottom: 0.55em;
	}

	.reader-document :global(p),
	.reader-document :global(li),
	.reader-document :global(blockquote) {
		color: inherit;
	}

	.reader-document :global(p) {
		margin: 0 0 1.05em;
	}

	.reader-document :global(blockquote) {
		margin: 1.35rem 0;
		padding: 0.2rem 0 0.2rem 1rem;
		border-left: 3px solid color-mix(in srgb, var(--reader-accent) 60%, transparent);
		color: var(--reader-muted);
		font-style: italic;
	}

	.reader-document :global(pre) {
		background: rgba(0, 0, 0, 0.08);
		border-radius: 14px;
		padding: 0.95rem;
		overflow-x: auto;
	}

	.reader-shell.theme-night .reader-document :global(pre) {
		background: rgba(255, 255, 255, 0.07);
	}

	.reader-document :global(a) {
		color: var(--reader-accent);
	}

	.reader-document :global(img) {
		max-width: 100%;
		border-radius: 12px;
	}

	.reader-empty-state {
		flex: 1;
		display: grid;
		place-items: center;
		padding: 1.5rem;
	}

	.reader-empty-card {
		max-width: 34rem;
		padding: 1.5rem;
		border-radius: 24px;
		border: 1px solid var(--reader-border);
		background: var(--reader-surface);
		box-shadow: 0 16px 40px rgba(0, 0, 0, 0.08);
	}

	.reader-empty-card h3 {
		margin: 0 0 0.6rem;
		font-size: 1.4rem;
	}

	.reader-empty-card p {
		margin: 0 0 1rem;
		color: var(--reader-muted);
	}

	.reader-import-sheet {
		position: absolute;
		inset: 0;
		z-index: 12;
		padding: 1.1rem;
		background: rgba(12, 15, 20, 0.34);
		backdrop-filter: blur(10px);
		display: grid;
		place-items: center;
	}

	.reader-import-card {
		width: min(100%, 56rem);
		max-height: min(88vh, 52rem);
		overflow-y: auto;
		padding: 1.1rem;
		border-radius: 22px;
		border: 1px solid var(--reader-border);
		background: var(--reader-surface);
		box-shadow: 0 20px 50px rgba(0, 0, 0, 0.18);
	}

	.reader-import-header,
	.reader-import-grid {
		display: flex;
		gap: 0.9rem;
	}

	.reader-import-header {
		align-items: center;
		justify-content: space-between;
		margin-bottom: 1rem;
	}

	.reader-import-header h3 {
		margin: 0;
	}

	.reader-import-grid {
		margin-bottom: 0.9rem;
	}

	.reader-field {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.reader-field.block {
		margin-bottom: 0.9rem;
	}

	.reader-field textarea {
		min-height: 18rem;
		padding: 0.8rem 0.9rem;
		resize: vertical;
		font: inherit;
	}

	.hidden-input {
		display: none;
	}

	@media (max-width: 960px) {
		.reader-toolbar-main,
		.reader-import-grid {
			flex-direction: column;
		}

		.reader-toolbar-actions {
			justify-content: flex-start;
		}

		.reader-document-viewport {
			padding-inline: 0.7rem;
		}

		.reader-document {
			padding: 1.3rem 1rem 2rem;
			border-radius: 20px;
		}
	}

	@media (max-width: 700px) {
		.reader-toolbar {
			padding: 0.85rem 0.8rem 0.7rem;
		}

		.reader-toolbar-secondary {
			flex-direction: column;
			align-items: stretch;
		}

		.reader-select {
			min-width: 0;
			width: 100%;
		}

		.reader-document-viewport {
			padding: 0.75rem;
		}

		.reader-document-header h1 {
			font-size: clamp(1.8rem, 10vw, 2.6rem);
		}
	}
</style>
