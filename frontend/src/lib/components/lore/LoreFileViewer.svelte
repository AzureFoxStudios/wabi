<script lang="ts">
	import type { LoreFileInfo } from '$lib/api/lore';
	import { parseMessage } from '$lib/markdown';
	import { isMarkdownPath } from '$lib/lore/readmeDefault';
	import {
		LoreConflictError,
		downloadLoreFileText,
		getSignedLoreUrl,
		saveLoreFileContent
	} from '$lib/api/lore';
	import { EditorState, type Extension } from '@codemirror/state';
	import { EditorView, keymap, lineNumbers } from '@codemirror/view';
	import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
	import { oneDark } from '@codemirror/theme-one-dark';
	import { javascript } from '@codemirror/lang-javascript';
	import { json } from '@codemirror/lang-json';
	import { markdown } from '@codemirror/lang-markdown';
	import { python } from '@codemirror/lang-python';
	import { rust } from '@codemirror/lang-rust';
	import { cpp } from '@codemirror/lang-cpp';
	import { css } from '@codemirror/lang-css';
	import { html } from '@codemirror/lang-html';
	import { java } from '@codemirror/lang-java';
	import { go } from '@codemirror/lang-go';

	interface Props {
		filePath: string;
		fileContent: string | null;
		fileInfo: LoreFileInfo | null;
		loading: boolean;
		onClose: () => void;
		/** Signed URL for image previews (caller skips text-loading media). */
		mediaUrl?: string | null;
		/** Enable the in-browser editor (role-gated by the caller). */
		canEdit?: boolean;
		/** Required for editing: auth token + channel the repo lives in. */
		token?: string;
		channelId?: number;
		/** Called after a successful save so the caller can refresh listings. */
		onSaved?: () => void;
	}

	let {
		filePath,
		fileContent,
		mediaUrl = null,
		fileInfo,
		loading,
		onClose,
		canEdit = false,
		token,
		channelId,
		onSaved
	}: Props = $props();

	let copied = $state(false);
	let editing = $state(false);
	/** Markdown files render like wiki/chat documents; source toggle available. */
	let mdMode = $state<'rendered' | 'source'>('rendered');
	const MD_RENDER_CAP_BYTES = 512 * 1024;
	$effect(() => {
		filePath; // reset the preference whenever a different file opens
		mdMode = 'rendered';
	});
	let isMarkdown = $derived(isMarkdownPath(filePath));
	let mdRenderable = $derived(
		isMarkdown && !!fileContent && fileContent.length <= MD_RENDER_CAP_BYTES
	);
	let enteringEdit = $state(false);
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	/** Server etag the editor's content is based on (If-Match baseline). */
	let baselineEtag = $state<string | null>(null);
	/** Set when a save hit a 409 — carries the server's current etag. */
	let conflict = $state<{ currentEtag: string | null } | null>(null);
	let savedFlash = $state(false);

	let host: HTMLDivElement | undefined = $state();
	let view = $state<EditorView | null>(null);

	async function downloadFile() {
		if (!token || channelId === undefined) return;
		try {
			const url = await getSignedLoreUrl(token, channelId, filePath);
			const a = document.createElement('a');
			a.href = url;
			a.download = filePath.split('/').pop() || 'file';
			a.click();
		} catch {
			// Best effort — the viewer still works without downloads.
		}
	}

	function copyContent() {
		if (fileContent) {
			navigator.clipboard.writeText(fileContent);
			copied = true;
			setTimeout(() => (copied = false), 2000);
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

	/** Map a file extension to a CodeMirror language extension. */
	function languageFor(path: string): Extension | null {
		const ext = path.includes('.') ? path.split('.').pop()!.toLowerCase() : '';
		switch (ext) {
			case 'js':
			case 'mjs':
			case 'cjs':
				return javascript();
			case 'ts':
				return javascript({ typescript: true });
			case 'jsx':
				return javascript({ jsx: true });
			case 'tsx':
				return javascript({ typescript: true, jsx: true });
			case 'json':
				return json();
			case 'md':
			case 'markdown':
				return markdown();
			case 'py':
				return python();
			case 'rs':
				return rust();
			case 'c':
			case 'h':
			case 'cpp':
			case 'cc':
			case 'hpp':
				return cpp();
			case 'css':
				return css();
			case 'html':
			case 'htm':
			case 'svelte':
			case 'vue':
			case 'xml':
				return html();
			case 'java':
				return java();
			case 'go':
				return go();
			default:
				return null;
		}
	}

	/** Whether this file can be edited in the browser (text + not huge + creds). */
	let editable = $derived(
		canEdit &&
			!!token &&
			channelId !== undefined &&
			!isBinary(fileContent) &&
			!isLarge() &&
			!filePath.endsWith('.png') // sanity: binary extensions never reach edit mode
	);

	async function enterEditMode() {
		if (!token || channelId === undefined) return;
		enteringEdit = true;
		saveError = null;
		conflict = null;
		try {
			// Re-fetch so the editor starts from the authoritative server content
			// and captures its etag as the If-Match baseline.
			const { content, etag } = await downloadLoreFileText(token, channelId, filePath);
			fileContent = content;
			baselineEtag = etag;
			editing = true;
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Failed to load file for editing';
		} finally {
			enteringEdit = false;
		}
	}

	function exitEditMode() {
		editing = false;
		conflict = null;
		saveError = null;
	}

	async function performSave(ifMatch: string | null) {
		if (!token || channelId === undefined || !view) return;
		saving = true;
		saveError = null;
		conflict = null;
		try {
			const content = view.state.doc.toString();
			const result = await saveLoreFileContent(
				token,
				channelId,
				filePath,
				content,
				ifMatch,
				`Edit ${filePath} in Wabi`
			);
			baselineEtag = result.etag || baselineEtag;
			savedFlash = true;
			setTimeout(() => (savedFlash = false), 1500);
			onSaved?.();
		} catch (e) {
			if (e instanceof LoreConflictError) {
				conflict = { currentEtag: e.currentEtag };
			} else {
				saveError = e instanceof Error ? e.message : 'Save failed';
			}
		} finally {
			saving = false;
		}
	}

	async function save() {
		await performSave(baselineEtag);
	}

	/** Conflict resolution: overwrite the server version with our content.
	 *  A null currentEtag means the file vanished server-side — the save then
	 *  runs create-only (If-Match: "") which is exactly the right guard. */
	async function overwriteServer() {
		await performSave(conflict ? conflict.currentEtag : null);
	}

	/** Conflict resolution: discard local edits, load the server version. */
	async function reloadServer() {
		if (!token || channelId === undefined) return;
		saving = true;
		try {
			const { content, etag } = await downloadLoreFileText(token, channelId, filePath);
			baselineEtag = etag;
			if (view) {
				view.dispatch({
					changes: { from: 0, to: view.state.doc.length, insert: content }
				});
			}
			fileContent = content;
			conflict = null;
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Reload failed';
		} finally {
			saving = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === 's') {
			e.preventDefault();
			if (editing && !saving) void save();
		}
	}

	// CodeMirror lifecycle: (re)build the view when the file or mode changes.
	$effect(() => {
		if (!host) return;
		if (isBinary(fileContent) || !fileContent) return;

		const lang = languageFor(filePath);
		const extensions: Extension[] = [
			lineNumbers(),
			history(),
			keymap.of([
				{
					key: 'Mod-s',
					preventDefault: true,
					run: () => {
						if (editing && !saving) void save();
						return true;
					}
				},
				...defaultKeymap,
				...historyKeymap
			]),
			oneDark,
			EditorView.lineWrapping
		];
		if (lang) extensions.push(lang);
		if (!editing) {
			extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
		}

		const v = new EditorView({
			state: EditorState.create({ doc: fileContent, extensions }),
			parent: host
		});
		view = v;
		return () => {
			v.destroy();
			view = null;
		};
	});
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="lore-file-viewer">
	<div class="viewer-toolbar">
		<div class="file-meta">
			<span class="file-path">{filePath}</span>
			{#if fileInfo}
				<span class="file-size">{formatSize(fileInfo.size)}</span>
			{/if}
			{#if baselineEtag && editing}
				<span class="file-hash" title={baselineEtag}>etag {baselineEtag.slice(0, 8)}…</span>
			{/if}
			{#if savedFlash}
				<span class="saved-flash">saved ✓</span>
			{/if}
		</div>
		<div class="viewer-actions">
			{#if editable && !editing}
				<button
					class="action-btn edit-btn"
					disabled={enteringEdit}
					onclick={enterEditMode}
					title="Edit this file (Ctrl/Cmd+S to save)"
				>
					{enteringEdit ? '…' : '✎'}
				</button>
			{/if}
			{#if editing}
				<button class="action-btn" disabled={saving} onclick={save} title="Save (Ctrl/Cmd+S)">
					{saving ? '…' : '💾'}
				</button>
				<button class="action-btn" onclick={exitEditMode} title="Stop editing">👁</button>
			{/if}
			{#if isMarkdown && !editing}
				<button
					class="action-btn"
					class:active-btn={mdMode === 'rendered'}
					onclick={() => (mdMode = 'rendered')}
					title="Rendered document view"
				>📄</button
				>
				<button
					class="action-btn"
					class:active-btn={mdMode === 'source'}
					onclick={() => (mdMode = 'source')}
					title="Markdown source view"
				>⌨</button
				>
			{/if}
			{#if token && channelId !== undefined}
				<button class="action-btn" onclick={() => void downloadFile()} title="Download this file">&#x2B07;</button>
			{/if}
			{#if !isBinary(fileContent) && fileContent}
				<button class="action-btn" onclick={copyContent} aria-label="Copy file content">
					{copied ? '✓' : '📋'}
				</button>
			{/if}
			<button class="action-btn close-btn" onclick={onClose} aria-label="Close file">✕</button>
		</div>
	</div>

	{#if conflict}
		<div class="conflict-bar" role="alert">
			<div class="conflict-text">
				⚠ <strong>{filePath} changed on the server</strong> while you were editing.
				Your edits were NOT lost — choose what happens next.
			</div>
			<div class="conflict-actions">
				<button class="conflict-btn primary" disabled={saving} onclick={overwriteServer}>
					Overwrite server
				</button>
				<button class="conflict-btn" disabled={saving} onclick={reloadServer}>
					Load server version
				</button>
				<button class="conflict-btn ghost" onclick={() => (conflict = null)}>Keep editing</button>
			</div>
		</div>
	{/if}

	{#if saveError}
		<div class="save-error" role="alert">{saveError}</div>
	{/if}

	{#if loading}
		<div class="viewer-loading">Loading...</div>
	{:else if mediaUrl}
		<div class="viewer-image"><img src={mediaUrl} alt={filePath} loading="lazy" /></div>
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
	{:else if editing}
		<div class="editor-host" bind:this={host}></div>
	{:else if mdRenderable && mdMode === 'rendered'}
		<div class="lore-md">{@html parseMessage(fileContent)}</div>
	{:else if fileContent}
		<div class="editor-host readonly" bind:this={host}></div>
		<noscript>
			<pre class="code-content"><code>{fileContent}</code></pre>
		</noscript>
	{:else}
		<div class="viewer-empty">No content</div>
	{/if}
</div>

<style>
	/* Rendered markdown: document styling consistent with wiki pages. */
	.lore-md {
		padding: 20px 24px;
		overflow: auto;
		line-height: 1.6;
		font-size: 0.95em;
	}
	.lore-md :global(img) {
		max-width: 100%;
		border-radius: 8px;
	}
	.lore-md :global(pre) {
		background: rgba(0, 0, 0, 0.25);
		padding: 10px 12px;
		border-radius: 8px;
		overflow: auto;
	}
	.lore-md :global(th),
	.lore-md :global(td) {
		border: 1px solid var(--wabi-border, #2a2a35);
		padding: 4px 10px;
	}
	.lore-md :global(h1),
	.lore-md :global(h2) {
		border-bottom: 1px solid var(--wabi-border, #2a2a35);
		padding-bottom: 4px;
	}
	.active-btn {
		border-color: var(--wabi-accent, #7c6cf0);
	}
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
		min-width: 0;
	}

	.file-path {
		color: var(--text-heading);
		font-family: var(--font-mono);
		max-width: 300px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-size,
	.file-hash {
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
	}

	.saved-flash {
		color: var(--accent, #4caf50);
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

	.action-btn:hover:not(:disabled) {
		background: var(--surface-sunken);
		color: var(--text-heading);
	}

	.edit-btn {
		border-color: color-mix(in srgb, var(--text-muted) 30%, transparent);
	}

	.editor-host {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.editor-host :global(.cm-editor) {
		height: 100%;
	}

	.editor-host :global(.cm-scroller) {
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
	}

	.conflict-bar {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-2);
		background: color-mix(in srgb, #ff9800 12%, var(--surface-raised));
		border-bottom: 1px solid color-mix(in srgb, #ff9800 40%, transparent);
	}

	.conflict-text {
		font-size: var(--font-size-sm);
		color: var(--text-heading);
	}

	.conflict-actions {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.conflict-btn {
		padding: 4px 10px;
		border-radius: var(--radius-sm);
		border: 1px solid color-mix(in srgb, var(--text-muted) 30%, transparent);
		background: var(--surface-raised);
		color: var(--text-heading);
		cursor: pointer;
		font-size: var(--font-size-sm);
	}

	.conflict-btn.primary {
		background: var(--accent, #4caf50);
		border-color: transparent;
		color: #fff;
	}

	.conflict-btn.ghost {
		background: transparent;
	}

	.save-error {
		padding: var(--space-1) var(--space-2);
		font-size: var(--font-size-sm);
		color: #ef5350;
		background: color-mix(in srgb, #ef5350 10%, transparent);
		border-bottom: 1px solid color-mix(in srgb, #ef5350 30%, transparent);
	}

	.viewer-loading,
	.viewer-binary,
	.viewer-empty {
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

	.viewer-image {
		flex: 1;
		min-height: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: auto;
		padding: var(--space-2);
	}

	.viewer-image img {
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
		border-radius: var(--radius-sm);
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
