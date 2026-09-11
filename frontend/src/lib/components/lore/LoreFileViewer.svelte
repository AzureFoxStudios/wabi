<script lang="ts">
  import { onDestroy, untrack, type Snippet } from 'svelte';
  import type { LoreFileInfo } from '$lib/api/lore';
  import { LoreConflictError, downloadLoreFileText, getSignedLoreUrl, getLoreRepo, saveLoreFileContent } from '$lib/api/lore';
  import { getApiBase } from '$lib/api/utils';
  import { authSessionGeneration, getStoredDbUserId, onAuthSessionCleared } from '$lib/authSession';
  import { renderLoreDocument } from '$lib/lore/documentMarkdown';
  import { formatBytes, isMirror, SelectionEpoch } from '$lib/lore/workspacePresentation';
  import { editorStatus, type LoreEditorState } from '$lib/lore/editorPresentation';
  import { isMarkdownPath } from '$lib/lore/readmeDefault';
  import { EditorState, type Extension } from '@codemirror/state';
  import { EditorView, keymap, lineNumbers } from '@codemirror/view';
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
  import { tags } from '@lezer/highlight';
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
    onSaved?: () => void; onDirtyChange?: (dirty: boolean) => void; onStateChange?: (state: LoreEditorState) => void; actions?: Snippet;
  }
  let { filePath, fileContent, fileInfo, loading, onClose, mediaUrl = null, canEdit = false, token, channelId, onSaved, onDirtyChange, onStateChange, actions }: Props = $props();
  let mode = $state<'read' | 'source' | 'edit'>('read');
  let host = $state<HTMLDivElement>();
  let editor: EditorView | undefined;
  let draft = $state(''), baseline = $state('');
  let baselineEtag = $state<string | null>(null), savedContent = $state<string | null>(null);
  let busy = $state(false), error = $state(''), notice = $state('');
  let submittedContent = $state<string | null>(null), reviewRequired = $state(false);
  let conflict = $state<{ currentEtag: string | null } | null>(null);
  let comparing = $state(false), latestContent = $state<string | null>(null), loadingComparison = $state(false);
  let sessionInvalid = $state(false);
  const requests = new SelectionEpoch(), comparisons = new SelectionEpoch();
  const server = getApiBase(), session = authSessionGeneration(server), account = String(getStoredDbUserId(server) ?? '');
  let alive = true;
  let source = $derived(sessionInvalid ? null : savedContent ?? fileContent);
  let isMarkdown = $derived(isMarkdownPath(filePath));
  let readable = $derived(isMarkdown && source !== null && source.length <= 512 * 1024);
  let editable = $derived(!sessionInvalid && canEdit && !!token && channelId !== undefined && source !== null && (fileInfo?.size ?? source.length) <= 1024 * 1024);
  let dirty = $derived(mode === 'edit' && draft !== baseline && draft !== submittedContent);
  let state = $derived<LoreEditorState>({ editing: mode === 'edit', dirty, busy, submitted: submittedContent !== null && submittedContent === draft });
  $effect(() => { const value = state; untrack(() => { onDirtyChange?.(value.dirty || value.busy); onStateChange?.(value); }); });
  $effect(() => { void filePath; void channelId; requests.begin(); comparisons.begin(); mode = 'read'; savedContent = null; error = ''; notice = ''; busy = false; conflict = null; submittedContent = null; draft = ''; baseline = ''; baselineEtag = null; comparing = false; latestContent = null; loadingComparison = false; });
  const stopSessionListener = onAuthSessionCleared(() => {
    if (authSessionGeneration(server) !== session) {
      requests.begin(); comparisons.begin(); sessionInvalid = true; draft = ''; baseline = ''; savedContent = null; submittedContent = null; latestContent = null; mode = 'read'; busy = false;
    }
  });
  onDestroy(() => { alive = false; stopSessionListener(); requests.dispose(); comparisons.dispose(); onDirtyChange?.(false); });

  function active(): boolean { return alive && !sessionInvalid && getApiBase() === server && authSessionGeneration(server) === session && String(getStoredDbUserId(server) ?? '') === account; }
  function requireSession(): boolean { if (active()) return true; sessionInvalid = true; error = 'Your account or server changed. Reopen this file before continuing.'; return false; }
  function language(path: string): Extension | null {
    switch (path.split('.').pop()?.toLowerCase()) {
      case 'js': case 'mjs': case 'cjs': return javascript(); case 'jsx': return javascript({ jsx: true });
      case 'ts': return javascript({ typescript: true }); case 'tsx': return javascript({ typescript: true, jsx: true });
      case 'json': return json(); case 'md': case 'markdown': return markdown(); case 'py': return python(); case 'rs': return rust();
      case 'c': case 'cpp': case 'cc': case 'h': case 'hpp': return cpp(); case 'css': return css();
      case 'html': case 'htm': case 'svelte': case 'vue': case 'xml': return html(); case 'java': return java(); case 'go': return go(); default: return null;
    }
  }
  const highlighting = syntaxHighlighting(HighlightStyle.define([
    { tag: tags.keyword, color: 'var(--lore-syntax-keyword, color-mix(in srgb, var(--text-heading, #e8eded) 65%, var(--accent-primary-color, #7cbeb2)))', fontWeight: '600' },
    { tag: [tags.string, tags.regexp], color: 'var(--lore-syntax-string, color-mix(in srgb, var(--text-heading, #e8eded) 65%, var(--color-success, #22c55e)))' },
    { tag: [tags.number, tags.bool, tags.null], color: 'var(--lore-syntax-number, color-mix(in srgb, var(--text-heading, #e8eded) 65%, var(--color-warning, #f59e0b)))' },
    { tag: tags.comment, color: 'var(--text-secondary, #b7c3c9)', fontStyle: 'italic' },
    { tag: [tags.typeName, tags.className], color: 'var(--lore-syntax-type, color-mix(in srgb, var(--text-heading, #e8eded) 70%, var(--accent-primary-color, #7cbeb2)))' }
  ]));
  $effect(() => {
    const node = host, path = filePath, editing = mode === 'edit';
    // Publishing updates the baseline, not the editor instance/cursor/undo stack.
    const readContent = editing ? null : source;
    if (!node || sessionInvalid || (!editing && readContent === null) || (mode === 'read' && readable)) return;
    const extensions: Extension[] = [lineNumbers(), highlighting, EditorView.lineWrapping,
      EditorState.readOnly.of(!editing), EditorView.editable.of(editing),
      EditorView.theme({
        '&': { height: '100%', fontSize: '14px', color: 'var(--text-heading, #e8eded)', backgroundColor: 'var(--surface-base, #111b20)' },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
        '.cm-content': { caretColor: 'var(--text-heading, #e8eded)', padding: '12px 0' },
        '.cm-gutters': { color: 'var(--text-secondary, #b7c3c9)', backgroundColor: 'var(--surface-raised, #1b292f)', borderRight: '1px solid var(--color-border-primary, #334047)' },
        '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--accent-primary-color, #7cbeb2) 10%, transparent)' },
        '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--accent-primary-color, #7cbeb2) 25%, transparent)' }
      })];
    const grammar = language(path); if (grammar) extensions.push(grammar);
    if (editing) extensions.push(history(), keymap.of([{ key: 'Mod-s', run: () => { void saveRevision(); return true; }, preventDefault: true }, ...defaultKeymap, ...historyKeymap]), EditorView.updateListener.of(update => { if (update.docChanged) draft = update.state.doc.toString(); }));
    const view = new EditorView({ parent: node, state: EditorState.create({ doc: untrack(() => editing ? draft : readContent || ''), extensions }) });
    editor = view; if (editing) queueMicrotask(() => { if (editor === view && active()) view.focus(); }); return () => { view.destroy(); if (editor === view) editor = undefined; };
  });
  async function enterEdit() {
    if (!editable || !token || channelId === undefined || busy || !requireSession()) return;
    const request = requests.begin(); busy = true; error = ''; notice = '';
    try {
      const repo = await getLoreRepo(token, channelId);
      if (!active() || !requests.current(request)) return;
      if (!repo || isMirror(repo)) throw new Error('This project is unavailable or read-only.');
      const result = await downloadLoreFileText(token, channelId, filePath);
      if (!active() || !requests.current(request)) return;
      if (result.content.length > 1024 * 1024) throw new Error('This file is too large for the inline editor. Use your local folder.');
      reviewRequired = !!repo.auto_branch_on_upload; submittedContent = null; baseline = result.content; draft = result.content; baselineEtag = result.etag; conflict = null; mode = 'edit';
    } catch (e) { if (active() && requests.current(request)) error = e instanceof Error ? e.message : 'Could not open editor.'; }
    finally { if (requests.current(request)) busy = false; }
  }
  async function saveRevision(replaceConflict = false) {
    if (!token || channelId === undefined || busy || mode !== 'edit' || !editor || (!dirty && !conflict) || !requireSession()) return;
    if (replaceConflict && !window.confirm(reviewRequired ? 'Submit your draft for review using the current server version as its baseline?' : 'Replace the current published file with your draft? This publishes a new revision for everyone with access.')) return;
    const content = editor.state.doc.toString(), expected = replaceConflict ? conflict?.currentEtag ?? null : baselineEtag;
    const request = requests.begin(); busy = true; error = ''; notice = '';
    try {
      const result = await saveLoreFileContent(token, channelId, filePath, content, expected, `Edit ${filePath} in Wabi`);
      if (!active() || !requests.current(request)) return;
      if (result.pending_review) { notice = 'Submitted for review. The published file has not been replaced.'; submittedContent = content; }
      else { baseline = content; baselineEtag = result.etag ?? baselineEtag; savedContent = content; notice = result.wdbRecorded === false ? 'File accepted; activity recording failed on the server.' : 'Revision published.'; }
      conflict = null; comparing = false; latestContent = null; onSaved?.();
    } catch (e) {
      if (!active() || !requests.current(request)) return;
      if (e instanceof LoreConflictError) conflict = { currentEtag: e.currentEtag };
      else error = e instanceof Error ? e.message : 'Save failed. Your edits are still here.';
    } finally { if (requests.current(request)) busy = false; }
  }
  async function compareLatest() {
    if (!token || channelId === undefined || !requireSession()) return;
    const request = comparisons.begin(); loadingComparison = true; comparing = true; latestContent = null; error = '';
    try { const result = await downloadLoreFileText(token, channelId, filePath); if (result.content.length > 1024 * 1024) throw new Error('The published version is too large for an inline comparison. Download it separately.'); if (active() && comparisons.current(request)) { latestContent = result.content; if (conflict) conflict = { currentEtag: result.etag }; } }
    catch (e) { if (active() && comparisons.current(request)) error = e instanceof Error ? e.message : 'Could not load the published version. Your draft has been kept.'; }
    finally { if (comparisons.current(request)) loadingComparison = false; }
  }
  function downloadDraft() {
    if (!requireSession()) return;
    const url = URL.createObjectURL(new Blob([draft], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = filePath.split('/').pop() || 'draft.txt'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function finishEditing() { if (busy || (dirty && !window.confirm('Discard your unpublished editor changes?'))) return; mode = 'read'; conflict = null; comparing = false; error = ''; }
  function close() { if (!busy && (!dirty || window.confirm('Discard your unpublished editor changes and close this file?'))) onClose(); }
  async function download() {
    if (!token || channelId === undefined || !requireSession()) return;
    const path = filePath;
    try { const url = await getSignedLoreUrl(token, channelId, path); if (!active() || path !== filePath) return; const anchor = document.createElement('a'); anchor.href = url; anchor.download = path.split('/').pop() || 'file'; anchor.rel = 'noopener'; anchor.click(); }
    catch (e) { if (active()) error = e instanceof Error ? e.message : 'Download failed.'; }
  }
</script>

<svelte:window onbeforeunload={event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } }} />
<section class="lore-file-viewer" aria-label={`File ${filePath}`}>
  <header class="viewer-header"><div class="viewer-filename"><LoreIcon name="file" /><span title={filePath}>{filePath}</span>{#if fileInfo}<small>{formatBytes(fileInfo.size)}</small>{/if}</div><button type="button" class="viewer-icon" onclick={close} disabled={busy} aria-label="Close file" title="Close file"><LoreIcon name="close" /></button></header>
  <div class="viewer-toolbar" role="group" aria-label="File tools">
    <span class="viewer-save-state" role="status">{sessionInvalid ? 'Session changed · Reopen this file' : loading ? 'Loading published file…' : editorStatus(state)}</span>
    <div class="viewer-actions">
      {#if actions}{@render actions()}{/if}
      {#if mode === 'edit'}
        <button type="button" onclick={downloadDraft}>Download draft</button>
        <button type="button" disabled={busy} onclick={finishEditing}>{dirty ? 'Discard edits…' : 'Done'}</button>
        <button type="button" class="viewer-primary" disabled={busy || !dirty || !!conflict || sessionInvalid} onclick={() => void saveRevision()}>{busy ? 'Saving…' : reviewRequired ? 'Submit for review' : 'Publish revision'}</button>
      {:else}
        {#if source !== null}<button type="button" onclick={() => void navigator.clipboard.writeText(source!).then(() => notice = 'Content copied.').catch(() => error = 'Could not copy content.')}>Copy</button>{/if}
        {#if readable}<button type="button" aria-pressed={mode === 'source'} onclick={() => mode = mode === 'source' ? 'read' : 'source'}>{mode === 'source' ? 'Read document' : 'View source'}</button>{/if}
        {#if editable}<button type="button" class="viewer-primary" disabled={busy} onclick={() => void enterEdit()}>{busy ? 'Opening…' : 'Edit file'}</button>{/if}
        {#if token && channelId !== undefined}<button type="button" class="viewer-icon" disabled={sessionInvalid} onclick={() => void download()} aria-label="Download published file" title="Download published file"><LoreIcon name="download" /></button>{/if}
      {/if}
    </div>
  </div>
  {#if mode === 'edit'}<p class="viewer-draft-context">This draft is private to this editor, not a live shared session. {reviewRequired ? 'Submit for review to share a proposed revision.' : 'Publish a revision when it is ready for others.'}</p>{/if}
  {#if error}<p class="viewer-notice error" role="alert">{error}</p>{/if}
  {#if notice}<p class="viewer-notice" role="status">{notice}</p>{/if}
  {#if conflict}<div class="viewer-notice" role="alert"><strong>The published file changed. Your draft is safe and has not been published.</strong><div class="conflict-actions"><button type="button" disabled={loadingComparison} onclick={() => void compareLatest()}>{loadingComparison ? 'Loading comparison…' : 'Compare versions'}</button><button type="button" onclick={downloadDraft}>Download my draft</button><button type="button" disabled={busy} onclick={() => { comparing = false; }}>Keep editing</button><button type="button" class="viewer-danger" disabled={busy || loadingComparison} onclick={() => void saveRevision(true)}>{reviewRequired ? 'Submit against latest version…' : 'Replace published version…'}</button></div></div>{/if}
  {#if comparing}<section class="viewer-comparison" aria-label="Version comparison"><div><h3>Published version</h3><pre>{loadingComparison ? 'Loading…' : latestContent ?? 'Published content unavailable.'}</pre></div><div><h3>Your private draft</h3><pre>{draft}</pre></div></section>{/if}
  <div class="viewer-body">
    {#if sessionInvalid}<div class="viewer-empty"><h3>Reopen this file</h3><p>Your account or server changed. This editor cannot read or publish across that boundary.</p></div>
    {:else if loading}<p class="viewer-empty" role="status">Loading file…</p>
    {:else if mediaUrl}<div class="viewer-image"><img src={mediaUrl} alt={filePath} /></div>
    {:else if source === null}<div class="viewer-empty"><h3>Preview not available</h3><p>Download this file or open it from your connected folder.</p>{#if token && channelId !== undefined}<button type="button" onclick={() => void download()}>Download file</button>{/if}</div>
    {:else if mode === 'read' && readable}<article class="lore-document">{@html renderLoreDocument(source)}</article>
    {:else}<div class="viewer-editor" bind:this={host}></div>{/if}
  </div>
</section>

<style>
  .lore-file-viewer { display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; flex:1; color:var(--text-heading, #e8eded); background:var(--surface-base, #111b20); container-type:inline-size; }
  .viewer-header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 16px; border-bottom:1px solid var(--color-border-primary, #334047); flex-shrink:0; }.viewer-filename { display:flex; align-items:center; gap:10px; min-width:0; flex:1; font-size:14px; font-weight:600; }.viewer-filename span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.viewer-filename small { white-space:nowrap; font-weight:400; }
  small,.viewer-save-state { color:var(--text-secondary, #b7c3c9); font-size:12px; }.viewer-toolbar { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; padding:10px 16px; background:var(--surface-raised, #1b292f); border-bottom:1px solid var(--color-border-primary, #334047); flex-shrink:0; }.viewer-save-state { line-height:1.5; }.viewer-actions,.conflict-actions { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
  button { font:inherit; font-size:12px; min-height:36px; padding:7px 11px; border:1px solid var(--color-border-primary, #334047); border-radius:8px; background:var(--surface-base, #111b20); color:inherit; cursor:pointer; }button:disabled { opacity:.5; cursor:not-allowed; }button:focus-visible { outline:2px solid var(--accent-primary-color, #7cbeb2); outline-offset:2px; }.viewer-icon { display:inline-flex; align-items:center; justify-content:center; padding:7px; }.viewer-primary { border-color:var(--accent-primary-color, #7cbeb2); background:color-mix(in srgb, var(--accent-primary-color, #7cbeb2) 16%, var(--surface-base, #111b20)); font-weight:650; }.viewer-danger { border-color:var(--color-danger, #e68b87); }
  .viewer-body { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; }.viewer-editor { height:100%; min-height:240px; }.viewer-draft-context { margin:0; padding:8px 16px; font-size:12px; line-height:1.6; color:var(--text-secondary, #b7c3c9); border-bottom:1px solid var(--color-border-primary, #334047); flex-shrink:0; }
  .viewer-notice { padding:12px 16px; margin:0; background:var(--surface-raised, #1b292f); font-size:13px; line-height:1.6; border-bottom:1px solid var(--color-border-primary, #334047); flex-shrink:0; }.viewer-notice.error { border-left:3px solid var(--color-danger, #e68b87); }.conflict-actions { margin-top:10px; }
  .viewer-comparison { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); max-height:40%; overflow:auto; border-bottom:1px solid var(--color-border-primary, #334047); flex-shrink:0; }.viewer-comparison>div { min-width:0; padding:12px; }.viewer-comparison>div+div { border-left:1px solid var(--color-border-primary, #334047); }.viewer-comparison h3 { font-size:12px; margin:0 0 8px; }.viewer-comparison pre { font-size:12px; overflow:auto; margin:0; tab-size:2; }
  .viewer-empty { padding:28px; line-height:1.6; }.viewer-empty h3 { font-size:18px; }.viewer-image { display:grid; place-items:center; padding:24px; min-height:260px; }.viewer-image img { max-width:100%; max-height:70vh; object-fit:contain; }
  .lore-document { box-sizing:border-box; max-width:80ch; margin:0 auto; padding:clamp(24px, 4vw, 56px); font-size:16px; line-height:1.75; overflow-wrap:anywhere; }.lore-document :global(h1) { font-size:2rem; line-height:1.2; letter-spacing:-.025em; margin:0 0 1.1em; }.lore-document :global(h2) { font-size:1.4rem; line-height:1.35; margin:1.7em 0 .6em; border-bottom:1px solid var(--color-border-primary, #334047); padding-bottom:.4em; }.lore-document :global(h3) { font-size:1.15rem; margin:1.4em 0 .5em; }
  .lore-document :global(p),.lore-document :global(ul),.lore-document :global(ol) { margin:0 0 1em; }.lore-document :global(li) { margin:.25em 0; }.lore-document :global(ul),.lore-document :global(ol) { padding-left:1.5em; }.lore-document :global(a) { color:var(--accent-primary-color, #92d5c6); text-decoration:underline; text-underline-offset:3px; }.lore-document :global(pre) { overflow:auto; padding:18px; background:var(--surface-raised, #1b292f); border:1px solid var(--color-border-primary, #334047); border-radius:8px; line-height:1.55; font-size:14px; white-space:pre; }.lore-document :global(code) { font-size:.88em; }.lore-document :global(blockquote) { margin:1.2em 0; border-left:3px solid var(--accent-primary-color, #7cbeb2); padding:.25em 1.2em; }
  .lore-document :global(table) { display:block; width:max-content; max-width:100%; overflow-x:auto; border-collapse:collapse; margin:1.3em 0; font-size:14px; }.lore-document :global(th),.lore-document :global(td) { padding:10px 14px; border:1px solid var(--color-border-primary, #334047); text-align:left; vertical-align:top; }.lore-document :global(th) { background:var(--surface-raised, #1b292f); font-weight:650; }
  @container (max-width:560px) { .viewer-header,.viewer-toolbar { padding:10px; }.viewer-save-state { flex-basis:100%; }.viewer-actions { width:100%; }.viewer-actions button { flex-grow:1; }.viewer-comparison { grid-template-columns:minmax(0,1fr); }.viewer-comparison>div+div { border-left:0; border-top:1px solid var(--color-border-primary, #334047); }.lore-document { padding:22px 18px; } }
  @media (pointer:coarse) { button { min-height:44px; } }
</style>
