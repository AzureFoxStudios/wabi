<script lang="ts">
	import { _ } from '$lib/i18n';
	import { pendingNav, takePendingNav } from '$lib/pendingNav';
	import { copyToClipboard } from '$lib/shareToChannel';
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
	import LorePushCalendar from './LorePushCalendar.svelte';
	import LoreHistoryBrowser from './LoreHistoryBrowser.svelte';
	import LoreRolesAdmin from './LoreRolesAdmin.svelte';
	import LoreConnectModal from './LoreConnectModal.svelte';
	import LoreConnectPanel from '../sidebar/LoreConnectPanel.svelte';
	import LoreActivityFeed from './LoreActivityFeed.svelte';
	import './loreWorkspace.css';

	let { channelKey, projectName, serverUrl, accountId, roleName, projects = [], onSelectProject, compactHeader = false, preview = false, initialFilePath }: {
		channelKey: string; projectName: string; serverUrl: string; accountId: string; roleName: string;
		preview?: boolean; initialFilePath?: string; compactHeader?: boolean; projects?: { id: string; name: string }[]; onSelectProject?: (id: string) => void;
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
	let canManage = $derived(!preview && ['owner', 'admin'].includes(roleName.toLowerCase()));
	// Review policy, detach and delete need lore.admin on the server, which the
	// seeded developer role does not have: those controls use canManage.
	let canEdit = $derived(!preview && (canManage || roleName.toLowerCase() === 'developer'));
	let readOnly = $derived(isMirror(repo));
	let canWrite = $derived(!preview && !readOnly && (canEdit || roleName.toLowerCase() === 'artist'));
	$effect(() => { if (!preview && !loading && repo && $pendingNav?.kind === 'lore_file' && $pendingNav.channelId === channelKey) { const ref = takePendingNav('lore_file', channelKey); if (ref?.kind === 'lore_file') { if (files.some(file => file.path === ref.filePath)) void openFile(ref.filePath, ref.lines ?? null); else error = $_('lore_project.linked_missing'); } } });
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
		if (!active()) throw new Error($_('lore_project.account_changed'));
		const value = getAuthToken(serverUrl); if (!value) throw new Error($_('lore_project.sign_in_project')); return value;
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
				const path = initialFilePath || findReadmePath(files); if (path && !selectedPath && tab === 'files') void openFile(path);
			}
		} catch (e) { if (active() && loads.current(request)) error = e instanceof Error ? e.message : $_('lore_project.load_repo_failed'); }
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
		catch (e) { if (active()) error = e instanceof Error ? e.message : $_('lore_project.action_failed', { values: { label } }); }
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
	function tabLabel(item: string) { return ({ files: $_('places.files'), changes: $_('lore_project.tab_changes'), history: $_('lore_project.tab_history'), review: $_('lore_project.tab_review'), settings: $_('settings.title') } as Record<string, string>)[item] ?? item; }
		function starterLabel(name: string) { return ({ 'Document': $_('lore_project.starter_document'), 'Rust module': $_('lore_project.starter_rust'), 'TypeScript module': $_('lore_project.starter_typescript'), 'Python script': $_('lore_project.starter_python'), 'Cargo manifest': $_('lore_project.starter_cargo'), 'Package manifest': $_('lore_project.starter_package') } as Record<string, string>)[name] ?? name; }
		function navigate(next: string) {
		tab = next;
		if (next === 'changes') localOpened = true;
		if (next === 'history') historyOpened = true;
	}
	function canLeave() {
		return !busy && (!(fileDirty || permissionDirty || reviewDirty) || window.confirm($_('lore_project.discard_leave')));
	}
	function chooseProject(event: Event) {
		const input = event.currentTarget as HTMLSelectElement;
		if (canLeave()) onSelectProject?.(input.value); else input.value = channelKey;
	}
	let linkedLines = $state<{ start: number; end: number } | null>(null);
	async function openFile(path: string, lines: { start: number; end: number } | null = null) {
		if (fileDirty && !window.confirm($_('lore_project.discard_editor'))) return;
		const request = previews.begin();
		linkedLines = lines; previewKey++; selectedPath = path; selectedContent = null; selectedMedia = null; fileLoading = true; fileError = ''; fileDirty = false; stalePreview = false; navigate('files');
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
		} catch (e) { if (active() && previews.current(request)) fileError = e instanceof Error ? e.message : $_('lore_project.load_file_failed'); }
		finally { if (previews.current(request)) fileLoading = false; }
	}
	function copyLineLink(start: number, end: number) {
		if (!selectedPath) return;
		const params = new URLSearchParams({ wabiNav: 'lore_file', channelId: channelKey, path: selectedPath, lines: start === end ? String(start) : `${start}-${end}` });
		void copyToClipboard(`${serverUrl.replace(/\/$/, '')}/?${params}`).catch(() => { error = $_('lore_project.copy_link_failed'); });
	}
	function closeFile() { previews.begin(); selectedPath = null; selectedContent = null; selectedMedia = null; fileDirty = false; fileLoading = false; fileError = ''; }
	function comparePath(path: string) { historyPath = path; contextTarget = null; navigate('history'); }
	async function download(path: string) {
		try { const url = await getSignedLoreUrl(token(), channelId, path); if (!active()) return; const anchor = document.createElement('a'); anchor.href = url; anchor.download = path.split('/').pop() ?? 'file'; anchor.rel = 'noopener'; anchor.click(); }
		catch (e) { if (active()) error = e instanceof Error ? e.message : $_('lore_project.download_failed'); }
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
		await run($_('lore_project.busy_uploading_files'), async auth => {
			// Validate every destination before starting, and use preconditions for overwrites.
			const planned = selected.map(file => ({ file, path: plannedPath(file) }));
			if (new Set(planned.map(item => item.path)).size !== planned.length) throw new Error($_('lore_project.same_destination'));
			for (let index = 0; index < planned.length; index++) {
				if (cancelUpload || !active()) break;
				const item = planned[index], previous = files.find(file => file.path === item.path);
				if (previous && !previous.etag) throw new Error($_('lore_project.version_id_missing', { values: { path: item.path } }));
				uploadProgress = `${index + 1} of ${planned.length}`;
				const result = await uploadLoreFile(auth, channelId, item.path, item.file, summary, previous?.etag ?? null);
				if (!active()) return;
				queue = queue.filter(file => file !== item.file);
				notice = result.pending_review ? $_('lore_project.sent_review') : $_('lore_project.uploaded_revisions');
			}
			if (cancelUpload) notice = $_('lore_project.upload_stopped');
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
		await run($_('lore_project.busy_applying_change'), async auth => {
			if (action.kind === 'file') {
				if (!action.etag) throw new Error($_('lore_project.no_version_id'));
				await deleteLoreFile(auth, channelId, action.path, `Delete ${action.path}`, action.etag);
			} else await deleteLoreRepo(auth, channelId, action.kind);
			if (!active()) return; confirmation = null;
			if (action.kind !== 'file' || selectedPath === action.path) closeFile();
			notice = action.kind === 'detach' ? $_('lore_project.detached_notice') : $_('lore_project.change_done');
		});
	}
	function settingsPane(next: 'general' | 'permissions') {
		if (permissionDirty && next !== settingsSection && !window.confirm($_('lore_project.discard_perms'))) return;
		settingsSection = next;
	}
</script>

<section use:menuDismiss class="lore-workbench" aria-label={$_('lore_project.workspace_label', { values: { project: projectName } })}>
	<header class="lw-project-header" class:compact={compactHeader}>
		<div class="lw-project-identity"><span class="lw-project-mark"><LoreIcon name="folder" size={24} /></span><div><p class="lw-eyebrow">{$_('lore_project.project_repository')}</p><h1>{repo?.repoName ?? projectName}</h1></div><span class="lw-badge">{readOnly ? $_('lore_project.read_only_mirror') : repo?.imported_from ? $_('lore_project.imported') : $_('lore_project.lore_badge')}</span></div>
		<div class="lw-header-actions">
			{#if onSelectProject && projects.length > 1}<label class="lw-project-picker"><span class="lw-sr-only">{$_('lore_project.switch_project')}</span><select value={channelKey} onchange={chooseProject} disabled={!!busy}>{#each projects as project (project.id)}<option value={project.id}>{project.name}</option>{/each}</select></label>{/if}
			<span class="lw-service" title={$_('lore_project.service_title')}><span class:online={health === 'ok'}></span>{health === 'ok' ? $_('lore_project.service_online') : health === 'checking' ? $_('lore_project.service_checking') : $_('lore_project.service_unavailable')}</span>
			<button class="lw-button" onclick={() => navigate('changes')}><LoreIcon name="folder" />{$_('lore_project.local_folder')}</button>
			<button class="lw-button" disabled={!repo || !!busy} onclick={() => void run($_('lore_project.busy_prepare_download'), auth => downloadLoreProject(auth, channelId))}><LoreIcon name="download" />{$_('lore_project.download_copy')}</button>
		</div>
	</header>
	<nav class="lw-navigation" aria-label={$_('lore_project.project_sections')}>
		{#each PROJECT_TABS as item}<button class="lw-nav-button" class:is-active={tab === item} aria-current={tab === item ? 'page' : undefined} onclick={() => navigate(item)}><LoreIcon name={item} />{tabLabel(item)}{#if item === 'changes' && changeCount}<span class="lw-count">{changeCount}</span>{/if}{#if item === 'review' && reviewQueue.length}<span class="lw-count">{reviewQueue.length}</span>{/if}</button>{/each}
		<details class="lw-tools"><summary><LoreIcon name="tools" />{$_('wb.group_tools')}<LoreIcon name="chevron" size={14} /></summary><div class="lw-menu"><button onclick={() => navigate('timeline')}>{$_('lore_project.activity_timeline')}</button><button disabled={!repo} onclick={() => showTokens = true}>{$_('lore_project.command_connections')}</button></div></details>
	</nav>
	{#if error}<div class="lw-alert" role="alert">{error}<button class="lw-button" disabled={loading} onclick={() => void reload()}>{$_('common.retry')}</button></div>{/if}
	{#if notice}<p class="lw-notice" role="status">{notice}</p>{/if}
	{#if counts.incoming || counts.conflicts}<div class="lw-incoming" role="status"><span>{$_('lore_project.incoming_summary', { values: { incoming: counts.incoming, conflicts: counts.conflicts } })}</span><button class="lw-button" onclick={() => navigate('changes')}>{$_('lore_project.review_changes')}</button></div>{/if}

	<div class="lw-content">
		{#if !repo}
			<div class="lw-setup"><LoreIcon name="folder" size={36} /><h2>{loading ? $_('lore_project.loading_repo') : $_('lore_project.connect_project')}</h2><p>{$_('lore_project.connect_body')}</p>{#if !loading && canEdit}<div class="lw-actions"><button class="lw-button lw-primary" disabled={!!busy} onclick={() => void run($_('lore_project.busy_creating_repo'), async auth => { await createLoreRepo(auth, channelId, projectName); })}>{$_('lore_project.create_repository')}</button><button class="lw-button" onclick={() => showConnect = true}>{$_('lore_project.link_import')}</button></div>{/if}</div>
		{:else}
			<!-- Stable mounts retain editor state, tree expansion and the local detection lease. -->
			<section hidden={tab !== 'files'} class="lw-panel lw-files" aria-label={$_('lore_project.repository_files')}>
				<div class="lw-file-tools"><div class="lw-actions"><button class="lw-button" aria-expanded={fileTreeVisible} onclick={() => fileTreeVisible = !fileTreeVisible}><LoreIcon name="menu" />{$_('places.files')}</button><span class="lw-muted">{$_('lore_project.file_count', { values: { count: files.length } })}</span></div><div class="lw-actions">
					<details class="lw-tools"><summary><LoreIcon name="branch" />{$_('lore_project.branches_count', { values: { count: branches.length } })}</summary><div class="lw-menu"><p>{$_('lore_project.branch_listing_note')}</p>{#each branches as branch (branch.name)}<code>{branch.name}</code>{/each}{#if canEdit && !readOnly}<button onclick={() => { branchFrom = branches.find(item => item.name === 'main')?.name ?? branches[0]?.name ?? ''; branchOpen = true; }}>{$_('lore_project.create_branch_more')}</button>{/if}</div></details>
					{#if canWrite}<details class="lw-tools"><summary class="lw-primary"><LoreIcon name="plus" />{$_('lore_project.add_files')}</summary><div class="lw-menu"><button onclick={() => { destination = 'uploads'; uploadInput.click(); }}>{$_('lore_project.upload_files')}</button><button onclick={() => { destination = 'uploads'; folderInput.click(); }}>{$_('lore_project.upload_folder')}</button><button onclick={() => createOpen = true}>{$_('lore_project.new_text_file')}</button></div></details>{/if}
				</div></div>
				<div class="lw-file-layout" class:tree-hidden={!fileTreeVisible}>
					<aside class="lw-tree" hidden={!fileTreeVisible} aria-label={$_('lore_project.file_browser_aria')}><LoreFileTree {files} {selectedPath} loading={loading && !files.length} onSelect={() => {}} onOpen={openFile} onContextMenu={(path, event, folder = false) => { event.preventDefault(); contextTarget = { path, folder }; }} /></aside>
					<div class="lw-preview">
						{#if selectedPath}
							{#snippet fileActions()}<button class="lw-text-button" onclick={() => comparePath(selectedPath!)}>{$_('lore_project.history_compare')}</button><details class="lw-tools"><summary>{$_('lore_project.file_actions')}<LoreIcon name="chevron" size={14} /></summary><div class="lw-menu"><button onclick={() => void copyToClipboard(`${serverUrl.replace(/\/$/, '')}/?${new URLSearchParams({ wabiNav: 'lore_file', channelId: channelKey, path: selectedPath! })}`).catch(() => { error = $_('lore_project.copy_file_link_failed'); })}>{$_('lore_project.copy_file_link')}</button><button onclick={() => void navigator.clipboard.writeText(selectedPath!).catch(() => { error = $_('lore_project.copy_path_failed'); })}>{$_('lore_project.copy_path')}</button>{#if canWrite}<button onclick={() => void run($_('lore_project.busy_updating_lock'), auth => selectedFile?.lockedBy ? unlockLoreFile(auth, channelId, selectedPath!) : lockLoreFile(auth, channelId, selectedPath!))}>{selectedFile?.lockedBy ? $_('lore_project.unlock_file') : $_('lore_project.lock_file')}</button><button class="lw-danger-text" onclick={() => confirmAction('file', selectedPath!)}>{$_('lore_project.delete_file_action')}</button>{/if}</div></details>{/snippet}
							{#if stalePreview}<p class="lw-notice">{$_('lore_project.newer_version')} <button class="lw-text-button" onclick={() => void openFile(selectedPath!)}>{$_('lore_project.reload_preview')}</button></p>{/if}
							{#if fileError}<p class="lw-alert" role="alert">{fileError}<button class="lw-button" onclick={() => void openFile(selectedPath!)}>{$_('lore_project.retry_preview')}</button></p>{/if}
							{#if selectedMedia && ['audio', 'video'].includes(previewKind(selectedPath))}<div class="lw-media">{@render fileActions()}<h2>{selectedPath.split('/').pop()}</h2>{#if previewKind(selectedPath) === 'audio'}<audio controls src={selectedMedia}></audio>{:else}<video controls src={selectedMedia}><track kind="captions" /></video>{/if}<button class="lw-button" onclick={() => void download(selectedPath!)}>{$_('lore_project.download_file')}</button></div>
							{:else}{#key previewKey}<LoreFileViewer highlightLines={linkedLines} onLinkLines={copyLineLink} filePath={selectedPath} fileContent={selectedContent} fileInfo={selectedFile} loading={fileLoading} mediaUrl={selectedMedia} canEdit={canWrite} token={getAuthToken(serverUrl) ?? undefined} {channelId} onClose={closeFile} onSaved={() => void reload()} onDirtyChange={(value) => fileDirty = value} actions={fileActions} />{/key}{/if}
						{:else}<div class="lw-setup"><LoreIcon name="file" size={36} /><h2>{$_('lore_project.choose_file')}</h2><p>{$_('lore_project.choose_file_body')}</p></div>{/if}
					</div>
				</div>
			</section>
			{#if localOpened}<section class="lw-panel lw-local" hidden={tab !== 'changes'} aria-label={$_('lore_project.local_changes')}>{#if accountId}<LoreLocalChanges channelId={channelKey} {projectName} {serverUrl} {accountId} onCounts={(value) => counts = value} />{:else}<p class="lw-empty-inline">{$_('lore_project.sign_in_local')}</p>{/if}</section>{/if}
			{#if historyOpened}<section class="lw-panel" hidden={tab !== 'history'} aria-label={$_('lore_project.repository_history')}><LorePushCalendar {revisions} /><LoreHistoryBrowser {revisions} {files} {channelId} getToken={token} isActive={active} initialPath={historyPath} /></section>{/if}
			<section class="lw-panel lw-scroll" hidden={tab !== 'review'} aria-label={$_('lore_project.review_queue')}><div class="lw-page"><p class="lw-eyebrow">{$_('lore_project.team_workflow')}</p><h2>{$_('lore_project.tab_review')}</h2><p class="lw-lead">{$_('lore_project.review_intro')}</p>{#each reviewQueue as branch (branch.name)}<article class="lw-review-card"><div><span class="lw-badge">{$_('lore_project.awaiting_review')}</span><h3>{branch.name.replace(/^uploads\//, '')}</h3><code>{branch.name}</code></div>{#if canEdit}<div class="lw-actions"><button class="lw-button" disabled={!!busy} onclick={() => { if (window.confirm($_('lore_project.confirm_reject', { values: { name: branch.name } }))) void run($_('lore_project.busy_rejecting'), auth => reviewLoreBranch(auth, channelId, branch.name, 'reject')); }}>{$_('lore_project.reject')}</button><button class="lw-button lw-primary" disabled={!!busy} onclick={() => { if (window.confirm($_('lore_project.confirm_approve', { values: { name: branch.name } }))) void run($_('lore_project.busy_approving'), auth => reviewLoreBranch(auth, channelId, branch.name, 'approve')); }}>{$_('lore_project.approve')}</button></div>{/if}</article>{:else}<div class="lw-empty-card"><LoreIcon name="review" size={28} /><h3>{$_('lore_project.no_uploads')}</h3><p>{repo.auto_branch_on_upload ? $_('lore_project.review_new_uploads') : $_('lore_project.review_optional')}</p></div>{/each}</div></section>
			<section class="lw-panel lw-scroll" hidden={tab !== 'settings'} aria-label={$_('lore_project.project_settings')}><div class="lw-page"><p class="lw-eyebrow">{$_('lore_project.project_configuration')}</p><h2>{$_('settings.title')}</h2><nav class="lw-settings-nav" aria-label={$_('lore_project.settings_sections')}><button class="lw-button" aria-pressed={settingsSection === 'general'} onclick={() => settingsPane('general')}>{$_('lore_project.general_workflow')}</button>{#if canManage}<button class="lw-button" aria-pressed={settingsSection === 'permissions'} onclick={() => settingsPane('permissions')}>{$_('lore_project.permissions')}</button>{/if}</nav>
				{#if settingsSection === 'permissions'}<LoreRolesAdmin onClose={() => settingsPane('general')} onDirtyChange={(value) => permissionDirty = value} />{:else}
					<section class="lw-settings-card"><h3>{$_('lore_project.repository_heading')}</h3><dl><dt>{$_('messages.viewer.details_name')}</dt><dd>{repo.repoName}</dd><dt>{$_('lore_project.channel_label')}</dt><dd>{projectName}</dd><dt>{$_('settings.tabs.storage')}</dt><dd>{readOnly ? $_('lore_project.read_only_external') : $_('lore_project.versioned_repo')}</dd>{#if repo.imported_from}<dt>{$_('lore_project.imported_from')}</dt><dd>{repo.imported_from}</dd>{/if}</dl><p class="lw-help">{$_('lore_project.repo_settings_note')}</p></section>
					<section class="lw-settings-card"><h3>{$_('lore_project.review_policy')}</h3><label class="lw-setting-toggle"><input type="checkbox" checked={reviewDraft ?? !!repo.auto_branch_on_upload} disabled={!canManage || readOnly || !!busy} onchange={(event) => reviewDraft = event.currentTarget.checked} /><span><strong>{$_('lore_project.require_review')}</strong><small>{$_('lore_project.review_policy_help')}</small></span></label><div class="lw-form-footer"><span>{reviewDirty ? $_('lore_project.unsaved_policy') : $_('lore_project.current_policy')}</span><button class="lw-button" disabled={!reviewDirty || !!busy} onclick={() => reviewDraft = null}>{$_('common.cancel')}</button><button class="lw-button lw-primary" disabled={!canManage || !reviewDirty || !!busy} onclick={() => void run($_('lore_project.busy_saving_policy'), async auth => { await updateLoreRepoSettings(auth, channelId, { auto_branch_on_upload: !!reviewDraft }); if (active()) reviewDraft = null; })}>{$_('lore_project.save_policy')}</button></div></section>
					<section class="lw-settings-card"><h3>{$_('lore_project.on_this_computer')}</h3><p>{$_('lore_project.on_computer_body')}</p><button class="lw-button" onclick={() => navigate('changes')}>{$_('lore_project.manage_local_folder')}</button></section>
					{#if canManage}<section class="lw-settings-card lw-danger-zone"><h3>{$_('lore_project.danger_zone')}</h3><p>{$_('lore_project.danger_body')}</p><div class="lw-actions"><button class="lw-button" disabled={!!busy} onclick={() => confirmAction('detach', repo!.repoName)}>{$_('lore_project.detach_repo')}</button><button class="lw-button lw-danger-text" disabled={!!busy} onclick={() => confirmAction('delete', repo!.repoName)}>{$_('lore_project.delete_repo')}</button></div></section>{/if}
				{/if}
			</div></section>
			{#if tab === 'timeline'}<section class="lw-panel lw-scroll"><div class="lw-page"><h2>{$_('lore_project.activity_timeline')}</h2><LoreActivityFeed {activity} /></div></section>{/if}
		{/if}
	</div>
	<input class="lw-hidden-input" tabindex="-1" type="file" multiple bind:this={uploadInput} onchange={(event) => queueFiles(event, false)} aria-label={$_('lore_project.choose_files_aria')} />
	<input class="lw-hidden-input" tabindex="-1" type="file" multiple webkitdirectory bind:this={folderInput} onchange={(event) => queueFiles(event, true)} aria-label={$_('lore_project.choose_folder_aria')} />
	{#if queue.length}<LoreDialog title={$_('lore_project.upload_dialog_title')} busy={!!busy} onClose={() => queue = []}><p>{$_('lore_project.upload_note', { values: { target: repo?.auto_branch_on_upload ? $_('lore_project.target_review') : $_('lore_project.target_server') } })}</p><label class="lw-field">{$_('lore_project.destination_folder')}<input bind:value={destination} disabled={!!busy} placeholder="uploads" /></label><label class="lw-field">{$_('lore_project.change_summary')}<input bind:value={uploadSummary} disabled={!!busy} maxlength="2000" /></label><div class="lw-upload-list">{#each queue as file}<p><code>{file.webkitRelativePath || file.name}</code><span>{formatBytes(file.size)}</span></p>{/each}</div>{#if error}<p class="lw-alert" role="alert">{error}</p>{/if}<p class="lw-help">{$_('lore_project.existing_paths')}</p><div class="lw-form-footer">{#if busy}<span role="status">{$_('lore_project.uploading_progress', { values: { progress: uploadProgress } })}</span><button class="lw-button" onclick={() => cancelUpload = true}>{$_('lore_project.stop_after_file')}</button>{:else}<button class="lw-button" onclick={() => queue = []}>{$_('common.cancel')}</button><button class="lw-button lw-primary" disabled={!uploadSummary.trim()} onclick={() => void uploadSelection()}>{$_('chat.upload.upload_files_many', { values: { count: queue.length } })}</button>{/if}</div></LoreDialog>{/if}
	{#if createOpen}<LoreDialog title={$_('lore_project.new_text_file_title')} busy={!!busy} onClose={() => createOpen = false}><label class="lw-field">{$_('lore_project.start_from')}<select disabled={!!busy} onchange={(event) => { const starter = starters[Number(event.currentTarget.value)]; if (starter) { newPath = starter.path; newText = starter.text; } }}><option value="">{$_('lore_project.custom_text_file')}</option>{#each starters as starter, index}<option value={index}>{starterLabel(starter.name)}</option>{/each}</select></label><label class="lw-field">{$_('lore_project.repository_path')}<input bind:value={newPath} disabled={!!busy} /></label><label class="lw-field">{$_('lore_project.starter_content')}<textarea bind:value={newText} rows="8" disabled={!!busy}></textarea></label>{#if error}<p class="lw-alert" role="alert">{error}</p>{/if}<div class="lw-form-footer"><button class="lw-button" onclick={() => createOpen = false} disabled={!!busy}>{$_('common.cancel')}</button><button class="lw-button lw-primary" disabled={!!busy || !newPath.trim()} onclick={() => void run($_('lore_project.busy_creating_file'), async auth => { const path = uploadPath(newPath.trim(), '', ''); await uploadLoreFile(auth, channelId, path, newText, `Create ${path}`, null); if (active()) createOpen = false; })}>{$_('lore_project.create_revision')}</button></div></LoreDialog>{/if}
	{#if branchOpen}<LoreDialog title={$_('lore_project.create_branch_title')} busy={!!busy} onClose={() => branchOpen = false}><p>{$_('lore_project.branch_help')}</p><label class="lw-field">{$_('lore_project.branch_name')}<input bind:value={newBranch} disabled={!!busy} /></label><label class="lw-field">{$_('lore_project.from_branch')}<select bind:value={branchFrom} disabled={!!busy}>{#each branches as branch (branch.name)}<option value={branch.name}>{branch.name}</option>{/each}</select></label>{#if error}<p class="lw-alert" role="alert">{error}</p>{/if}<div class="lw-form-footer"><button class="lw-button lw-primary" disabled={!!busy || !newBranch.trim() || !branchFrom} onclick={() => void run($_('lore_project.busy_creating_branch'), async auth => { await createLoreBranch(auth, channelId, newBranch.trim(), branchFrom); if (active()) branchOpen = false; })}>{$_('lore_project.create_branch')}</button></div></LoreDialog>{/if}
	{#if confirmation}<LoreDialog title={confirmation.kind === 'file' ? $_('lore_project.delete_file_title') : confirmation.kind === 'detach' ? $_('lore_project.detach_title') : $_('lore_project.delete_repo_title')} busy={!!busy} onClose={() => confirmation = null}><p>{confirmation.kind === 'file' ? $_('lore_project.delete_file_body') : confirmation.kind === 'detach' ? $_('lore_project.detach_body') : $_('lore_project.delete_repo_body')}</p><p><strong>{confirmation.path}</strong></p><label class="lw-field">{$_('lore_project.type_to_confirm', { values: { name: confirmation.expected } })}<input bind:value={confirmationText} disabled={!!busy} autocomplete="off" /></label>{#if error}<p class="lw-alert" role="alert">{error}</p>{/if}<div class="lw-form-footer"><button class="lw-button" disabled={!!busy} onclick={() => confirmation = null}>{$_('common.cancel')}</button><button class="lw-button lw-danger-text" disabled={!!busy || confirmationText !== confirmation.expected} onclick={() => void executeConfirmation()}>{confirmation.kind === 'detach' ? $_('lore_project.detach_confirm') : $_('lore_project.delete_confirm')}</button></div></LoreDialog>{/if}
	{#if contextTarget}<LoreDialog title={$_('lore_project.file_actions')} busy={!!busy} onClose={() => contextTarget = null}><code>{contextTarget.path}</code><div class="lw-context-actions">{#if contextTarget.folder && canWrite}<button class="lw-button" onclick={() => { destination = contextTarget!.path; contextTarget = null; uploadInput.click(); }}>{$_('lore_project.upload_here')}</button>{/if}{#if !contextTarget.folder}<button class="lw-button" onclick={() => comparePath(contextTarget!.path)}>{$_('lore_project.history_compare')}</button><button class="lw-button" onclick={() => void download(contextTarget!.path)}>{$_('lore_project.download_file')}</button>{#if canWrite}<button class="lw-button" disabled={!!busy} onclick={() => void run($_('lore_project.busy_updating_lock'), auth => files.find(file => file.path === contextTarget!.path)?.lockedBy ? unlockLoreFile(auth, channelId, contextTarget!.path) : lockLoreFile(auth, channelId, contextTarget!.path))}>{files.find(file => file.path === contextTarget!.path)?.lockedBy ? $_('lore_project.unlock_file') : $_('lore_project.lock_file')}</button><button class="lw-button lw-danger-text" onclick={() => confirmAction('file', contextTarget!.path)}>{$_('lore_project.delete_file_action')}</button>{/if}{/if}</div></LoreDialog>{/if}
	{#if showConnect}<LoreConnectModal channelId={channelKey} onConnected={() => { showConnect = false; void reload(); void refreshHealth(); }} onClose={() => showConnect = false} />{/if}
	{#if showTokens}<LoreConnectPanel {channelKey} repoId={channelId} repoName={repo?.repoName ?? null} onclose={() => showTokens = false} />{/if}
</section>
