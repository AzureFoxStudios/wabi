<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { getSocket } from '$lib/socket';
	import { getApiBase } from '$lib/api/utils';
	import { getAuthToken, getStoredDbUserId, authSessionGeneration } from '$lib/authSession';
	import {
		getLoreRepo, listLoreFiles, getLoreRepoHistory, getLoreBranches, checkLoreHealth,
		getSignedLoreUrl, downloadLoreFileText, downloadLoreProject, uploadLoreFile,
		createLoreRepo, createLoreBranch, deleteLoreRepo, deleteLoreFile, lockLoreFile, unlockLoreFile,
		reviewLoreBranch, updateLoreRepoSettings, parseLoreChannelId,
		type LoreRepo, type LoreFileInfo, type LoreRevision, type LoreBranch
	} from '$lib/api/lore';
	import { findReadmePath } from '$lib/lore/readmeDefault';
	import { PROJECT_TABS, formatBytes, newestFirst, revisionTime, isMirror, previewKind, uploadPath, SelectionEpoch } from '$lib/lore/workspacePresentation';
	import LoreIcon from './LoreIcon.svelte';
	import LoreDialog from './LoreDialog.svelte';
	import LoreFileTree from './LoreFileTree.svelte';
	import LoreFileViewer from './LoreFileViewer.svelte';
	import LoreLocalChanges from './LoreLocalChanges.svelte';
	import LoreHistoryBrowser from './LoreHistoryBrowser.svelte';
	import LoreRolesAdmin from './LoreRolesAdmin.svelte';
	import LoreConnectModal from './LoreConnectModal.svelte';
	import LoreConnectPanel from '../sidebar/LoreConnectPanel.svelte';
	import LoreEditorBridge from './LoreEditorBridge.svelte';
	import LoreScriptRunner from './LoreScriptRunner.svelte';
	import LoreMirrorPanel from './LoreMirrorPanel.svelte';
	import LoreActivityFeed from './LoreActivityFeed.svelte';
	import './loreWorkspace.css';

	let { channelKey, projectName, serverUrl, accountId, roleName, projects = [], onSelectProject }: {
		channelKey: string; projectName: string; serverUrl: string; accountId: string; roleName: string;
		projects?: { id: string; name: string }[]; onSelectProject?: (id: string) => void;
	} = $props();
	const session = authSessionGeneration(serverUrl);
	const channelId = parseLoreChannelId(channelKey)!;
	let alive = true;
	const loads = new SelectionEpoch(), previews = new SelectionEpoch();
	let tab = $state('files');
	let repo = $state<LoreRepo | null>(null);
	let files = $state<LoreFileInfo[]>([]);
	let revisions = $state<LoreRevision[]>([]);
	let branches = $state<LoreBranch[]>([]);
	let loading = $state(true);
	let health = $state('checking');
	let error = $state('');
	let notice = $state('');
	let busy = $state('');
	let selectedPath = $state<string | null>(null);
	let previewKey = $state(0);
	let selectedContent = $state<string | null>(null);
	let selectedMedia = $state<string | null>(null);
	let fileLoading = $state(false);
	let fileError = $state('');
	let fileDirty = $state(false);
	let stalePreview = $state(false);
	let fileTreeVisible = $state(true);
	let localOpened = $state(false);
	let historyOpened = $state(false);
	let historyPath = $state('');
	let counts = $state({ outgoing: 0, incoming: 0, conflicts: 0 });
	let showConnect = $state(false);
	let showTokens = $state(false);
	let showEditor = $state(false);
	let settingsSection = $state<'general' | 'permissions'>('general');
	let permissionDirty = $state(false);
	let reviewDraft = $state<boolean | null>(null);
	let queue = $state<File[]>([]);
	let queueFolder = $state(false);
	let destination = $state('uploads');
	let uploadSummary = $state('');
	let uploadProgress = $state('');
	let cancelUpload = false;
	let uploadInput: HTMLInputElement, folderInput: HTMLInputElement;
	let createOpen = $state(false);
	let newPath = $state('README.md');
	let newText = $state('# New document\n\n');
	const starters = [
	{
		"name": "Document",
		"path": "README.md",
		"text": "# New document\n\n"
	},
	{
		"name": "Rust module",
		"path": "src/module.rs",
		"text": "pub fn hello() -> &'static str {\n    \"Hello, Wabi!\"\n}\n"
	},
	{
		"name": "TypeScript module",
		"path": "src/module.ts",
		"text": "export function hello(): string {\n  return 'Hello, Wabi!';\n}\n"
	},
	{
		"name": "Python script",
		"path": "scripts/script.py",
		"text": "def hello():\n    return \"Hello, Wabi!\"\n"
	},
	{
		"name": "Cargo manifest",
		"path": "Cargo.toml",
		"text": "[package]\nname = \"example\"\nversion = \"0.1.0\"\n"
	},
	{
		"name": "Package manifest",
		"path": "package.json",
		"text": "{\n  \"name\": \"example\",\n  \"version\": \"0.1.0\"\n}\n"
	}
];
	let branchOpen = $state(false);
	let newBranch = $state('');
	let branchFrom = $state('main');
	let confirmation = $state<{ kind: 'file' | 'detach' | 'delete'; path: string; expected: string; etag?: string } | null>(null);
	let confirmationText = $state('');
	let contextTarget = $state<{ path: string; folder: boolean } | null>(null);
	let initialReadmeOpened = false;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	let canManage = $derived(['owner', 'admin'].includes(roleName.toLowerCase()));
	let canEdit = $derived(canManage || roleName.toLowerCase() === 'developer');
	let readOnly = $derived(isMirror(repo));
	let canWrite = $derived(!readOnly && (canEdit || roleName.toLowerCase() === 'artist'));
	let selectedFile = $derived(files.find(file => file.path === selectedPath) ?? null);
	let reviewQueue = $derived(branches.filter(branch => branch.name.startsWith('uploads/')));
	let changeCount = $derived(counts.outgoing + counts.incoming + counts.conflicts);
	let reviewDirty = $derived(reviewDraft !== null && reviewDraft !== !!repo?.auto_branch_on_upload);
	let activity = $derived(newestFirst(revisions).filter(revision => revisionTime(revision.timestamp) !== null).map(revision => ({
		type: 'commit' as const, author_id: String(revision.authorId), message: revision.message,
		timestamp: revisionTime(revision.timestamp)!, metadata: { hash: revision.hash }
	})));

	function active() {
		return alive && getApiBase().replace(/\/+$/, '') === serverUrl.replace(/\/+$/, '') &&
			authSessionGeneration(serverUrl) === session && String(getStoredDbUserId(serverUrl) ?? '') === accountId;
	}
	function token(): string {
		if (!active()) throw new Error('Your account or server changed. Reopen this project.');
		const value = getAuthToken(serverUrl); if (!value) throw new Error('Sign in to access this project.'); return value;
	}
	async function reload() {
		const request = loads.begin(); loading = true;
		try {
			const auth = token();
			const nextRepo = await getLoreRepo(auth, channelId);
			const [nextFiles, nextHistory, nextBranches] = nextRepo ? await Promise.all([
				listLoreFiles(auth, channelId), getLoreRepoHistory(auth, channelId), getLoreBranches(auth, channelId)
			]) : [[], [], []];
			if (!active() || !loads.current(request)) return;
			repo = nextRepo; files = nextFiles; revisions = nextHistory; branches = nextBranches; error = '';
			if (!initialReadmeOpened && files.length) {
				initialReadmeOpened = true;
				const path = findReadmePath(files); if (path && !selectedPath && tab === 'files') void openFile(path);
			}
		} catch (e) { if (active() && loads.current(request)) error = e instanceof Error ? e.message : 'Could not load repository data. Previous results have been retained.'; }
		finally { if (loads.current(request)) loading = false; }
	}
	async function refreshHealth() {
		try { const result = await checkLoreHealth(token()); if (active()) health = result.status; }
		catch { if (active()) health = 'error'; }
	}
	function scheduleRefresh() {
		clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => { if (!active()) return; if (busy) scheduleRefresh(); else void reload(); }, 500);
	}
	onMount(() => {
		void reload(); void refreshHealth();
		const socket = getSocket();
		const invalidated = (payload: { path?: string }) => { if (payload?.path === selectedPath) stalePreview = true; scheduleRefresh(); };
		const reconnected = () => { scheduleRefresh(); void refreshHealth(); };
		socket?.on('lore:file-changed', invalidated as never); socket?.on('connect', reconnected);
		return () => { socket?.off('lore:file-changed', invalidated as never); socket?.off('connect', reconnected); };
	});
	onDestroy(() => { alive = false; cancelUpload = true; loads.dispose(); previews.dispose(); clearTimeout(refreshTimer); });

	async function run(label: string, action: (auth: string) => Promise<void>) {
		if (busy) return;
		busy = label; error = ''; notice = '';
		try { await action(token()); if (active()) await reload(); }
		catch (e) { if (active()) error = e instanceof Error ? e.message : `${label} failed.`; }
		finally { if (alive) busy = ''; }
	}
	function menuDismiss(node: HTMLElement) {
		const close = (event: MouseEvent) => {
			const target = event.target as HTMLElement;
			if (target.closest('.lw-menu button')) target.closest('details')?.removeAttribute('open');
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			const opened = node.querySelector<HTMLDetailsElement>('details[open]');
			if (opened) { event.stopPropagation(); opened.open = false; opened.querySelector('summary')?.focus(); }
		};
		node.addEventListener('click', close); node.addEventListener('keydown', escape);
		return { destroy() { node.removeEventListener('click', close); node.removeEventListener('keydown', escape); } };
	}
	function navigate(next: string) {
		tab = next;
		if (next === 'changes') localOpened = true;
		if (next === 'history') historyOpened = true;
	}
	function canLeave() {
		return !busy && (!(fileDirty || permissionDirty || reviewDirty) || window.confirm('Leave this project and discard unsaved editor or settings changes? Staged local files remain saved.'));
	}
	function chooseProject(event: Event) {
		const input = event.currentTarget as HTMLSelectElement;
		if (canLeave()) onSelectProject?.(input.value); else input.value = channelKey;
	}
	async function openFile(path: string) {
		if (fileDirty && !window.confirm('Discard unsaved editor changes before opening this file?')) return;
		const request = previews.begin();
		previewKey++; selectedPath = path; selectedContent = null; selectedMedia = null; fileLoading = true; fileError = ''; fileDirty = false; stalePreview = false; navigate('files');
		const info = files.find(file => file.path === path), kind = previewKind(path);
		try {
			const auth = token();
			if (kind === 'text' && (info?.size ?? Infinity) <= 2 * 1024 * 1024) {
				const result = await downloadLoreFileText(auth, channelId, path);
				if (active() && previews.current(request)) selectedContent = result.content;
			} else if (['image', 'audio', 'video'].includes(kind)) {
				const url = await getSignedLoreUrl(auth, channelId, path);
				if (active() && previews.current(request)) selectedMedia = url;
			}
		} catch (e) { if (active() && previews.current(request)) fileError = e instanceof Error ? e.message : 'Could not load this file.'; }
		finally { if (previews.current(request)) fileLoading = false; }
	}
	function closeFile() { previews.begin(); selectedPath = null; selectedContent = null; selectedMedia = null; fileDirty = false; fileLoading = false; fileError = ''; }
	function comparePath(path: string) { historyPath = path; contextTarget = null; navigate('history'); }
	async function download(path: string) {
		try { const url = await getSignedLoreUrl(token(), channelId, path); if (!active()) return; const anchor = document.createElement('a'); anchor.href = url; anchor.download = path.split('/').pop() ?? 'file'; anchor.rel = 'noopener'; anchor.click(); }
		catch (e) { if (active()) error = e instanceof Error ? e.message : 'Download failed.'; }
	}
	function queueFiles(event: Event, folder: boolean) {
		const input = event.currentTarget as HTMLInputElement;
		queue = Array.from(input.files ?? []); input.value = ''; queueFolder = folder;
		uploadSummary = `Add ${queue.length} file${queue.length === 1 ? '' : 's'}`;
	}
	function plannedPath(file: File) { return uploadPath(file.name, queueFolder ? file.webkitRelativePath : '', destination); }
	async function uploadSelection() {
		if (!queue.length || !uploadSummary.trim() || !canWrite) return;
		const selected = [...queue], summary = uploadSummary.trim(); cancelUpload = false;
		await run('Uploading files', async auth => {
			// Validate every destination before starting, and use preconditions for overwrites.
			const planned = selected.map(file => ({ file, path: plannedPath(file) }));
			if (new Set(planned.map(item => item.path)).size !== planned.length) throw new Error('Two selected files have the same destination. Upload them separately.');
			for (let index = 0; index < planned.length; index++) {
				if (cancelUpload || !active()) break;
				const item = planned[index], previous = files.find(file => file.path === item.path);
				if (previous && !previous.etag) throw new Error(`The server did not provide a version identifier for ${item.path}. Reload before replacing it.`);
				uploadProgress = `${index + 1} of ${planned.length}`;
				const result = await uploadLoreFile(auth, channelId, item.path, item.file, summary, previous?.etag ?? null);
				if (!active()) return;
				queue = queue.filter(file => file !== item.file);
				notice = result.pending_review ? 'Files submitted to the review queue.' : 'Files uploaded as individual revisions.';
			}
			if (cancelUpload) notice = 'Upload stopped. Files already accepted remain on the server; the rest are still selected.';
		});
		uploadProgress = '';
	}
	function confirmAction(kind: 'file' | 'detach' | 'delete', path: string) {
		confirmationText = ''; contextTarget = null;
		confirmation = { kind, path, expected: kind === 'file' ? path.split('/').pop()! : repo?.repoName ?? '', etag: files.find(file => file.path === path)?.etag ?? undefined };
	}
	async function executeConfirmation() {
		const action = confirmation;
		if (!action || confirmationText !== action.expected || !action.expected) return;
		await run('Applying confirmed change', async auth => {
			if (action.kind === 'file') {
				if (!action.etag) throw new Error('No file version identifier was returned. Reload the repository before deleting this file.');
				await deleteLoreFile(auth, channelId, action.path, `Delete ${action.path}`, action.etag);
			} else await deleteLoreRepo(auth, channelId, action.kind);
			if (!active()) return; confirmation = null;
			if (action.kind !== 'file' || selectedPath === action.path) closeFile();
			notice = action.kind === 'detach' ? 'Repository detached. Its files and history remain on the server.' : 'Confirmed change completed.';
		});
	}
	function settingsPane(next: 'general' | 'permissions') {
		if (permissionDirty && next !== settingsSection && !window.confirm('Discard unsaved permission changes?')) return;
		settingsSection = next;
	}
</script>

<section use:menuDismiss class="lore-workbench" aria-label={`${projectName} project workspace`}>
	<header class="lw-project-header">
		<div class="lw-project-identity"><span class="lw-project-mark"><LoreIcon name="folder" size={24} /></span><div><p class="lw-eyebrow">Project repository</p><h1>{repo?.repoName ?? projectName}</h1></div><span class="lw-badge">{readOnly ? 'Read-only mirror' : repo?.imported_from ? 'Imported' : 'Lore'}</span></div>
		<div class="lw-header-actions">
			{#if onSelectProject && projects.length > 1}<label class="lw-project-picker"><span class="lw-sr-only">Switch project</span><select value={channelKey} onchange={chooseProject} disabled={!!busy}>{#each projects as project (project.id)}<option value={project.id}>{project.name}</option>{/each}</select></label>{/if}
			<span class="lw-service" title="Repository service availability, not local sync status"><span class:online={health === 'ok'}></span>{health === 'ok' ? 'Service online' : health === 'checking' ? 'Checking service' : 'Service unavailable'}</span>
			<button class="lw-button" onclick={() => navigate('changes')}><LoreIcon name="folder" />Local folder</button>
			<button class="lw-button" disabled={!repo || !!busy} onclick={() => void run('Preparing download', auth => downloadLoreProject(auth, channelId))}><LoreIcon name="download" />Download a copy</button>
		</div>
	</header>
	<nav class="lw-navigation" aria-label="Project sections">
		{#each PROJECT_TABS as item}<button class="lw-nav-button" class:is-active={tab === item} aria-current={tab === item ? 'page' : undefined} onclick={() => navigate(item)}><LoreIcon name={item} />{item[0].toUpperCase() + item.slice(1)}{#if item === 'changes' && changeCount}<span class="lw-count">{changeCount}</span>{/if}{#if item === 'review' && reviewQueue.length}<span class="lw-count">{reviewQueue.length}</span>{/if}</button>{/each}
		<details class="lw-tools"><summary><LoreIcon name="tools" />Tools<LoreIcon name="chevron" size={14} /></summary><div class="lw-menu"><button onclick={() => navigate('timeline')}>Activity timeline</button><button onclick={() => navigate('automation')}>Scripts and mirrors</button><button disabled={!repo || !canEdit} onclick={() => showEditor = true}>External editor</button><button disabled={!repo} onclick={() => showTokens = true}>Command-line connections</button></div></details>
	</nav>
	{#if error}<div class="lw-alert" role="alert">{error}<button class="lw-button" disabled={loading} onclick={() => void reload()}>Retry</button></div>{/if}
	{#if notice}<p class="lw-notice" role="status">{notice}</p>{/if}
	{#if counts.incoming || counts.conflicts}<div class="lw-incoming" role="status"><span>{counts.incoming} incoming · {counts.conflicts} conflicts. Nothing has been applied to your folder.</span><button class="lw-button" onclick={() => navigate('changes')}>Review changes</button></div>{/if}

	<div class="lw-content">
		{#if !repo}
			<div class="lw-setup"><LoreIcon name="folder" size={36} /><h2>{loading ? 'Loading repository…' : 'Connect this project'}</h2><p>Keep shared files and their revision history here. A local folder can be connected after the repository is ready.</p>{#if !loading && canEdit}<div class="lw-actions"><button class="lw-button lw-primary" disabled={!!busy} onclick={() => void run('Creating repository', async auth => { await createLoreRepo(auth, channelId, projectName); })}>Create repository</button><button class="lw-button" onclick={() => showConnect = true}>Link or import existing…</button></div>{/if}</div>
		{:else}
			<!-- Stable mounts retain editor state, tree expansion and the local detection lease. -->
			<section hidden={tab !== 'files'} class="lw-panel lw-files" aria-label="Repository files">
				<div class="lw-file-tools"><div class="lw-actions"><button class="lw-button" aria-expanded={fileTreeVisible} onclick={() => fileTreeVisible = !fileTreeVisible}><LoreIcon name="menu" />Files</button><span class="lw-muted">{files.length} files</span></div><div class="lw-actions">
					<details class="lw-tools"><summary><LoreIcon name="branch" />Branches ({branches.length})</summary><div class="lw-menu"><p>Branch listing only. This server does not expose a working-tree branch switch.</p>{#each branches as branch (branch.name)}<code>{branch.name}</code>{/each}{#if canEdit && !readOnly}<button onclick={() => { branchFrom = branches.find(item => item.name === 'main')?.name ?? branches[0]?.name ?? ''; branchOpen = true; }}>Create branch…</button>{/if}</div></details>
					{#if canWrite}<details class="lw-tools"><summary class="lw-primary"><LoreIcon name="plus" />Add files</summary><div class="lw-menu"><button onclick={() => { destination = 'uploads'; uploadInput.click(); }}>Upload files…</button><button onclick={() => { destination = 'uploads'; folderInput.click(); }}>Upload a folder…</button><button onclick={() => createOpen = true}>New text file…</button></div></details>{/if}
				</div></div>
				<div class="lw-file-layout" class:tree-hidden={!fileTreeVisible}>
					<aside class="lw-tree" hidden={!fileTreeVisible} aria-label="Project file browser"><LoreFileTree {files} {selectedPath} loading={loading && !files.length} onSelect={() => {}} onOpen={openFile} onContextMenu={(path, event, folder = false) => { event.preventDefault(); contextTarget = { path, folder }; }} /></aside>
					<div class="lw-preview">
						{#if selectedPath}
							{#snippet fileActions()}<button class="lw-text-button" onclick={() => comparePath(selectedPath!)}>History & compare</button><details class="lw-tools"><summary>File actions<LoreIcon name="chevron" size={14} /></summary><div class="lw-menu"><button onclick={() => void navigator.clipboard.writeText(selectedPath!).catch(() => { error = 'Could not copy the path.'; })}>Copy path</button>{#if canWrite}<button onclick={() => void run('Updating lock', auth => selectedFile?.lockedBy ? unlockLoreFile(auth, channelId, selectedPath!) : lockLoreFile(auth, channelId, selectedPath!))}>{selectedFile?.lockedBy ? 'Unlock file' : 'Lock file'}</button><button class="lw-danger-text" onclick={() => confirmAction('file', selectedPath!)}>Delete file…</button>{/if}</div></details>{/snippet}
							{#if stalePreview}<p class="lw-notice">A newer server version may be available. <button class="lw-text-button" onclick={() => void openFile(selectedPath!)}>Reload preview</button></p>{/if}
							{#if fileError}<p class="lw-alert" role="alert">{fileError}<button class="lw-button" onclick={() => void openFile(selectedPath!)}>Retry preview</button></p>{/if}
							{#if selectedMedia && ['audio', 'video'].includes(previewKind(selectedPath))}<div class="lw-media">{@render fileActions()}<h2>{selectedPath.split('/').pop()}</h2>{#if previewKind(selectedPath) === 'audio'}<audio controls src={selectedMedia}></audio>{:else}<video controls src={selectedMedia}><track kind="captions" /></video>{/if}<button class="lw-button" onclick={() => void download(selectedPath!)}>Download file</button></div>
							{:else}{#key previewKey}<LoreFileViewer filePath={selectedPath} fileContent={selectedContent} fileInfo={selectedFile} loading={fileLoading} mediaUrl={selectedMedia} canEdit={canWrite} token={getAuthToken(serverUrl) ?? undefined} {channelId} onClose={closeFile} onSaved={() => void reload()} onDirtyChange={(value) => fileDirty = value} actions={fileActions} />{/key}{/if}
						{:else}<div class="lw-setup"><LoreIcon name="file" size={36} /><h2>Choose a file</h2><p>Read documents, inspect code, and preview assets without leaving your project.</p></div>{/if}
					</div>
				</div>
			</section>
			{#if localOpened}<section class="lw-panel lw-local" hidden={tab !== 'changes'} aria-label="Local changes">{#if accountId}<LoreLocalChanges channelId={channelKey} {projectName} {serverUrl} {accountId} onCounts={(value) => counts = value} />{:else}<p class="lw-empty-inline">Sign in to connect a local project folder.</p>{/if}</section>{/if}
			{#if historyOpened}<section class="lw-panel" hidden={tab !== 'history'} aria-label="Repository history"><LoreHistoryBrowser {revisions} {files} {channelId} getToken={token} isActive={active} initialPath={historyPath} /></section>{/if}
			<section class="lw-panel lw-scroll" hidden={tab !== 'review'} aria-label="Review queue"><div class="lw-page"><p class="lw-eyebrow">Team workflow</p><h2>Review</h2><p class="lw-lead">Uploads waiting to become official. Approval and rejection are deliberate actions.</p>{#each reviewQueue as branch (branch.name)}<article class="lw-review-card"><div><span class="lw-badge">Awaiting review</span><h3>{branch.name.replace(/^uploads\//, '')}</h3><code>{branch.name}</code></div>{#if canEdit}<div class="lw-actions"><button class="lw-button" disabled={!!busy} onclick={() => { if (window.confirm(`Reject ${branch.name}?`)) void run('Rejecting upload', auth => reviewLoreBranch(auth, channelId, branch.name, 'reject')); }}>Reject…</button><button class="lw-button lw-primary" disabled={!!busy} onclick={() => { if (window.confirm(`Approve ${branch.name} and make its uploads official?`)) void run('Approving upload', auth => reviewLoreBranch(auth, channelId, branch.name, 'approve')); }}>Approve…</button></div>{/if}</article>{:else}<div class="lw-empty-card"><LoreIcon name="review" size={28} /><h3>No uploads awaiting review</h3><p>{repo.auto_branch_on_upload ? 'New uploads will appear here for approval.' : 'Review is optional for this repository. You can change its policy in Settings.'}</p></div>{/each}</div></section>
			<section class="lw-panel lw-scroll" hidden={tab !== 'settings'} aria-label="Project settings"><div class="lw-page"><p class="lw-eyebrow">Project configuration</p><h2>Settings</h2><nav class="lw-settings-nav" aria-label="Settings sections"><button class="lw-button" aria-pressed={settingsSection === 'general'} onclick={() => settingsPane('general')}>General & workflow</button>{#if canManage}<button class="lw-button" aria-pressed={settingsSection === 'permissions'} onclick={() => settingsPane('permissions')}>Permissions</button>{/if}</nav>
				{#if settingsSection === 'permissions'}<LoreRolesAdmin onClose={() => settingsPane('general')} onDirtyChange={(value) => permissionDirty = value} />{:else}
					<section class="lw-settings-card"><h3>Repository</h3><dl><dt>Name</dt><dd>{repo.repoName}</dd><dt>Channel</dt><dd>{projectName}</dd><dt>Storage</dt><dd>{readOnly ? 'Read-only external mirror' : 'Versioned Lore repository'}</dd>{#if repo.imported_from}<dt>Imported from</dt><dd>{repo.imported_from}</dd>{/if}</dl><p class="lw-help">Repository settings apply to the shared project.</p></section>
					<section class="lw-settings-card"><h3>Review policy</h3><label class="lw-setting-toggle"><input type="checkbox" checked={reviewDraft ?? !!repo.auto_branch_on_upload} disabled={!canEdit || readOnly || !!busy} onchange={(event) => reviewDraft = event.currentTarget.checked} /><span><strong>Require review for uploads</strong><small>New uploads go to a review branch instead of immediately becoming official.</small></span></label><div class="lw-form-footer"><span>{reviewDirty ? 'Unsaved policy change' : 'Current server policy'}</span><button class="lw-button" disabled={!reviewDirty || !!busy} onclick={() => reviewDraft = null}>Cancel</button><button class="lw-button lw-primary" disabled={!canEdit || !reviewDirty || !!busy} onclick={() => void run('Saving review policy', async auth => { await updateLoreRepoSettings(auth, channelId, { auto_branch_on_upload: !!reviewDraft }); if (active()) reviewDraft = null; })}>Save policy</button></div></section>
					<section class="lw-settings-card"><h3>On this computer</h3><p>Connect a local folder and manage automatic detection in Changes. Detected changes are never pulled or published automatically.</p><button class="lw-button" onclick={() => navigate('changes')}>Manage local folder</button></section>
					{#if canEdit}<section class="lw-settings-card lw-danger-zone"><h3>Danger zone</h3><p>Detaching preserves files and history on the server. Deleting permanently erases both.</p><div class="lw-actions"><button class="lw-button" disabled={!!busy} onclick={() => confirmAction('detach', repo!.repoName)}>Detach repository…</button><button class="lw-button lw-danger-text" disabled={!!busy} onclick={() => confirmAction('delete', repo!.repoName)}>Delete repository…</button></div></section>{/if}
				{/if}
			</div></section>
			{#if tab === 'timeline'}<section class="lw-panel lw-scroll"><div class="lw-page"><h2>Activity timeline</h2><LoreActivityFeed {activity} /></div></section>{/if}
			{#if tab === 'automation'}<section class="lw-panel lw-scroll"><div class="lw-page"><h2>Scripts & mirrors</h2><p class="lw-lead">Optional project tools. Nothing runs until you start it.</p>{#if canEdit}<section class="lw-settings-card"><h3>Scripts</h3><LoreScriptRunner channelId={channelKey} /></section><section class="lw-settings-card"><h3>Mirrors</h3><LoreMirrorPanel channelId={channelKey} /></section>{:else}<p>These tools require repository editing access.</p>{/if}</div></section>{/if}
		{/if}
	</div>
	<input class="lw-hidden-input" tabindex="-1" type="file" multiple bind:this={uploadInput} onchange={(event) => queueFiles(event, false)} aria-label="Choose files to upload" />
	<input class="lw-hidden-input" tabindex="-1" type="file" multiple webkitdirectory bind:this={folderInput} onchange={(event) => queueFiles(event, true)} aria-label="Choose folder to upload" />
	{#if queue.length}<LoreDialog title="Add files to this repository" busy={!!busy} onClose={() => queue = []}><p>Uploads create individual revisions{repo?.auto_branch_on_upload ? ' in a review branch' : ' on the server'}. This does not connect or watch the source folder.</p><label class="lw-field">Destination folder<input bind:value={destination} disabled={!!busy} placeholder="uploads" /></label><label class="lw-field">Change summary<input bind:value={uploadSummary} disabled={!!busy} maxlength="2000" /></label><div class="lw-upload-list">{#each queue as file}<p><code>{file.webkitRelativePath || file.name}</code><span>{formatBytes(file.size)}</span></p>{/each}</div>{#if error}<p class="lw-alert" role="alert">{error}</p>{/if}<p class="lw-help">Existing paths are replaced only if the version you loaded still matches.</p><div class="lw-form-footer">{#if busy}<span role="status">Uploading {uploadProgress}</span><button class="lw-button" onclick={() => cancelUpload = true}>Stop after current file</button>{:else}<button class="lw-button" onclick={() => queue = []}>Cancel</button><button class="lw-button lw-primary" disabled={!uploadSummary.trim()} onclick={() => void uploadSelection()}>Upload {queue.length} files</button>{/if}</div></LoreDialog>{/if}
	{#if createOpen}<LoreDialog title="New text file" busy={!!busy} onClose={() => createOpen = false}><label class="lw-field">Start from<select disabled={!!busy} onchange={(event) => { const starter = starters[Number(event.currentTarget.value)]; if (starter) { newPath = starter.path; newText = starter.text; } }}><option value="">Custom text file</option>{#each starters as starter, index}<option value={index}>{starter.name}</option>{/each}</select></label><label class="lw-field">Repository path<input bind:value={newPath} disabled={!!busy} /></label><label class="lw-field">Starter content<textarea bind:value={newText} rows="8" disabled={!!busy}></textarea></label>{#if error}<p class="lw-alert" role="alert">{error}</p>{/if}<div class="lw-form-footer"><button class="lw-button" onclick={() => createOpen = false} disabled={!!busy}>Cancel</button><button class="lw-button lw-primary" disabled={!!busy || !newPath.trim()} onclick={() => void run('Creating file', async auth => { const path = uploadPath(newPath.trim(), '', ''); await uploadLoreFile(auth, channelId, path, newText, `Create ${path}`, null); if (active()) createOpen = false; })}>Create revision</button></div></LoreDialog>{/if}
	{#if branchOpen}<LoreDialog title="Create a branch" busy={!!busy} onClose={() => branchOpen = false}><p>Creates a branch on the server. It does not switch the file browser's working tree.</p><label class="lw-field">Branch name<input bind:value={newBranch} disabled={!!busy} /></label><label class="lw-field">From branch<select bind:value={branchFrom} disabled={!!busy}>{#each branches as branch (branch.name)}<option value={branch.name}>{branch.name}</option>{/each}</select></label>{#if error}<p class="lw-alert" role="alert">{error}</p>{/if}<div class="lw-form-footer"><button class="lw-button lw-primary" disabled={!!busy || !newBranch.trim() || !branchFrom} onclick={() => void run('Creating branch', async auth => { await createLoreBranch(auth, channelId, newBranch.trim(), branchFrom); if (active()) branchOpen = false; })}>Create branch</button></div></LoreDialog>{/if}
	{#if confirmation}<LoreDialog title={confirmation.kind === 'file' ? 'Delete file' : confirmation.kind === 'detach' ? 'Detach repository' : 'Permanently delete repository'} busy={!!busy} onClose={() => confirmation = null}><p>{confirmation.kind === 'file' ? 'This publishes a deletion of the selected file.' : confirmation.kind === 'detach' ? 'The channel will be disconnected. All files and history remain on the server.' : 'Every file and revision in this repository will be permanently erased. There is no undo.'}</p><p><strong>{confirmation.path}</strong></p><label class="lw-field">Type “{confirmation.expected}” to confirm<input bind:value={confirmationText} disabled={!!busy} autocomplete="off" /></label>{#if error}<p class="lw-alert" role="alert">{error}</p>{/if}<div class="lw-form-footer"><button class="lw-button" disabled={!!busy} onclick={() => confirmation = null}>Cancel</button><button class="lw-button lw-danger-text" disabled={!!busy || confirmationText !== confirmation.expected} onclick={() => void executeConfirmation()}>{confirmation.kind === 'detach' ? 'Detach and keep data' : 'Confirm deletion'}</button></div></LoreDialog>{/if}
	{#if contextTarget}<LoreDialog title="File actions" busy={!!busy} onClose={() => contextTarget = null}><code>{contextTarget.path}</code><div class="lw-context-actions">{#if contextTarget.folder && canWrite}<button class="lw-button" onclick={() => { destination = contextTarget!.path; contextTarget = null; uploadInput.click(); }}>Upload files here…</button>{/if}{#if !contextTarget.folder}<button class="lw-button" onclick={() => comparePath(contextTarget!.path)}>History & compare</button><button class="lw-button" onclick={() => void download(contextTarget!.path)}>Download file</button>{#if canWrite}<button class="lw-button" disabled={!!busy} onclick={() => void run('Updating lock', auth => files.find(file => file.path === contextTarget!.path)?.lockedBy ? unlockLoreFile(auth, channelId, contextTarget!.path) : lockLoreFile(auth, channelId, contextTarget!.path))}>{files.find(file => file.path === contextTarget!.path)?.lockedBy ? 'Unlock file' : 'Lock file'}</button><button class="lw-button lw-danger-text" onclick={() => confirmAction('file', contextTarget!.path)}>Delete file…</button>{/if}{/if}</div></LoreDialog>{/if}
	{#if showConnect}<LoreConnectModal channelId={channelKey} onConnected={() => { showConnect = false; void reload(); void refreshHealth(); }} onClose={() => showConnect = false} />{/if}
	{#if showTokens}<LoreConnectPanel {channelKey} repoId={channelId} repoName={repo?.repoName ?? null} onclose={() => showTokens = false} />{/if}
	{#if showEditor}<LoreEditorBridge channelId={channelKey} onClose={() => showEditor = false} />{/if}
</section>
