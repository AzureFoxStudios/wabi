<script lang="ts">
	import { onDestroy, untrack, type Snippet } from 'svelte';
	import type { LoreFileInfo } from '$lib/api/lore';
	import { LoreConflictError, downloadLoreFileText, getSignedLoreUrl, saveLoreFileContent } from '$lib/api/lore';
	import { renderLoreDocument } from '$lib/lore/documentMarkdown';
	import { formatBytes, SelectionEpoch } from '$lib/lore/workspacePresentation';
	import { isMarkdownPath } from '$lib/lore/readmeDefault';
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
	import LoreIcon from './LoreIcon.svelte';

	interface Props {
		filePath: string; fileContent: string | null; fileInfo: LoreFileInfo | null; loading: boolean;
		onClose: () => void; mediaUrl?: string | null; canEdit?: boolean; token?: string; channelId?: number;
		onSaved?: () => void; onDirtyChange?: (dirty: boolean) => void; actions?: Snippet;
	}
	let { filePath, fileContent, fileInfo, loading, onClose, mediaUrl = null, canEdit = false, token, channelId, onSaved, onDirtyChange, actions }: Props = $props();
	let mode = $state<'read' | 'source' | 'edit'>('read');
	let host = $state<HTMLDivElement>();
	let editor: EditorView | undefined;
	let draft = $state('');
	let baseline = $state('');
	let baselineEtag = $state<string | null>(null);
	let savedContent = $state<string | null>(null);
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');
	let submittedContent = $state<string | null>(null);
	let conflict = $state<{ currentEtag: string | null } | null>(null);
	const requests = new SelectionEpoch();
	let source = $derived(savedContent ?? fileContent);
	let isMarkdown = $derived(isMarkdownPath(filePath));
	let readable = $derived(isMarkdown && source !== null && source.length <= 512 * 1024);
	let editable = $derived(canEdit && !!token && channelId !== undefined && source !== null && (fileInfo?.size ?? source.length) <= 1024 * 1024);
	let dirty = $derived(mode === 'edit' && draft !== baseline && draft !== submittedContent);
	$effect(() => { const value = dirty || busy; untrack(() => onDirtyChange?.(value)); });
	$effect(() => { void filePath; requests.begin(); mode = 'read'; savedContent = null; error = ''; notice = ''; busy = false; conflict = null; submittedContent = null; draft = ''; baseline = ''; baselineEtag = null; });
	onDestroy(() => { requests.dispose(); onDirtyChange?.(false); });

	function language(path: string): Extension | null {
		const extension = path.split('.').pop()?.toLowerCase();
		switch (extension) {
			case 'js': case 'mjs': case 'cjs': return javascript();
			case 'jsx': return javascript({ jsx: true });
			case 'ts': return javascript({ typescript: true });
			case 'tsx': return javascript({ typescript: true, jsx: true });
			case 'json': return json(); case 'md': case 'markdown': return markdown();
			case 'py': return python(); case 'rs': return rust();
			case 'c': case 'cpp': case 'cc': case 'h': case 'hpp': return cpp();
			case 'css': return css(); case 'html': case 'htm': case 'svelte': case 'vue': case 'xml': return html();
			case 'java': return java(); case 'go': return go(); default: return null;
		}
	}
	$effect(() => {
		const node = host;
		const content = source;
		const path = filePath;
		const editing = mode === 'edit';
		if (!node || content === null || (mode === 'read' && readable)) return;
		const extensions: Extension[] = [lineNumbers(), oneDark, EditorView.lineWrapping,
			EditorState.readOnly.of(!editing), EditorView.editable.of(editing),
			EditorView.theme({ '&': { height: '100%', fontSize: '14px' }, '.cm-scroller': { overflow: 'auto' } })];
		const grammar = language(path); if (grammar) extensions.push(grammar);
		if (editing) extensions.push(history(), keymap.of([
			{ key: 'Mod-s', run: () => { void saveRevision(); return true; }, preventDefault: true }, ...defaultKeymap, ...historyKeymap
		]), EditorView.updateListener.of(update => { if (update.docChanged) draft = update.state.doc.toString(); }));
		const view = new EditorView({ parent: node, state: EditorState.create({ doc: untrack(() => editing ? draft : content), extensions }) });
		editor = view;
		return () => { view.destroy(); if (editor === view) editor = undefined; };
	});

	async function enterEdit() {
		if (!editable || !token || channelId === undefined || busy) return;
		const request = requests.begin(); busy = true; error = ''; notice = '';
		try {
			const result = await downloadLoreFileText(token, channelId, filePath);
			if (!requests.current(request)) return;
			if (result.content.length > 1024 * 1024) throw new Error('This file is too large for the inline editor. Use your local folder.');
			submittedContent = null; baseline = result.content; draft = result.content; baselineEtag = result.etag; conflict = null; mode = 'edit';
		} catch (e) { if (requests.current(request)) error = e instanceof Error ? e.message : 'Could not open editor.'; }
		finally { if (requests.current(request)) busy = false; }
	}
	async function saveRevision(replaceConflict = false) {
		if (!token || channelId === undefined || busy || mode !== 'edit' || !editor || (!dirty && !conflict)) return;
		if (replaceConflict && !window.confirm('Replace the current server version with your edited content? A revision will be published.')) return;
		const content = editor.state.doc.toString();
		const expected = replaceConflict ? conflict?.currentEtag ?? null : baselineEtag;
		const request = requests.begin(); busy = true; error = ''; notice = '';
		try {
			const result = await saveLoreFileContent(token, channelId, filePath, content, expected, `Edit ${filePath} in Wabi`);
			if (!requests.current(request)) return;
			if (result.pending_review) {
				notice = 'Submitted for review. The official file has not been replaced.';
				submittedContent = content; // Avoid resubmitting the same bytes; keep the official baseline unchanged.
			} else {
				baseline = content; baselineEtag = result.etag ?? baselineEtag; savedContent = content;
				notice = result.wdbRecorded === false ? 'File accepted; activity recording failed on the server.' : 'Revision saved.';
			}
			conflict = null; onSaved?.();
		} catch (e) {
			if (!requests.current(request)) return;
			if (e instanceof LoreConflictError) conflict = { currentEtag: e.currentEtag };
			else error = e instanceof Error ? e.message : 'Save failed. Your edits are still here.';
		} finally { if (requests.current(request)) busy = false; }
	}
	function finishEditing() {
		if (busy || (dirty && !window.confirm('Discard your unsaved editor changes?'))) return;
		mode = 'read'; conflict = null; error = '';
	}
	function close() { if (!busy && (!dirty || window.confirm('Discard your unsaved editor changes and close this file?'))) onClose(); }
	async function download() {
		if (!token || channelId === undefined) return;
		const request = filePath;
		try {
			const url = await getSignedLoreUrl(token, channelId, request);
			if (request !== filePath) return;
			const anchor = document.createElement('a'); anchor.href = url; anchor.download = filePath.split('/').pop() ?? 'file'; anchor.rel = 'noopener'; anchor.click();
		} catch (e) { error = e instanceof Error ? e.message : 'Download failed.'; }
	}
</script>

<svelte:window onbeforeunload={(event) => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } }} />
<section class="lore-file-viewer" aria-label={`File ${filePath}`}>
	<header class="viewer-header">
		<div class="viewer-filename"><LoreIcon name="file" /><span title={filePath}>{filePath}</span>{#if fileInfo}<small>{formatBytes(fileInfo.size)}</small>{/if}</div>
		<div class="viewer-actions">
			{#if actions}{@render actions()}{/if}
			{#if mode === 'edit'}
				<span class="viewer-save-state">{dirty ? 'Unsaved edits' : submittedContent === draft ? 'Submitted for review' : 'No unsaved edits'}</span>
				<button disabled={busy} onclick={finishEditing}>{dirty ? 'Discard edits' : 'Done'}</button>
				<button class="viewer-primary" disabled={busy || !dirty || !!conflict} onclick={() => void saveRevision()}>{busy ? 'Saving…' : 'Save revision'}</button>
			{:else}
				{#if source !== null}<button onclick={() => void navigator.clipboard.writeText(source!).then(() => notice = 'Content copied.').catch(() => error = 'Could not copy content.')}>Copy</button>{/if}
				{#if readable}<button aria-pressed={mode === 'source'} onclick={() => mode = mode === 'source' ? 'read' : 'source'}>{mode === 'source' ? 'Read document' : 'View source'}</button>{/if}
				{#if editable}<button disabled={busy} onclick={() => void enterEdit()}>{busy ? 'Opening…' : 'Edit'}</button>{/if}
			{/if}
			<button class="viewer-icon" onclick={() => void download()} aria-label="Download this file" title="Download this file"><LoreIcon name="download" /></button>
			<button class="viewer-icon" onclick={close} disabled={busy} aria-label="Close file" title="Close file"><LoreIcon name="close" /></button>
		</div>
	</header>
	{#if error}<p class="viewer-notice error" role="alert">{error}</p>{/if}
	{#if notice}<p class="viewer-notice" role="status">{notice}</p>{/if}
	{#if conflict}
		<div class="viewer-notice" role="alert"><strong>The server file changed.</strong> Your edits have not been published.
			<button disabled={busy} onclick={() => void saveRevision(true)}>Replace server version…</button>
			<button disabled={busy} onclick={() => { conflict = null; }}>Keep editing</button>
		</div>
	{/if}
	<div class="viewer-body">
		{#if loading}<p class="viewer-empty" role="status">Loading file…</p>
		{:else if mediaUrl}<div class="viewer-image"><img src={mediaUrl} alt={filePath} /></div>
		{:else if source === null}<div class="viewer-empty"><h3>Preview not available</h3><p>Download this file or open it from your connected folder.</p><button onclick={() => void download()}>Download file</button></div>
		{:else if mode === 'read' && readable}<article class="lore-document">{@html renderLoreDocument(source)}</article>
		{:else}<div class="viewer-editor" bind:this={host}></div>{/if}
	</div>
</section>

<style>
	.lore-file-viewer { display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; color:var(--text-primary, #e8eded); background:var(--bg-primary, #111b20); }
	.viewer-header { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; padding:12px 18px; border-bottom:1px solid var(--border-color, #334047); }
	.viewer-filename { display:flex; align-items:center; gap:10px; min-width:0; flex:1; font-size:14px; }
	.viewer-filename span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	small,.viewer-save-state { color:var(--text-secondary, #b7c3c9); font-size:12px; }
	.viewer-actions { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
	button { font:inherit; font-size:13px; min-height:34px; padding:6px 11px; border:1px solid var(--border-color, #334047); border-radius:7px; background:var(--bg-secondary, #1b292f); color:inherit; cursor:pointer; }
	button:disabled { opacity:.5; cursor:not-allowed; }
	button:focus-visible { outline:2px solid var(--accent-color, #7cbeb2); outline-offset:3px; }
	.viewer-icon { display:inline-flex; align-items:center; justify-content:center; padding:7px; }
	.viewer-primary { border-color:var(--accent-color, #7cbeb2); font-weight:650; }
	.viewer-body { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; }
	.viewer-editor { height:100%; min-height:240px; }
	.viewer-notice { padding:12px 18px; margin:0; background:var(--bg-secondary, #1b292f); font-size:14px; border-bottom:1px solid var(--border-color, #334047); }
	.viewer-notice.error { border-left:3px solid var(--danger-color, #e68b87); }
	.viewer-empty { padding:36px; line-height:1.6; }.viewer-empty h3 { font-size:18px; }
	.viewer-image { display:grid; place-items:center; padding:24px; min-height:260px; }.viewer-image img { max-width:100%; max-height:70vh; object-fit:contain; }
	.lore-document { box-sizing:border-box; max-width:80ch; margin:0 auto; padding:clamp(24px, 4vw, 56px); font-size:16px; line-height:1.75; overflow-wrap:anywhere; }
	.lore-document :global(h1) { font-size:2rem; line-height:1.2; letter-spacing:-.025em; margin:0 0 1.1em; }
	.lore-document :global(h2) { font-size:1.4rem; line-height:1.35; margin:1.7em 0 .6em; border-bottom:1px solid var(--border-color, #334047); padding-bottom:.4em; }
	.lore-document :global(h3) { font-size:1.15rem; margin:1.4em 0 .5em; }
	.lore-document :global(p),.lore-document :global(ul),.lore-document :global(ol) { margin:0 0 1em; }
	.lore-document :global(li) { margin:.25em 0; }.lore-document :global(ul),.lore-document :global(ol) { padding-left:1.5em; }
	.lore-document :global(a) { color:var(--accent-color, #92d5c6); text-decoration:underline; text-underline-offset:3px; }
	.lore-document :global(pre) { overflow:auto; padding:18px; background:var(--bg-secondary, #1b292f); border:1px solid var(--border-color, #334047); border-radius:8px; line-height:1.55; font-size:14px; white-space:pre; }
	.lore-document :global(code) { font-size:.88em; }.lore-document :global(blockquote) { margin:1.2em 0; border-left:3px solid var(--accent-color, #7cbeb2); padding:.25em 1.2em; }
	.lore-document :global(table) { display:block; width:max-content; max-width:100%; overflow-x:auto; border-collapse:collapse; margin:1.3em 0; font-size:14px; }
	.lore-document :global(th),.lore-document :global(td) { padding:10px 14px; border:1px solid var(--border-color, #334047); text-align:left; vertical-align:top; }
	.lore-document :global(th) { background:var(--bg-secondary, #1b292f); font-weight:650; }
	@media(max-width:600px) { .viewer-header { padding:10px; }.viewer-filename { flex-basis:100%; }.lore-document { padding:22px 18px; }.viewer-save-state { display:none; } }
</style>
