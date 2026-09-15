<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { get } from 'svelte/store';
  import { currentChannel, currentUser, socket } from '$lib/socket';
  import { getApiBase } from '$lib/api/utils';
  import { getAuthToken, authSessionGeneration, onAuthSessionCleared } from '$lib/authSession';
  import { getDmStableUserId } from '$lib/dmConversations';
  import { getLoreRepo, listLoreFiles, downloadLoreFileText, getSignedLoreUrl, parseLoreChannelId, type LoreFileInfo, type LoreRepo } from '$lib/api/lore';
  import { isMirror, previewKind } from '$lib/lore/workspacePresentation';
  import { editorStatus, type LoreEditorState } from '$lib/lore/editorPresentation';
  import { LatestIntent } from '$lib/latestIntent';
  import LoreFileTree from './LoreFileTree.svelte';
  import LoreFileViewer from './LoreFileViewer.svelte';

  type Scope = { base: string; account: string; session: number; channelKey: string; channelId: number };
  let scope = $state<Scope | null>(null);
  let repo = $state<LoreRepo | null>(null);
  let files = $state<LoreFileInfo[]>([]);
  let selectedPath = $state<string | null>(null);
  let fileContent = $state<string | null>(null);
  let fileInfo = $state<LoreFileInfo | null>(null);
  let loading = $state(false), loadingFile = $state(false), treeVisible = $state(true);
  let error = $state(''), fileError = $state('');
  let editorState = $state<LoreEditorState>({ editing: false, dirty: false, busy: false, submitted: false });
  let fileDirty = $state(false), pendingPath = $state<string | null>(null);
  let pendingChannel = $state<string | null>(null);
  const loads = new LatestIntent(), previews = new LatestIntent();
  let alive = true;
  let canWrite = $derived(!isMirror(repo) && ['owner', 'admin', 'developer', 'artist'].includes(($currentUser?.highestRole || '').toLowerCase()));

  // Observe navigation separately from the scoped editor. A dirty panel stays on its
  // original project, while an account/server change clears protected content.
  $effect(() => {
    const key = $currentChannel;
    const account = getDmStableUserId($currentUser);
    void $socket;
    const base = getApiBase(), session = authSessionGeneration(base);
    untrack(() => observeContext(key, account, base, session));
  });
  const stopSessionListener = onAuthSessionCleared(() => {
    if (scope && authSessionGeneration(scope.base) !== scope.session) { loads.cancel(); clearFile(); scope = null; repo = null; files = []; error = 'Your session ended. Sign in again to reopen this project.'; }
  });
  onDestroy(() => { alive = false; stopSessionListener(); loads.dispose(); previews.dispose(); });

  function active(candidate: Scope): boolean {
    return alive && scope === candidate && getApiBase() === candidate.base && authSessionGeneration(candidate.base) === candidate.session && getDmStableUserId(get(currentUser)) === candidate.account;
  }
  function clearFile() {
    previews.cancel(); selectedPath = null; fileContent = null; fileInfo = null; fileError = ''; loadingFile = false; fileDirty = false; pendingPath = null;
    editorState = { editing: false, dirty: false, busy: false, submitted: false };
  }
  function setContext(key: string, account: string, base: string, session: number) {
    loads.cancel(); clearFile(); repo = null; files = []; error = ''; pendingChannel = null; loading = false;
    const channelId = parseLoreChannelId(key);
    scope = channelId === null || !account ? null : { base, account, session, channelKey: key, channelId };
    if (scope) void refresh();
  }
  function observeContext(key: string | null | undefined, account: string, base: string, session: number) {
    if (!scope || scope.base !== base || scope.account !== account || scope.session !== session) { setContext(key || '', account, base, session); return; }
    if (scope.channelKey === key) { pendingChannel = null; return; }
    if (fileDirty || editorState.editing) { pendingChannel = key || ''; return; }
    setContext(key || '', account, base, session);
  }
  function openCurrentProject() {
    if (editorState.busy) return;
    if (fileDirty && !window.confirm('Discard the unpublished changes in this editor and open the current project?')) return;
    const base = getApiBase(); setContext(get(currentChannel) || '', getDmStableUserId(get(currentUser)), base, authSessionGeneration(base));
  }
  async function refresh() {
    const captured = scope; if (!captured || !active(captured)) return;
    const request = loads.begin(); loading = true; error = '';
    try {
      const token = getAuthToken(captured.base); if (!token) throw new Error('Sign in to load project files.');
      const nextRepo = await getLoreRepo(token, captured.channelId);
      if (!active(captured) || !loads.current(request)) return;
      const nextFiles = nextRepo ? await listLoreFiles(token, captured.channelId) : [];
      if (!active(captured) || !loads.current(request)) return;
      repo = nextRepo; files = nextFiles;
    } catch (e) { if (active(captured) && loads.current(request)) error = e instanceof Error ? e.message : 'Could not refresh project files. Previous results have been kept.'; }
    finally { if (active(captured) && loads.current(request)) loading = false; }
  }
  async function selectFile(path: string, discard = false) {
    const captured = scope; if (!captured || !active(captured) || path === selectedPath) return;
    if (editorState.busy) { fileError = 'Wait for the current editor operation to finish before switching files.'; return; }
    if (fileDirty && !discard) { pendingPath = path; return; }
    const info = files.find(file => file.path === path);
    if (!info) { fileError = 'This file is no longer in the project. Refresh the file list.'; return; }
    clearFile(); selectedPath = path; fileInfo = info;
    if (previewKind(path) !== 'text' || info.size > 1024 * 1024) return;
    const request = previews.begin(); loadingFile = true;
    try {
      const token = getAuthToken(captured.base); if (!token) throw new Error('Sign in to open this file.');
      const result = await downloadLoreFileText(token, captured.channelId, path);
      if (!active(captured) || !previews.current(request) || selectedPath !== path) return;
      if (result.content.length > 1024 * 1024) throw new Error('This file is too large to preview here. Download it instead.');
      fileContent = result.content; fileInfo = { ...info, etag: result.etag };
    } catch (e) { if (active(captured) && previews.current(request)) fileError = e instanceof Error ? e.message : 'Could not load this file. Your other files have not changed.'; }
    finally { if (active(captured) && previews.current(request)) loadingFile = false; }
  }
  async function retryFile() {
    const path = selectedPath; if (!path || fileDirty || editorState.busy) return;
    selectedPath = null; await selectFile(path);
  }
  async function downloadSelected() {
    const captured = scope, path = selectedPath;
    if (!captured || !path || !active(captured)) return;
    try {
      const token = getAuthToken(captured.base); if (!token) throw new Error('Sign in to download this file.');
      const url = await getSignedLoreUrl(token, captured.channelId, path);
      if (!active(captured) || selectedPath !== path) return;
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = path.split('/').pop() || 'file'; anchor.rel = 'noopener'; anchor.click();
    } catch (e) { if (active(captured)) fileError = e instanceof Error ? e.message : 'Download failed.'; }
  }
</script>

<section class="code-panel" aria-label="Project files">
  <header class="panel-header"><div><h2>Project files</h2><p title={repo?.repoName}>{repo?.repoName || 'Browse the current project'}</p></div><button type="button" disabled={!scope || loading} onclick={() => void refresh()}>{loading ? 'Refreshing…' : 'Refresh'}</button></header>
  {#if error}<div class="panel-alert" role="alert">{error}<button type="button" disabled={loading} onclick={() => void refresh()}>Try again</button></div>{/if}
  {#if pendingChannel !== null}<div class="panel-alert" role="status"><strong>Your editor is still on {repo?.repoName || 'the previous project'}.</strong><p>Save, download, or discard your draft before leaving.</p><button type="button" disabled={editorState.busy} onclick={openCurrentProject}>Open current project…</button></div>{/if}
  {#if pendingPath}<div class="panel-alert" role="alert"><strong>Keep your changes to {selectedPath}?</strong><p>Opening {pendingPath} would close this draft.</p><div class="alert-actions"><button type="button" onclick={() => pendingPath = null}>Keep editing</button><button type="button" disabled={editorState.busy} onclick={() => { const path = pendingPath; if (path) void selectFile(path, true); }}>Discard and open file</button></div></div>{/if}
  {#if !scope}<div class="panel-empty"><h3>Choose a project</h3><p>Open a Project channel to browse its files. Your other workspaces remain available.</p></div>
  {:else if loading && !repo}<div class="panel-empty" role="status">Loading project files…</div>
  {:else if !repo && !error}<div class="panel-empty"><h3>No project connected here</h3><p>Open or connect a project from the main Project workspace.</p></div>
  {:else if repo}
    <div class="panel-toolbar"><button type="button" aria-expanded={treeVisible} onclick={() => treeVisible = !treeVisible}>{treeVisible ? 'Hide files' : 'Show files'}</button><span>{isMirror(repo) ? 'Read-only mirror' : canWrite ? 'Editing available' : 'View only'}</span></div>
    <div class="panel-workspace" class:tree-hidden={!treeVisible}>
      {#if treeVisible}<nav class="panel-tree" aria-label="Project file browser"><LoreFileTree {files} {selectedPath} {loading} onSelect={path => void selectFile(path)} onOpen={path => void selectFile(path)} onContextMenu={() => {}} /></nav>{/if}
      <div class="panel-viewer">
        {#if selectedPath}
          {#if fileError}<div class="panel-alert" role="alert">{fileError}<div class="alert-actions"><button type="button" disabled={fileDirty || editorState.busy} onclick={() => void retryFile()}>Retry file</button><button type="button" onclick={() => void downloadSelected()}>Download file</button></div></div>{/if}
          {#key `${scope.base}:${scope.account}:${scope.session}:${scope.channelKey}:${selectedPath}`}
            <LoreFileViewer filePath={selectedPath} {fileContent} {fileInfo} loading={loadingFile} onClose={clearFile} canEdit={canWrite} token={getAuthToken(scope.base) ?? undefined} channelId={scope.channelId} onSaved={() => void refresh()} onDirtyChange={value => fileDirty = value} onStateChange={value => editorState = value} />
          {/key}
        {:else}<div class="panel-empty"><h3>Open a file to begin</h3><p>Choose a file from the browser. Code opens as source; publishing a revision is a separate action from editing.</p>{#if !treeVisible}<button type="button" onclick={() => treeVisible = true}>Show files</button>{/if}</div>{/if}
      </div>
    </div>
    {#if selectedPath}<footer class="panel-status" role="status"><span>{loadingFile ? 'Loading file…' : editorStatus(editorState)}</span><span title={selectedPath}>{selectedPath}</span></footer>{/if}
  {/if}
</section>

<style>
  .code-panel { display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; overflow:hidden; color:var(--text-heading, #e8eded); background:var(--surface-base, #111b20); container-type:inline-size; }
  .panel-header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px; border-bottom:1px solid var(--color-border-primary, #334047); flex-shrink:0; }.panel-header div { min-width:0; }.panel-header h2 { margin:0; font-size:16px; }.panel-header p { margin:4px 0 0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-secondary, #b7c3c9); font-size:12px; }
  button { font:inherit; font-size:12px; min-height:36px; padding:7px 11px; border:1px solid var(--color-border-primary, #334047); border-radius:8px; background:var(--surface-raised, #1b292f); color:inherit; cursor:pointer; }button:disabled { opacity:.5; cursor:not-allowed; }button:focus-visible { outline:2px solid var(--accent-primary-color, #7cbeb2); outline-offset:2px; }
  .panel-toolbar { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 12px; border-bottom:1px solid var(--color-border-primary, #334047); }.panel-toolbar span { font-size:11px; color:var(--text-secondary, #b7c3c9); }
  .panel-workspace { display:grid; grid-template-columns:minmax(150px, 30%) minmax(0, 1fr); flex:1; min-height:0; overflow:hidden; }.panel-workspace.tree-hidden { grid-template-columns:minmax(0, 1fr); }.panel-tree { min-height:0; overflow:auto; padding:6px; border-right:1px solid var(--color-border-primary, #334047); background:var(--surface-raised, #1b292f); }.panel-viewer { display:flex; flex-direction:column; min-height:0; min-width:0; overflow:auto; }
  .panel-empty { margin:auto; max-width:440px; padding:28px 20px; line-height:1.6; }.panel-empty h3 { margin:0 0 8px; font-size:17px; }.panel-empty p { font-size:13px; color:var(--text-secondary, #b7c3c9); }
  .panel-alert { padding:12px 14px; border-bottom:1px solid var(--color-border-primary, #334047); border-left:3px solid var(--accent-primary-color, #7cbeb2); background:var(--surface-raised, #1b292f); font-size:12px; line-height:1.6; flex-shrink:0; }.panel-alert p { margin:4px 0 8px; }.panel-alert>button { margin:6px 0 0 8px; }.alert-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
  .panel-status { display:flex; flex-wrap:wrap; justify-content:space-between; gap:4px 12px; padding:8px 12px; border-top:1px solid var(--color-border-primary, #334047); font-size:11px; color:var(--text-secondary, #b7c3c9); flex-shrink:0; }.panel-status span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%; }
  @container (max-width:600px) { .panel-workspace { grid-template-columns:minmax(0, 1fr); grid-template-rows:minmax(100px, 30%) minmax(0, 1fr); }.panel-workspace.tree-hidden { grid-template-rows:minmax(0, 1fr); }.panel-tree { border-right:0; border-bottom:1px solid var(--color-border-primary, #334047); } }
  @media (pointer:coarse) { button { min-height:44px; } }
</style>
