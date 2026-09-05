<script lang="ts">
	import { currentChannel, currentUser } from '$lib/socket';
import { channels } from '$lib/channelStore';
	import {
		loreRepo,
		loreFiles,
		loreRevisions,
		loreBranches,
		loreFileDiff,
		loreLoading,
		loreHealth,
		loreError,
		loreLiveChange,
		loadLoreRepo,
		loadLoreHistory,
		loadLoreHealth,
		loadLoreFileDiff,
		subscribeLoreLive,
		setLoreChannelContext,
	} from '$lib/loreStore';
	import { findReadmePath } from '$lib/lore/readmeDefault';
	import {
		getSignedLoreUrl,
		parseLoreChannelId,
		uploadLoreFile,
		createLoreRepo,
		deleteLoreRepo,
		getLoreRepo,
		getLoreBranches,
		getLoreFileHistory,
		listLoreFiles,
		mintLoreConnectToken,
		createLoreSnapshot,
		createLoreBranch,
		lockLoreFile,
		unlockLoreFile,
		deleteLoreFile,
		downloadLoreProject,
		reviewLoreBranch,
		type LoreFileInfo,
		type LoreRevision,
		type LoreBranch,
	} from '$lib/api/lore';
	import { getAuthToken } from '$lib/authSession';
	import { showToast } from '$lib/toast';

	// VCS components
	import LoreFileTree from './LoreFileTree.svelte';
	import LoreFileViewer from './LoreFileViewer.svelte';
	import LoreHistoryPanel from './LoreHistoryPanel.svelte';
	import LoreDiffViewer from './LoreDiffViewer.svelte';
	import LoreBranchPicker from './LoreBranchPicker.svelte';
	import LoreLockBadge from './LoreLockBadge.svelte';
	import LoreConnectModal from './LoreConnectModal.svelte';
	import LoreEditorBridge from './LoreEditorBridge.svelte';
	import LoreScriptRunner from './LoreScriptRunner.svelte';
	import LoreMirrorPanel from './LoreMirrorPanel.svelte';

	// Timeline
	import LoreActivityFeed from './LoreActivityFeed.svelte';
	import LorePushCalendar from './LorePushCalendar.svelte';

	// Templates
	import LoreTemplatePicker from './LoreTemplatePicker.svelte';


	type Tab = 'files' | 'history' | 'diff' | 'review' | 'timeline' | 'automation';

	interface Props {
		/**
		 * Explicit channel binding for hub mounts. The Code hub resolves the
		 * repo it shows independently of the currently active channel — without
		 * this prop every action handler targeted the raw current channel (the
		 * "ghost channel" bug: uploads silently no-opped while a non-lore
		 * channel was active). In-channel mounts omit it and fall back to
		 * $currentChannel.
		 */
		channelKey?: string;
	}

	let { channelKey }: Props = $props();

	let activeChannel = $derived(channelKey ?? $currentChannel);

	/**
	 * Auth + channel context for repo actions. Returns null — loudly — when
	 * either is missing. The silent version of this guard made the upload
	 * buttons no-op with zero feedback whenever the shell was mounted without
	 * its lore channel active.
	 */
	function requireActionContext(): { token: string; channelId: number } | null {
		const token = getAuthToken();
		const channelId = parseLoreChannelId(activeChannel);
		if (token && channelId) return { token, channelId };
		const reason = !token
			? 'not signed in'
			: `this view isn't bound to a Lore channel (active: ${activeChannel ?? 'none'})`;
		console.error(`[lore] action skipped: ${reason}`);
		showToast(`Can't do that — ${reason}. Try reopening the Code view.`, 'error');
		return null;
	}

	// Channel-scoped store loads (tree, history, diff) must target the same
	// channel the shell is bound to — not whatever channel is globally active.
	$effect(() => {
		setLoreChannelContext(activeChannel);
		return () => setLoreChannelContext(null);
	});

	let repo = $derived($loreRepo);
	let files = $derived($loreFiles);
	let revisions = $derived($loreRevisions);
	let branches = $derived($loreBranches);
	let fileDiff = $derived($loreFileDiff);
	let isLoading = $derived($loreLoading);
	let health = $derived($loreHealth);
	let error = $derived($loreError);
	let user = $derived($currentUser);

	let loreRole = $derived((user?.highestRole || '').toLowerCase());
	let canEdit = $derived(['owner', 'admin', 'developer'].includes(loreRole));
	let canAssetWrite = $derived(canEdit || loreRole === 'artist');

	let activeTab = $state<Tab>('files');
	let selectedPath = $state<string | null>(null);
	let fileContent = $state<string | null>(null);
	let selectedFileInfo = $state<LoreFileInfo | null>(null);
	let diffMode = $state<'unified' | 'side-by-side'>('unified');
	let currentBranch = $state('main');

	// Template picker
	let showTemplates = $state(false);

	// Editor bridge (P4): ephemeral code-server session for this repo
	let showEditor = $state(false);

	// Signed preview URL for the selected image file
	let mediaPreviewUrl = $state<string | null>(null);

	const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif'];
	function isImagePath(path: string): boolean {
		const ext = path.split('.').pop()?.toLowerCase() ?? '';
		return IMAGE_EXTS.includes(ext);
	}

	// Danger-zone modal state (repo detach / delete)
	let dangerAction = $state<'detach' | 'delete' | null>(null);
	let dangerConfirmText = $state('');
	let dangerBusy = $state(false);
	let dangerError = $state<string | null>(null);

	function openDanger(action: 'detach' | 'delete') {
		dangerAction = action;
		dangerConfirmText = '';
		dangerError = null;
	}

	async function executeDanger() {
		const ctx = requireActionContext();
		if (!ctx || !dangerAction) return;
		const { token, channelId } = ctx;
		if (dangerAction === 'delete' && dangerConfirmText !== repo?.repoName) return;
		dangerBusy = true;
		dangerError = null;
		try {
			await deleteLoreRepo(token, channelId, dangerAction);
			dangerAction = null;
			selectedPath = null;
			fileContent = null;
			mediaPreviewUrl = null;
			activeTab = 'files';
			await loadLoreRepo();
			await loadLoreHistory();
		} catch (e: any) {
			dangerError = e?.message ?? 'Failed to update repository';
		} finally {
			dangerBusy = false;
		}
	}

	// File deletion with typed confirmation (replaces bare confirm())
	let deleteTarget = $state<{ path: string; size: number } | null>(null);
	let deleteConfirmText = $state('');
	let deleteBusy = $state(false);
	let deleteError = $state<string | null>(null);

	function requestDelete(path: string) {
		deleteTarget = { path, size: files.find((f) => f.path === path)?.size ?? 0 };
		deleteConfirmText = '';
		deleteError = null;
	}

	async function executeDelete() {
		const ctx = requireActionContext();
		if (!ctx || !deleteTarget) return;
		const { token, channelId } = ctx;
		const fileName = deleteTarget.path.split('/').pop() ?? deleteTarget.path;
		if (deleteConfirmText !== fileName) return;
		deleteBusy = true;
		deleteError = null;
		try {
			const targetPath = deleteTarget.path;
			await deleteLoreFile(token, channelId, targetPath, `Delete ${targetPath}`);
			deleteTarget = null;
			if (selectedPath === targetPath) {
				selectedPath = null;
				fileContent = null;
				mediaPreviewUrl = null;
			}
			await loadLoreRepo();
			await loadLoreHistory();
		} catch (e: any) {
			deleteError = e?.message ?? 'Delete failed';
		} finally {
			deleteBusy = false;
		}
	}

	// Activity / audit (derived from revisions for now)
	let activityItems = $derived(revisions.map(r => ({
		type: 'commit' as const,
		author_id: String(r.authorId),
		message: r.message,
		timestamp: r.timestamp,
		metadata: { hash: r.hash },
	})));

	let pushCalendarData = $derived(revisions.map(r => ({
		date: new Date(r.timestamp).toISOString().split('T')[0],
		count: 1,
	})).reduce((acc: Array<{ date: string; count: number }>, r) => {
		const existing = acc.find(a => a.date === r.date);
		if (existing) {
			existing.count++;
		} else {
			acc.push({ date: r.date, count: 1 });
		}
		return acc;
	}, [] as Array<{ date: string; count: number }>));

	// W6e: live refresh on server-pushed `lore:file-changed` (web edits,
	// uploads, and wabi-sync pushes from other machines). Debounced so a
	// burst of changes triggers one reload.
	let liveRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		const unsubSocket = subscribeLoreLive();
		const unsubStore = loreLiveChange.subscribe(() => {
			clearTimeout(liveRefreshTimer);
			liveRefreshTimer = setTimeout(() => {
				void loadLoreRepo();
				void loadLoreHistory();
			}, 400);
		});
		return () => {
			unsubSocket();
			unsubStore();
			clearTimeout(liveRefreshTimer);
		};
	});

	let showConnectModal = $state(false);

	// W7: one-click auto-create for channels that pre-date the addon (no repo yet).
	// Replaces the scary lore:// modal — an artist just clicks "Set up folder".
	let autoCreating = $state(false);
	let autoCreateError = $state<string | null>(null);
	let autoCreated = $state(false);

	// Setup chooser: the empty state offers server space / local folder /
	// advanced instead of silently picking one path.
	let setupMode = $state<'idle' | 'choosing' | 'local'>('idle');

	// Local-folder connect (wabi-sync): server-minted token + copy-paste commands.
	let connectToken = $state('');
	let connectTokenScopes = $state<'read' | 'write'>('write');
	let mintingToken = $state(false);
	let mintTokenError = $state<string | null>(null);
	let copiedField = $state('');

	async function mintConnectToken() {
		const token = getAuthToken();
		const channelId = parseLoreChannelId(activeChannel);
		if (!token || !channelId) {
			mintTokenError = 'Sign in first.';
			return;
		}
		mintingToken = true;
		mintTokenError = null;
		try {
			const result = await mintLoreConnectToken(token, channelId, connectTokenScopes);
			connectToken = result.token;
		} catch (e: any) {
			mintTokenError = e?.message ?? 'Failed to mint token';
		} finally {
			mintingToken = false;
		}
	}

	async function copySetupText(text: string, field: string) {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			const ta = document.createElement('textarea');
			ta.value = text;
			ta.style.position = 'fixed';
			ta.style.opacity = '0';
			document.body.appendChild(ta);
			ta.select();
			document.execCommand('copy');
			ta.remove();
		}
		copiedField = field;
		setTimeout(() => {
			if (copiedField === field) copiedField = '';
		}, 1500);
	}

	let serverBaseUrl = $derived(
		typeof window !== 'undefined' ? window.location.origin : ''
	);

	let syncCommands = $derived.by(() => {
		const id = parseLoreChannelId(activeChannel);
		const chKey = id != null ? `ch_${id.toString(16)}` : 'ch_…';
		return [
			{ label: '1. Log in', cmd: `wabi-sync login ${serverBaseUrl}` },
			{ label: '2. Link your folder', cmd: `wabi-sync link ${chKey} ~/projects/${channelName}` },
			{ label: '3. Keep it syncing', cmd: `wabi-sync watch` }
		];
	});

	let channelName = $derived(
		$channels.find((c) => c.id === activeChannel)?.name ?? 'code-repo'
	);

	async function handleAutoCreateRepo() {
		const ctx = requireActionContext();
		if (!ctx) return;
		const { token, channelId } = ctx;
		autoCreating = true;
		autoCreateError = null;
		try {
			await createLoreRepo(token, channelId, channelName);
			autoCreated = true;
			await loadLoreRepo();
			await loadLoreHistory();
		} catch (e: any) {
			autoCreateError = e?.message ?? 'Failed to set up folder';
		} finally {
			autoCreating = false;
		}
	}

	// Built-in templates (matching LoreTemplatePicker interface)
	let templates = $state([
		{ id: 'rust-module', name: 'Rust Module', file_path: 'src/module.rs', language: 'rust', category: 'code' },
		{ id: 'ts-module', name: 'TypeScript Module', file_path: 'src/module.ts', language: 'typescript', category: 'code' },
		{ id: 'python-script', name: 'Python Script', file_path: 'scripts/script.py', language: 'python', category: 'code' },
		{ id: 'readme', name: 'README', file_path: 'README.md', language: 'markdown', category: 'docs' },
		{ id: 'cargo-toml', name: 'Cargo.toml', file_path: 'Cargo.toml', language: 'toml', category: 'config' },
		{ id: 'package-json', name: 'package.json', file_path: 'package.json', language: 'json', category: 'config' },
	]);

	async function handleOpen(path: string) {
		selectedPath = path;
		selectedFileInfo = files.find(f => f.path === path) || null;
		fileContent = null;
		mediaPreviewUrl = null;
		activeTab = 'files';

		const ctx = requireActionContext();
		if (!ctx) return;
		const { token, channelId } = ctx;

		try {
			mediaPreviewUrl = isImagePath(path) ? await getSignedLoreUrl(token, channelId, path) : null;
			if (!mediaPreviewUrl) {
				const url = await getSignedLoreUrl(token, channelId, path);
				const res = await fetch(url);
				if (res.ok) {
					fileContent = await res.text();
				}
			}
		} catch {
			fileContent = null;
			mediaPreviewUrl = null;
		}
	}

	// README auto-open (docs/plans convention): when a repo loads and nothing
	// is selected, a root README becomes the selection — like clicking it
	// yourself. It never fights the user: once per repo identity, so closing
	// the viewer or picking another file keeps the README out of the way.
	let readmeAutoOpenedFor = $state<string | null>(null);
	$effect(() => {
		if (!files.length || selectedPath) return;
		const identity = `${activeChannel ?? 'none'}:${repo?.repoName ?? 'none'}`;
		if (readmeAutoOpenedFor === identity) return;
		readmeAutoOpenedFor = identity;
		const readme = findReadmePath(files);
		if (readme) void handleOpen(readme);
	});

	let contextMenu = $state<{ path: string; x: number; y: number; isFolder?: boolean } | null>(null);
	/** Folder chosen via its context menu; the next single upload lands there. */
	let uploadTargetFolder = $state<string | null>(null);
	let fileInputEl = $state<HTMLInputElement | undefined>(undefined);

	function handleContextMenu(path: string, event: MouseEvent, isFolder = false) {
		event.preventDefault();
		contextMenu = { path, x: event.clientX, y: event.clientY, isFolder };
	}

	function contextMenuUploadHere() {
		if (!contextMenu) return;
		uploadTargetFolder = contextMenu.isFolder ? contextMenu.path : null;
		closeContextMenu();
		fileInputEl?.click();
	}

	function closeContextMenu() {
		contextMenu = null;
	}

	function contextMenuLock() {
		if (contextMenu) void handleLock(contextMenu.path);
		closeContextMenu();
	}

	function contextMenuUnlock() {
		if (contextMenu) void handleUnlock(contextMenu.path);
		closeContextMenu();
	}

	function contextMenuDelete() {
		const path = contextMenu?.path;
		closeContextMenu();
		if (path && canAssetWrite) requestDelete(path);
	}

	function contextMenuDownload() {
		const path = contextMenu?.path;
		closeContextMenu();
		if (path) void downloadToDisk(path);
	}

	function contextMenuCopyPath() {
		const path = contextMenu?.path;
		closeContextMenu();
		if (path) void navigator.clipboard.writeText(path);
	}

	/** Download any repo file to disk via a signed URL. */
	async function downloadToDisk(path: string) {
		const ctx = requireActionContext();
		if (!ctx) return;
		const { token, channelId } = ctx;
		try {
			const url = await getSignedLoreUrl(token, channelId, path);
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const blob = await res.blob();
			const objectUrl = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = objectUrl;
			a.download = path.split('/').pop() || 'file';
			a.click();
			URL.revokeObjectURL(objectUrl);
		} catch (e) {
			console.error('Download failed:', e);
		}
	}

	let projectDownloading = $state(false);

	/** "Download project": the whole visible working tree as a server-built zip. */
	async function handleDownloadProject() {
		const ctx = requireActionContext();
		if (!ctx || projectDownloading) return;
		const { token, channelId } = ctx;
		projectDownloading = true;
		try {
			await downloadLoreProject(token, channelId);
		} catch (e: any) {
			console.error('[lore] project download failed:', e);
			showToast(e?.message || 'Project download failed', 'error');
		} finally {
			projectDownloading = false;
		}
	}

	/**
	 * Diff the selected file against its previous Wabi-recorded revision.
	 * The old entry point diffed HEAD vs a phantom 'working' rev that never
	 * existed — uploads auto-commit, so that diff was always empty.
	 */
	async function compareWithPrevious(path: string) {
		selectedPath = path;
		selectedFileInfo = files.find(f => f.path === path) || null;
		fileContent = null;
		mediaPreviewUrl = null;
		const ctx = requireActionContext();
		if (!ctx) return;
		const { token, channelId } = ctx;
		try {
			const history = await getLoreFileHistory(token, channelId, path);
			if (history.length >= 2) {
				await loadLoreFileDiff(path, history[1].hash, history[0].hash);
			} else if (history.length === 1) {
				await loadLoreFileDiff(path, history[0].hash, history[0].hash);
			} else {
				loreFileDiff.set(null);
				activeTab = 'diff';
			}
		} catch (e) {
			console.error('Compare failed:', e);
		}
	}

	function contextMenuDiffPrevious() {
		const path = contextMenu?.path;
		closeContextMenu();
		if (path) void compareWithPrevious(path);
	}

	function contextMenuEditor() {
		const path = contextMenu?.path;
		closeContextMenu();
		if (path && canEdit) {
			void handleOpen(path);
			showEditor = true;
		}
	}

	async function handleCreateBranch(name: string, from: string) {
		const ctx = requireActionContext();
		if (!ctx) return;
		const { token, channelId } = ctx;
		try {
			await createLoreBranch(token, channelId, name, from);
			await loadLoreHistory();
		} catch (e) {
			console.error('Failed to create branch:', e);
		}
	}

/** Branch listing works; switching does not change what list_files serves
	 * yet, so the UI must not pretend otherwise. */
	const BRANCH_SWITCH_ENABLED = false;

	function handleSwitchBranch(name: string) {
		if (!BRANCH_SWITCH_ENABLED) return;
		currentBranch = name;
		void loadLoreRepo();
	}

	// Uploads routed into a review queue (auto_branch_on_upload) surface as
	// uploads/* lines. Approving merges them into the official space.
	let reviewBusy = $state<string | null>(null);
	let reviewUnavailable = $state(false);

	let pendingReviews = $derived(
		branches.filter(b => b.name.startsWith('uploads/')).map(b => ({
			name: b.name,
			label: b.name.replace(/^uploads\//, ''),
		}))
	);

	let showPendingReview = $derived(
		repo?.auto_branch_on_upload === true && pendingReviews.length > 0 && !reviewUnavailable
	);

	async function handleReview(branchName: string, decision: 'approve' | 'reject') {
		const ctx = requireActionContext();
		if (!ctx || reviewBusy) return;
		const { token, channelId } = ctx;

		reviewBusy = branchName;
		try {
			await reviewLoreBranch(token, channelId, branchName, decision);
			await loadLoreRepo();
			await loadLoreHistory();
		} catch (e: any) {
			if (e?.status === 404) {
				// Review endpoint not deployed on this server yet — hide the queue.
				reviewUnavailable = true;
			} else {
				console.error('Review action failed:', e);
			}
		} finally {
			reviewBusy = null;
		}
	}

	async function handleCompare(from: string, to: string) {
		activeTab = 'diff';
		if (selectedPath) {
			await loadLoreFileDiff(selectedPath, from, to);
		}
	}

	async function handleUpload(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input?.files?.[0];
		if (!file) return;

		const ctx = requireActionContext();
		if (!ctx) return;
		const { token, channelId } = ctx;

		try {
			// Land in the folder chosen via its context menu (if any);
			// default remains the flat uploads/ drop zone.
			const repoPath = uploadTargetFolder
				? `${uploadTargetFolder}/${file.name}`
				: `uploads/${file.name}`;
			uploadTargetFolder = null;
			await uploadLoreFile(token, channelId, repoPath, file, `Upload ${file.name}`);
			await loadLoreRepo();
		} catch (e: any) {
			console.error('Upload failed:', e);
			uploadFailures = [`${file.name}: ${e?.message ?? 'failed'}`];
			setTimeout(() => { uploadFailures = []; }, 8000);
		}

		input.value = '';
	}

	let uploadingFolder = $state(false);
	let uploadProgress = $state('');
	let uploadFailures = $state<string[]>([]);
	let cancelRequested = $state(false);

	/**
	 * Folder upload: a directory picker (webkitdirectory) hands us every
	 * file under the chosen root with its webkitRelativePath. Each file is
	 * pushed to `uploads/<relative path>` preserving the tree, then the
	 * repo view reloads once. Failures are collected and reported at the
	 * end instead of aborting the whole batch.
	 */
	async function handleFolderUpload(event: Event) {
		const input = event.target as HTMLInputElement;
		const files = Array.from(input?.files ?? []);
		if (files.length === 0) return;

		const ctx = requireActionContext();
		if (!ctx) return;
		const { token, channelId } = ctx;

		uploadingFolder = true;
		cancelRequested = false;
		const failed: string[] = [];
		try {
			for (let i = 0; i < files.length; i++) {
				if (cancelRequested) break;
				const file = files[i] as File & { webkitRelativePath?: string };
				// Strip the chosen root directory name — its CONTENTS land in
				// uploads/, mirroring how git tracks from inside the repo.
				const rel = (file.webkitRelativePath || file.name).split('/').slice(1).join('/') || file.name;
				uploadProgress = `${i + 1}/${files.length}`;
				try {
					await uploadLoreFile(token, channelId, `uploads/${rel}`, file, `Upload ${rel}`);
				} catch {
					failed.push(rel);
				}
			}
			await loadLoreRepo();
		} finally {
			uploadingFolder = false;
			uploadProgress = '';
			input.value = '';
			if (cancelRequested && failed.length > 0) {
				failed.unshift('(cancelled)');
			}
			const snapshotFailed = [...failed];
			uploadFailures = snapshotFailed;
			if (snapshotFailed.length > 0) {
				setTimeout(() => { if (uploadFailures === snapshotFailed) uploadFailures = []; }, 8000);
			}
		}
	}

	function cancelFolderUpload() {
		cancelRequested = true;
	}

	async function handleTemplateSelect(template: any) {
		showTemplates = false;
		selectedPath = template.file_path;
		fileContent = null;
		// Create the file in the repo from the template's starter content
		// (templates are the built-in list above; content is a small boilerplate
		// per language). Uses the same upload path as file uploads so the file
		// lands in the repo and the tree refreshes.
		const ctx = requireActionContext();
		if (!ctx) return;
		const { token, channelId } = ctx;
		try {
			const content = templateContent(template);
			const blob = new Blob([content], { type: 'text/plain' });
			const file = new File([blob], template.file_path.split('/').pop() || 'template.txt');
			await uploadLoreFile(token, channelId, template.file_path, file, `Create ${template.file_path} from template`);
			await loadLoreRepo();
			// Refresh the file view with the created content.
			selectedFileInfo = $loreFiles.find(f => f.path === template.file_path) || null;
			fileContent = content;
			mediaPreviewUrl = null;
		} catch (e) {
			console.error('Template create failed:', e);
		}
	}

	function templateContent(template: any): string {
		const name = template.file_path.split('/').pop() || 'file';
		switch (template.language) {
			case 'rust':
				return `// ${name}\n\npub fn main() {\n    println!("Hello, Wabi!");\n}\n`;
			case 'typescript':
				return `// ${name}\nexport function hello(): string {\n  return 'Hello, Wabi!';\n}\n`;
			case 'python':
				return `# ${name}\ndef main():\n    print("Hello, Wabi!")\n\nif __name__ == "__main__":\n    main()\n`;
			case 'markdown':
				return `# ${name}\n\nWrite something here.\n`;
			case 'toml':
				return `# ${name}\n[package]\nname = "example"\nversion = "0.1.0"\n`;
			case 'json':
				return `{\n  "name": "${name}",\n  "version": "0.1.0"\n}\n`;
			default:
				return `// ${name}\n`;
		}
	}

	async function handleLock(path: string) {
		const ctx = requireActionContext();
		if (!ctx) return;
		const { token, channelId } = ctx;
		try {
			await lockLoreFile(token, channelId, path);
			await loadLoreRepo();
		} catch (e) {
			console.error('Lock failed:', e);
		}
	}

	async function handleUnlock(path: string) {
		const ctx = requireActionContext();
		if (!ctx) return;
		const { token, channelId } = ctx;
		try {
			await unlockLoreFile(token, channelId, path);
			await loadLoreRepo();
		} catch (e) {
			console.error('Unlock failed:', e);
		}
	}

/** Entry point kept for the viewer header — opens the typed-confirm dialog. */
	function handleDelete(path: string) {
		requestDelete(path);
	}

	// Map LoreRevision to the shape HistoryPanel expects
	let historyRevisions = $derived(revisions.map(r => ({
		...r,
		author: `User ${r.authorId}`,
	})));

	// Map LoreBranch to the shape BranchPicker expects
	let pickerBranches = $derived(branches.map(b => ({
		...b,
		lastCommit: '',
		lastCommitAt: 0,
		isTag: false,
	})));

	$effect(() => {
		if (activeChannel) {
			loadLoreRepo();
			loadLoreHistory();
			loadLoreHealth();
		}
	});
</script>

<div class="lore-channel-shell">
	{#if !repo}
		<div class="lore-not-connected">
			{#if health === 'error'}
				<div class="lore-error">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<circle cx="12" cy="12" r="10"/>
						<line x1="12" y1="8" x2="12" y2="12"/>
						<line x1="12" y1="16" x2="12.01" y2="16"/>
					</svg>
					<span>Lore service unavailable</span>
				</div>
			{:else if isLoading || autoCreating}
				<div class="lore-loading">
					<span class="spinner"></span>
					<span>{autoCreating ? 'Setting up your folder…' : 'Connecting to Lore…'}</span>
				</div>
			{:else}
				<div class="lore-prompt">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
						<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
						<polyline points="14 2 14 8 20 8"/>
					</svg>
					<span>No folder connected to this channel yet</span>

					{#if canEdit && setupMode === 'idle'}
						<div class="setup-choices">
							<button class="setup-choice primary" onclick={handleAutoCreateRepo} disabled={autoCreating}>
								<strong>Create a project space</strong>
								<small>Start an empty versioned space on the server. Upload files here or sync a local folder later.</small>
							</button>
							<button class="setup-choice" onclick={() => setupMode = 'local'}>
								<strong>Use a folder on this computer</strong>
								<small>Keep files on your machine and sync them with wabi-sync.</small>
							</button>
							<button class="setup-choice subtle" onclick={() => (showConnectModal = true)}>
								<strong>Advanced…</strong>
								<small>Link an existing Lore repo or import from a URL.</small>
							</button>
						</div>
					{:else if canEdit && setupMode === 'local'}
						<div class="setup-local">
							<div class="setup-local-head">
								<span>Connect a local folder with <strong>wabi-sync</strong></span>
								<button class="setup-back" onclick={() => { setupMode = 'idle'; mintTokenError = null; }}>← Back</button>
							</div>
							<div class="setup-token-row">
								<select
									class="setup-scope"
									bind:value={connectTokenScopes}
									title="Token scope"
									disabled={Boolean(connectToken)}
								>
									<option value="write">read+write</option>
									<option value="read">read-only</option>
								</select>
								{#if connectToken}
									<input class="setup-token" type="password" value={connectToken} readonly aria-label="Connect token" />
									<button class="setup-mini-btn" onclick={() => copySetupText(connectToken, 'token')}>
										{copiedField === 'token' ? 'Copied' : 'Copy token'}
									</button>
								{:else}
									<button class="setup-mini-btn" onclick={mintConnectToken} disabled={mintingToken}>
										{mintingToken ? 'Minting…' : 'Mint connect token'}
									</button>
								{/if}
							</div>
							{#if connectToken}
								<p class="setup-hint">Shown once — the server stores only a hash. Copy it now if you still need it.</p>
							{/if}
							{#if mintTokenError}
								<p class="lore-auto-error" role="alert">{mintTokenError}</p>
							{/if}
							<ol class="setup-steps">
								{#each syncCommands as step}
									<li>
										<div class="setup-step-head">
											<span>{step.label}</span>
											<button class="setup-mini-btn" onclick={() => copySetupText(step.cmd, step.label)}>
												{copiedField === step.label ? 'Copied' : 'Copy'}
											</button>
										</div>
										<code class="setup-cmd">{step.cmd}</code>
									</li>
								{/each}
							</ol>
						</div>
					{:else if canEdit}
						<button class="btn btn-primary" onclick={handleAutoCreateRepo} disabled={autoCreating}>
							Set up folder
						</button>
					{:else}
						<span class="lore-readonly-hint">Only admins can set up a folder for this channel.</span>
					{/if}
					{#if autoCreateError}
						<p class="lore-auto-error" role="alert">{autoCreateError}</p>
					{/if}

					<!-- Expectation-setting: this is a file browser / versioned store,
					     not an in-browser IDE. -->
					<p class="lore-expect-hint">
						This view is a file browser for versioned files — history and review live here too.
						Code editing happens in your own editor.
					</p>
				</div>
			{/if}
		</div>
	{:else}
		<!-- Top bar -->
		<div class="lore-top-bar">
			<span class="repo-name">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="repo-icon">
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
					<polyline points="14 2 14 8 20 8"/>
				</svg>
				{repo.repoName}
			</span>

			<LoreBranchPicker
				branches={pickerBranches}
				currentBranch={currentBranch}
				onCreate={handleCreateBranch}
				onSwitch={handleSwitchBranch}
				switchDisabled={!BRANCH_SWITCH_ENABLED}
			/>

			{#if canEdit}
				<button class="btn btn-sm" onclick={() => showTemplates = !showTemplates}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
						<line x1="12" y1="5" x2="12" y2="19"/>
						<line x1="5" y1="12" x2="19" y2="12"/>
					</svg>
					New
				</button>
			{/if}

			{#if canEdit}
				<label class="btn btn-sm" title="Upload file">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
						<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
						<polyline points="17 8 12 3 7 8"/>
						<line x1="12" y1="3" x2="12" y2="15"/>
					</svg>
					Upload
					<input type="file" style="display:none" onchange={handleUpload} bind:this={fileInputEl} />
				</label>
			{/if}

			{#if canEdit}
				<label class="btn btn-sm" class:busy={uploadingFolder} title="Upload a folder — the whole tree lands in uploads/ with structure preserved">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
						<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
						<polyline points="8 13 12 17 16 13" transform="rotate(180 12 15) translate(0 -4)"/>
						<line x1="12" y1="11" x2="12" y2="21" transform="rotate(180 12 16) translate(0 -6)"/>
					</svg>
					{uploadingFolder ? `Uploading ${uploadProgress}…` : 'Upload folder'}
					<input
						type="file"
						style="display:none"
						webkitdirectory
						multiple
						onchange={handleFolderUpload}
					/>
				</label>
			{/if}

			{#if canEdit}
				<button class="btn btn-sm" title="Open this repo in a code-server editor session" onclick={() => showEditor = true}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
						<polyline points="16 18 22 12 16 6"/>
						<polyline points="8 6 2 12 8 18"/>
					</svg>
					Editor
				</button>
			{/if}

			<button
				class="btn btn-sm"
				title="Download the whole project as a .zip (matches the file tree — ignored files excluded)"
				disabled={projectDownloading}
				onclick={() => void handleDownloadProject()}
			>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
					<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
					<polyline points="7 10 12 15 17 10"/>
					<line x1="12" y1="15" x2="12" y2="3"/>
				</svg>
				{projectDownloading ? 'Zipping…' : 'Download'}
			</button>

			<span class="lore-health" class:healthy={health === 'ok'} class:error={health === 'error'}>
				<span class="health-dot"></span>
				{health || '...'}
			</span>

			{#if canEdit}
				<button class="action-btn danger-btn" title="Detach or delete this repository" onclick={() => openDanger('detach')} aria-label="Repository danger zone">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
						<circle cx="12" cy="12" r="3"/>
						<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68 1.65 1.65 0 0 0 10 3.17V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
					</svg>
				</button>
			{/if}
		</div>

		<!-- Upload failure / cancel summary -->
		{#if uploadingFolder || uploadFailures.length > 0}
			<div class="upload-banner" class:busy={uploadingFolder} role="status">
				<span>
					{#if uploadingFolder}Uploading {uploadProgress}…{:else}{uploadFailures.length} upload problem{uploadFailures.length !== 1 ? 's' : ''}: {uploadFailures.join(', ')}{/if}
				</span>
				{#if uploadingFolder}
					<button class="mini-cancel" onclick={cancelFolderUpload}>Cancel</button>
				{/if}
			</div>
		{/if}

		<!-- Pending review queue (uploads routed to a review line) -->
		{#if showPendingReview}
			<div class="pending-review">
				<div class="pending-review-header">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
						<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
						<circle cx="8.5" cy="7" r="4"/>
						<line x1="20" y1="8" x2="20" y2="14"/>
						<line x1="23" y1="11" x2="17" y2="11"/>
					</svg>
					Pending review
				</div>
				{#each pendingReviews as review}
					<div class="pending-review-row">
						<span class="pending-review-name">{review.label}</span>
						<span class="pending-review-copy">uploaded files — approve to make official</span>
						<div class="pending-review-actions">
							<button
								class="review-btn approve"
								disabled={reviewBusy !== null}
								onclick={() => void handleReview(review.name, 'approve')}
							>
								{#if reviewBusy === review.name}<span class="mini-spinner"></span>{/if}
								Approve
							</button>
							<button
								class="review-btn reject"
								disabled={reviewBusy !== null}
								onclick={() => void handleReview(review.name, 'reject')}
							>
								{#if reviewBusy === review.name}<span class="mini-spinner"></span>{/if}
								Reject
							</button>
						</div>
					</div>
				{/each}
			</div>
		{/if}

		<!-- Template picker overlay -->
		{#if showTemplates}
			<div class="template-overlay" onclick={() => showTemplates = false}>
				<div class="template-picker-panel" onclick={(e) => e.stopPropagation()}>
					<div class="template-header">
						<span>Create from template</span>
						<button class="close-btn" onclick={() => showTemplates = false}>×</button>
					</div>
					<LoreTemplatePicker
						{templates}
						onSelect={handleTemplateSelect}
					/>
				</div>
			</div>
		{/if}

		<!-- Tabs -->
		<div class="lore-tabs">
			<button class="tab {activeTab === 'files' ? 'active' : ''}" onclick={() => activeTab = 'files'}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
				</svg>
				Files
			</button>
			<button class="tab {activeTab === 'history' ? 'active' : ''}" onclick={() => activeTab = 'history'}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
					<circle cx="12" cy="12" r="10"/>
					<polyline points="12 6 12 12 16 14"/>
				</svg>
				History
			</button>
			<button class="tab {activeTab === 'diff' ? 'active' : ''}" onclick={() => activeTab = 'diff'}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
					<line x1="18" y1="20" x2="18" y2="10"/>
					<line x1="12" y1="20" x2="12" y2="4"/>
					<line x1="6" y1="20" x2="6" y2="14"/>
				</svg>
				Diff
			</button>
			<button class="tab {activeTab === 'review' ? 'active' : ''}" onclick={() => activeTab = 'review'}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
					<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
					<circle cx="8.5" cy="7" r="4"/>
					<line x1="20" y1="8" x2="20" y2="14"/>
					<line x1="23" y1="11" x2="17" y2="11"/>
				</svg>
				Review
			</button>
			<button class="tab {activeTab === 'timeline' ? 'active' : ''}" onclick={() => activeTab = 'timeline'}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
					<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
					<line x1="16" y1="2" x2="16" y2="6"/>
					<line x1="8" y1="2" x2="8" y2="6"/>
					<line x1="3" y1="10" x2="21" y2="10"/>
				</svg>
				Timeline
			</button>
			<button class="tab {activeTab === 'automation' ? 'active' : ''}" onclick={() => activeTab = 'automation'}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
					<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
					<path d="M7 11V7a5 5 0 0 1 10 0v4"/>
				</svg>
				Automation
			</button>
		</div>

		<!-- Panels -->
		<div class="lore-panels">
			<!-- Files tab -->
			{#if activeTab === 'files'}
				<div class="panel-tree">
					<LoreFileTree
						{files}
						{selectedPath}
						loading={isLoading}
						onSelect={(p: string) => selectedPath = p}
						onOpen={handleOpen}
						onContextMenu={handleContextMenu}
					/>
				</div>
				<div class="panel-viewer">
					{#if selectedPath}
						<div class="file-viewer-header">
							<div class="file-path">
								<span class="path-icon">📄</span>
								{selectedPath}
							</div>
							<div class="file-actions">
								{#if selectedFileInfo}
									<LoreLockBadge
										locked={selectedFileInfo.lockedBy !== null}
										lockedBy={selectedFileInfo.lockedBy ? `User ${selectedFileInfo.lockedBy}` : null}
										lockedAt={null}
										onClick={() => selectedFileInfo?.lockedBy ? handleUnlock(selectedPath!) : handleLock(selectedPath!)}
									/>
								{/if}
								{#if canAssetWrite && selectedPath}
									<button class="action-btn danger-btn" onclick={() => requestDelete(selectedPath!)} title="Delete this file (requires confirmation)" aria-label="Delete file">
										<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
									</button>
								{/if}
								<button class="action-btn" onclick={() => { selectedPath = null; fileContent = null; mediaPreviewUrl = null; }} title="Close">
									<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
										<line x1="18" y1="6" x2="6" y2="18"/>
										<line x1="6" y1="6" x2="18" y2="18"/>
									</svg>
								</button>
							</div>
						</div>
												{#if mediaPreviewUrl}
							<div class="viewer-image-frame"><img src={mediaPreviewUrl} alt={selectedPath ?? ''} loading="lazy" /></div>
						{:else}
							<LoreFileViewer
								filePath={selectedPath}
								{fileContent}
								fileInfo={selectedFileInfo}
								loading={isLoading}
								onClose={() => { selectedPath = null; fileContent = null; mediaPreviewUrl = null; }}
								canEdit={canAssetWrite}
								token={getAuthToken() ?? undefined}
								channelId={parseLoreChannelId(activeChannel) ?? undefined}
								onSaved={() => { void loadLoreRepo(); void loadLoreHistory(); }}
							/>
						{/if}
					{:else}
						<div class="viewer-placeholder">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48">
								<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
								<polyline points="14 2 14 8 20 8"/>
							</svg>
							<span>Select a file to view</span>
						</div>
					{/if}
				</div>
			{:else if activeTab === 'history'}
				<div class="history-layout">
					<div class="history-main">
						<LoreHistoryPanel
							revisions={historyRevisions}
							branches={pickerBranches}
							loading={isLoading}
							onRevisionSelect={(hash: string) => {}}
							onCompare={handleCompare}
						/>
					</div>
					<div class="history-sidebar">
						<div class="calendar-section">
							<h3>Commit Activity</h3>
							<LorePushCalendar commits={pushCalendarData} />
						</div>
					</div>
				</div>
			{:else if activeTab === 'diff'}
				<div class="panel-full">
					{#if fileDiff}
						<LoreDiffViewer
							diff={fileDiff}
							mode={diffMode}
							onModeChange={(m) => diffMode = m}
							filePath={selectedPath ?? undefined}
						/>
					{:else}
						<div class="diff-placeholder">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48">
								<line x1="18" y1="20" x2="18" y2="10"/>
								<line x1="12" y1="20" x2="12" y2="4"/>
								<line x1="6" y1="20" x2="6" y2="14"/>
							</svg>
							<span>Select a file, then compare it from History or right-click → Diff vs previous</span>
						</div>
					{/if}
				</div>
			{:else if activeTab === 'review'}
				<div class="panel-full">
					{#if pendingReviews.length > 0 && !reviewUnavailable}
						<div class="review-list">
							{#each pendingReviews as review (review.name)}
								<div class="review-item">
									<div class="review-item-info">
										<span class="review-item-icon">
											<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">
												<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
												<polyline points="14 2 14 8 20 8"/>
											</svg>
										</span>
										<div class="review-item-copy">
											<p class="review-item-title">{review.name} — approve to make these uploads official</p>
											<span class="review-item-hint">New uploads waiting for team approval</span>
										</div>
									</div>
									<div class="review-item-actions">
										<button
											class="review-item-btn review-item-btn-secondary"
											disabled={reviewBusy !== null}
											onclick={() => void handleReview(review.name, 'reject')}
										>
											{reviewBusy === review.name ? 'Rejecting…' : 'Reject'}
										</button>
										<button
											class="review-item-btn review-item-btn-primary"
											disabled={reviewBusy !== null}
											onclick={() => void handleReview(review.name, 'approve')}
										>
											{reviewBusy === review.name ? 'Approving…' : 'Approve'}
										</button>
									</div>
								</div>
							{/each}
						</div>
					{:else}
						<div class="review-placeholder">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48">
								<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
								<circle cx="8.5" cy="7" r="4"/>
								<line x1="20" y1="8" x2="20" y2="14"/>
								<line x1="23" y1="11" x2="17" y2="11"/>
							</svg>
							<span>No uploads awaiting review</span>
						</div>
					{/if}
				</div>
			{:else if activeTab === 'timeline'}
				<div class="panel-full timeline-layout">
					<LoreActivityFeed activity={activityItems} />
				</div>
			{:else if activeTab === 'automation'}
				<div class="automation-layout">
					<section class="automation-card">
						<h3>Scripts</h3>
						<p class="automation-hint">Run repo scripts (py/sh/js) with timeouts and concurrency limits.</p>
						<LoreScriptRunner channelId={activeChannel} />
					</section>
					<section class="automation-card">
						<h3>Mirror</h3>
						<p class="automation-hint">Publish this space to GitHub, GitLab, or S3.</p>
						<LoreMirrorPanel channelId={activeChannel} />
					</section>
				</div>
			{/if}
		</div>

	{/if}

	<!-- File context menu (right-click a tree node) -->
	{#if contextMenu}
		<div class="ctx-backdrop" role="presentation" onclick={closeContextMenu} oncontextmenu={(e) => e.preventDefault()}></div>
		<div
			class="ctx-menu"
			role="menu"
			style="left: {Math.min(contextMenu.x, window.innerWidth - 200)}px; top: {Math.min(contextMenu.y, window.innerHeight - 200)}px;"
		>
			{#if contextMenu.isFolder && canAssetWrite}
				<div class="ctx-item" role="menuitem" onclick={contextMenuUploadHere} title="Upload a file into this folder">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
					Upload here…
				</div>
			{/if}
			{#if !contextMenu.isFolder && canAssetWrite && !(files.find((f) => f.path === contextMenu.path)?.lockedBy)}
				<div class="ctx-item" role="menuitem" onclick={contextMenuLock} title="Lock this file for editing">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
					Lock
				</div>
			{/if}
			{#if !contextMenu.isFolder && files.find((f) => f.path === contextMenu.path)?.lockedBy}
				<div class="ctx-item" role="menuitem" onclick={contextMenuUnlock} title="Release the lock on this file">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
					Unlock
				</div>
			{/if}
			{#if !contextMenu.isFolder}
				<div class="ctx-item" role="menuitem" onclick={contextMenuDiffPrevious} title="Diff this file against its previous version">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/></svg>
					Diff vs previous
				</div>
			{/if}
			{#if canEdit}
				<div class="ctx-item" role="menuitem" onclick={contextMenuEditor} title="Open this repo in a code-server editor session">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
					Open in editor
				</div>
			{/if}
			{#if !contextMenu.isFolder}
				<div class="ctx-item" role="menuitem" onclick={contextMenuDownload} title="Download this file">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
					Download
				</div>
			{/if}
			<div class="ctx-item" role="menuitem" onclick={contextMenuCopyPath} title="Copy the repo path">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
				Copy path
			</div>
			{#if canAssetWrite && !contextMenu.isFolder}
				<div class="ctx-sep" role="separator"></div>
				<div class="ctx-item ctx-danger" role="menuitem" onclick={contextMenuDelete} title="Delete this file (requires typed confirmation)">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
					Delete…
				</div>
			{/if}
		</div>
	{/if}

	<!-- Connect modal (outside repo check so it renders even when no repo) -->
	{#if showConnectModal}
		<LoreConnectModal
			channelId={activeChannel}
			onConnected={() => {
				showConnectModal = false;
				loadLoreRepo();
				loadLoreHealth();
			}}
			onClose={() => showConnectModal = false}
		/>
	{/if}

	<!-- File deletion: typed confirmation (this is a real deletion) -->
	{#if deleteTarget}
		<div class="modal-backdrop" role="presentation" onclick={() => (deleteTarget = null)}>
			<div class="danger-modal" role="dialog" aria-modal="true" aria-labelledby="del-title" onclick={(e) => e.stopPropagation()}>
				<h3 id="del-title">Delete file</h3>
				<p class="danger-copy">
					<strong>{deleteTarget.path}</strong> ({deleteTarget.size} bytes) will be removed from the
					repository as a committed deletion. This is a proper delete — the file leaves the working tree.
				</p>
				<p class="danger-copy">Type <strong>{deleteTarget.path.split('/').pop()}</strong> to confirm:</p>
				<input
					class="danger-input"
					bind:value={deleteConfirmText}
					onkeydown={(e) => e.key === 'Enter' && deleteConfirmText === (deleteTarget?.path.split('/').pop() ?? '') && executeDelete()}
					aria-label="Type the file name to confirm deletion"
				/>
				{#if deleteError}<p class="danger-error" role="alert">{deleteError}</p>{/if}
				<div class="danger-actions">
					<button class="btn btn-sm" onclick={() => (deleteTarget = null)}>Cancel</button>
					<button
						class="btn btn-sm danger-go"
						disabled={deleteBusy || deleteConfirmText !== (deleteTarget.path.split('/').pop() ?? '')}
						onclick={() => void executeDelete()}
					>
						{deleteBusy ? 'Deleting…' : 'Delete file'}
					</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- Repo danger zone: detach vs delete -->
	{#if dangerAction === 'detach'}
		<div class="modal-backdrop" role="presentation" onclick={() => (dangerAction = null)}>
			<div class="danger-modal" role="dialog" aria-modal="true" aria-labelledby="dz-title" onclick={(e) => e.stopPropagation()}>
				<h3 id="dz-title">Detach this space?</h3>
				<p class="danger-copy">
					The channel loses its connection to <strong>{repo?.repoName}</strong>, but every file and
					the full history stay safely on the server. Reconnect this channel at any time and
					everything comes back.
				</p>
				<div class="danger-actions">
					<button class="btn btn-sm" onclick={() => (dangerAction = null)}>Cancel</button>
					<button class="btn btn-sm" disabled={dangerBusy} onclick={() => openDanger('delete')}>I want to delete instead…</button>
					<button class="btn btn-sm warn-go" disabled={dangerBusy} onclick={() => void executeDanger()}>
						{dangerBusy ? 'Detaching…' : 'Detach — keep all data'}
					</button>
				</div>
			</div>
		</div>
	{:else if dangerAction === 'delete' && dangerConfirmText === ''}
		<div class="modal-backdrop" role="presentation" onclick={() => openDanger('detach')}>
			<div class="danger-modal" role="dialog" aria-modal="true" aria-labelledby="dz2-title" onclick={(e) => e.stopPropagation()}>
				<h3 id="dz2-title">Delete this entire space?</h3>
				<p class="danger-copy">
					<strong>{repo?.repoName}</strong> — {files.length} file{files.length === 1 ? '' : 's'} and every saved
					revision will be permanently erased from the server. No undo. No trash.
				</p>
				<p class="danger-copy small">Keeping the data? Detach unlinks the channel without touching a single byte.</p>
				<div class="danger-actions">
					<button class="btn btn-sm" onclick={() => openDanger('detach')}>← Back to detach</button>
					<button class="btn btn-sm" onclick={() => (dangerAction = null)}>Cancel</button>
					<button class="btn btn-sm danger-go" onclick={() => { dangerConfirmText = ' '; }}>Continue to final delete…</button>
				</div>
			</div>
		</div>
	{:else if dangerAction === 'delete'}
		<div class="modal-backdrop" role="presentation" onclick={() => openDanger('detach')}>
			<div class="danger-modal" role="dialog" aria-modal="true" aria-labelledby="dz3-title" onclick={(e) => e.stopPropagation()}>
				<h3 id="dz3-title">Final check — this cannot be undone</h3>
				<p class="danger-copy">Type <strong>{repo?.repoName}</strong> to permanently erase every file and revision.</p>
				<input
					class="danger-input"
					bind:value={dangerConfirmText}
					onkeydown={(e) => e.key === 'Enter' && dangerConfirmText === repo?.repoName && executeDanger()}
					aria-label="Type the repository name to confirm permanent deletion"
				/>
				{#if dangerError}<p class="danger-error" role="alert">{dangerError}</p>{/if}
				<div class="danger-actions">
					<button class="btn btn-sm" onclick={() => openDanger('detach')}>← Back</button>
					<button class="btn btn-sm" onclick={() => (dangerAction = null)}>Cancel</button>
					<button class="btn btn-sm danger-go" disabled={dangerBusy || dangerConfirmText !== repo?.repoName} onclick={() => void executeDanger()}>
						{dangerBusy ? 'Deleting…' : 'Erase everything permanently'}
					</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- Editor bridge overlay -->
	{#if showEditor}
		<div class="editor-overlay">
			<div class="editor-panel">
				<div class="editor-head">
					<span>Code editor — {repo?.repoName}</span>
					<button class="action-btn" onclick={() => (showEditor = false)} aria-label="Close editor panel">✕</button>
				</div>
				<LoreEditorBridge channelId={activeChannel} onClose={() => (showEditor = false)} />
			</div>
		</div>
	{/if}
</div>

<style>
	.lore-channel-shell {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
	}

	.lore-not-connected {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 1;
	}

	.lore-loading, .lore-prompt {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-2);
		color: var(--text-muted);
	}

	.lore-readonly-hint {
		font-size: var(--font-size-sm);
		color: var(--text-muted);
		opacity: 0.7;
	}

	.lore-auto-error {
		color: var(--color-danger, #ef4444);
		font-size: var(--font-size-sm);
		margin: 0;
	}

	/* ── Setup chooser (empty state) ─────────────────────────────── */

	.setup-choices {
		display: grid;
		gap: var(--space-2);
		width: min(420px, 90%);
	}

	.setup-choice {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 3px;
		padding: var(--space-2) var(--space-3);
		text-align: left;
		background: color-mix(in srgb, var(--surface-raised, #1c1c24) 72%, transparent);
		border: 1px solid color-mix(in srgb, var(--accent-primary) 26%, transparent);
		border-radius: var(--radius-md, 8px);
		color: var(--text-heading, inherit);
		cursor: pointer;
	}
	.setup-choice:hover { border-color: color-mix(in srgb, var(--accent-primary) 55%, transparent); }
	.setup-choice strong { font-size: var(--font-size-sm); }
	.setup-choice small { color: var(--text-muted); font-size: var(--font-size-xs); line-height: 1.35; }
	.setup-choice.primary {
		border-color: color-mix(in srgb, var(--accent-primary) 60%, transparent);
		background: color-mix(in srgb, var(--accent-primary) 14%, var(--surface-raised, #1c1c24));
	}
	.setup-choice.subtle { opacity: 0.85; }
	.setup-choice:disabled { opacity: 0.6; cursor: default; }

	.setup-local {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		width: min(480px, 94%);
		max-height: 60vh;
		overflow-y: auto;
		padding: var(--space-2) var(--space-3);
		background: color-mix(in srgb, var(--surface-raised, #1c1c24) 72%, transparent);
		border: 1px solid color-mix(in srgb, var(--accent-primary) 22%, transparent);
		border-radius: var(--radius-md, 8px);
		text-align: left;
	}
	.setup-local-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}
	.setup-local-head span { font-size: var(--font-size-sm); }
	.setup-back {
		background: none;
		border: none;
		color: var(--text-muted);
		font-size: var(--font-size-xs);
		cursor: pointer;
		padding: 0;
	}
	.setup-back:hover { color: var(--text-heading); }

	.setup-token-row { display: flex; align-items: center; gap: var(--space-1); }
	.setup-scope {
		flex: 0 0 auto;
		padding: 4px var(--space-1);
		border-radius: var(--radius-sm, 6px);
		border: 1px solid color-mix(in srgb, var(--accent-primary) 25%, transparent);
		background: var(--surface-base, transparent);
		color: var(--text-body, inherit);
		font-size: var(--font-size-xs);
	}
	.setup-token {
		flex: 1;
		min-width: 0;
		padding: 4px var(--space-1);
		border-radius: var(--radius-sm, 6px);
		border: 1px solid color-mix(in srgb, var(--accent-primary) 25%, transparent);
		background: var(--surface-base, transparent);
		color: var(--text-body, inherit);
		font-family: var(--font-family-mono, monospace);
		font-size: var(--font-size-xs);
	}
	.setup-mini-btn {
		flex: 0 0 auto;
		padding: 4px var(--space-2);
		border-radius: var(--radius-sm, 6px);
		border: 1px solid color-mix(in srgb, var(--accent-primary) 40%, transparent);
		background: transparent;
		color: var(--text-heading, inherit);
		font-size: var(--font-size-xs);
		cursor: pointer;
	}
	.setup-mini-btn:hover { background: color-mix(in srgb, var(--accent-primary) 16%, transparent); }
	.setup-mini-btn:disabled { opacity: 0.6; cursor: default; }

	.setup-hint { margin: 0; font-size: var(--font-size-xs); color: var(--text-muted); }

	.setup-steps {
		margin: 0;
		padding: 0 0 0 1.1rem;
		display: grid;
		gap: var(--space-2);
		font-size: var(--font-size-xs);
		color: var(--text-muted);
	}
	.setup-step-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}
	.setup-cmd {
		display: block;
		margin-top: 2px;
		padding: 4px var(--space-2);
		background: rgba(0, 0, 0, 0.28);
		border-radius: var(--radius-sm, 6px);
		font-family: var(--font-family-mono, monospace);
		font-size: var(--font-size-xs);
		color: var(--text-body, inherit);
		user-select: all;
		overflow-x: auto;
		white-space: nowrap;
	}

	.lore-expect-hint {
		margin: var(--space-2) 0 0;
		max-width: min(460px, 92%);
		font-size: var(--font-size-xs);
		line-height: 1.45;
		color: var(--text-muted);
		opacity: 0.85;
	}

	.lore-error {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-2);
		color: var(--color-danger, #ef4444);
	}

	.lore-error svg, .lore-prompt svg {
		width: 48px;
		height: 48px;
		opacity: 0.6;
	}

	.spinner {
		width: 24px;
		height: 24px;
		border: 2px solid var(--surface-raised);
		border-top-color: var(--accent-primary);
		border-radius: 50%;
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	/* Top bar */
	.lore-top-bar {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-1) var(--space-2);
		background: var(--surface-raised);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
	}

	.repo-name {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		color: var(--text-heading);
		font-weight: 600;
		font-size: var(--font-size-sm);
	}

	.repo-icon {
		width: 16px;
		height: 16px;
		opacity: 0.7;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: 4px var(--space-2);
		border-radius: var(--radius-sm);
		font-size: var(--font-size-xs);
		cursor: pointer;
		border: 1px solid color-mix(in srgb, var(--text-muted) 20%, transparent);
		background: var(--surface-sunken);
		color: var(--text-secondary);
		transition: all var(--duration-fast) var(--ease-out);
	}

	.btn:hover {
		background: var(--surface-raised);
		color: var(--text-heading);
		border-color: color-mix(in srgb, var(--text-muted) 40%, transparent);
	}

	.btn-sm {
		padding: 2px var(--space-1);
		font-size: var(--font-size-2xs);
	}

	.lore-health {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		margin-left: auto;
		font-size: var(--font-size-xs);
		color: var(--text-muted);
	}

	.health-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--text-muted);
	}

	.lore-health.healthy {
		color: var(--color-success, #22c55e);
	}

	.lore-health.healthy .health-dot {
		background: var(--color-success, #22c55e);
		box-shadow: 0 0 6px var(--color-success, #22c55e);
	}

	.lore-health.error {
		color: var(--color-danger, #ef4444);
	}

	.lore-health.error .health-dot {
		background: var(--color-danger, #ef4444);
		box-shadow: 0 0 6px var(--color-danger, #ef4444);
	}

	/* Pending review queue */
	.pending-review {
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		background: color-mix(in srgb, var(--color-warning, #f59e0b) 6%, var(--surface-sunken));
		padding: var(--space-1) var(--space-2);
	}

	.pending-review-header {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		font-size: var(--font-size-2xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-warning, #f59e0b);
		margin-bottom: var(--space-1);
	}

	.pending-review-row {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		padding: var(--space-1) 0;
		font-size: var(--font-size-xs);
	}

	.pending-review-name {
		color: var(--text-heading);
		font-family: var(--font-mono);
		font-weight: 600;
	}

	.pending-review-copy {
		color: var(--text-muted);
		flex: 1;
	}

	.pending-review-actions {
		display: flex;
		gap: var(--space-1);
	}

	.review-btn {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: 2px var(--space-2);
		border-radius: var(--radius-sm);
		font-size: var(--font-size-2xs);
		font-weight: 600;
		cursor: pointer;
		border: 1px solid transparent;
		transition: all var(--duration-fast) var(--ease-out);
	}

	.review-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.review-btn.approve {
		background: color-mix(in srgb, var(--color-success, #22c55e) 15%, transparent);
		color: var(--color-success, #22c55e);
		border-color: color-mix(in srgb, var(--color-success, #22c55e) 40%, transparent);
	}

	.review-btn.approve:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-success, #22c55e) 25%, transparent);
	}

	.review-btn.reject {
		background: color-mix(in srgb, var(--color-danger, #ef4444) 15%, transparent);
		color: var(--color-danger, #ef4444);
		border-color: color-mix(in srgb, var(--color-danger, #ef4444) 40%, transparent);
	}

	.review-btn.reject:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-danger, #ef4444) 25%, transparent);
	}

	.mini-spinner {
		width: 10px;
		height: 10px;
		border: 1.5px solid currentColor;
		border-top-color: transparent;
		border-radius: 50%;
		animation: spin 1s linear infinite;
	}

	/* Tabs */
	.lore-tabs {
		display: flex;
		gap: 0;
		background: var(--surface-sunken);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		overflow-x: auto;
	}

	.tab {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		padding: var(--space-1) var(--space-3);
		background: transparent;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--text-muted);
		cursor: pointer;
		font-size: var(--font-size-sm);
		white-space: nowrap;
		transition: all var(--duration-fast) var(--ease-out);
	}

	.tab:hover {
		color: var(--text-heading);
		background: var(--surface-raised);
	}

	.tab.active {
		color: var(--accent-primary);
		border-bottom-color: var(--accent-primary);
	}

	/* Panels */
	.lore-panels {
		display: flex;
		flex: 1;
		overflow: hidden;
	}

	.panel-tree {
		width: 280px;
		min-width: 200px;
		border-right: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		overflow: hidden;
	}

	.panel-viewer {
		flex: 1;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.panel-full {
		flex: 1;
		overflow: hidden;
	}

	/* File viewer header */
	.file-viewer-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-1) var(--space-2);
		background: var(--surface-raised);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 10%, transparent);
	}

	.file-path {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		font-size: var(--font-size-sm);
		color: var(--text-secondary);
		font-family: var(--font-mono);
	}

	.path-icon {
		font-size: 14px;
	}

	.file-actions {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}

	.action-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		transition: all var(--duration-fast) var(--ease-out);
	}

	.action-btn:hover {
		background: var(--surface-raised);
		color: var(--text-heading);
	}

	.action-btn.active {
		color: var(--accent-primary);
		background: color-mix(in srgb, var(--accent-primary) 15%, transparent);
	}

	/* Placeholders */
	.viewer-placeholder, .diff-placeholder, .review-placeholder {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		height: 100%;
		color: var(--text-muted);
		opacity: 0.6;
	}

	/* Upload review queue */
	.review-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-3);
		overflow-y: auto;
	}

	.review-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-3);
		background: var(--surface-sunken);
		border: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		border-radius: var(--radius-md);
	}

	.review-item-info {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		min-width: 0;
	}

	.review-item-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		flex-shrink: 0;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--accent-primary) 15%, transparent);
		color: var(--accent-secondary);
	}

	.review-item-copy {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.review-item-title {
		margin: 0;
		font-size: var(--font-size-sm);
		font-weight: 500;
		color: var(--text-heading);
		font-family: var(--font-mono);
		word-break: break-word;
	}

	.review-item-hint {
		font-size: var(--font-size-xs);
		color: var(--text-muted);
	}

	.review-item-actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-shrink: 0;
	}

	.review-item-btn {
		padding: var(--space-1) var(--space-3);
		border: none;
		border-radius: var(--radius-sm);
		font-size: var(--font-size-sm);
		font-weight: 500;
		cursor: pointer;
		transition: all var(--duration-fast) var(--ease-out);
	}

	.review-item-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.review-item-btn-primary {
		background: var(--accent-primary);
		color: white;
	}

	.review-item-btn-primary:hover:not(:disabled) {
		background: var(--accent-secondary);
	}

	.review-item-btn-secondary {
		background: var(--surface-raised);
		color: var(--text-secondary);
	}

	.review-item-btn-secondary:hover:not(:disabled) {
		background: var(--surface-app);
		color: var(--text-heading);
	}

	/* History layout */
	.history-layout {
		display: flex;
		flex: 1;
		overflow: hidden;
	}

	.history-main {
		flex: 1;
		overflow: hidden;
	}

	.history-sidebar {
		width: 320px;
		min-width: 280px;
		border-left: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		overflow-y: auto;
		padding: var(--space-2);
	}

	.calendar-section h3 {
		font-size: var(--font-size-sm);
		color: var(--text-heading);
		margin: 0 0 var(--space-2) 0;
	}

	/* Template overlay */
	.template-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: var(--z-modal, 1000);
	}

	.template-picker-panel {
		background: var(--surface-base);
		border-radius: var(--radius-lg);
		border: 1px solid color-mix(in srgb, var(--text-muted) 20%, transparent);
		width: 480px;
		max-height: 60vh;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.template-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-2) var(--space-3);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		color: var(--text-heading);
		font-weight: 600;
	}

	.close-btn {
		width: 24px;
		height: 24px;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 18px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.close-btn:hover {
		background: var(--surface-raised);
		color: var(--text-heading);
	}

	/* Citation bar */
	.citation-bar {
		border-top: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		background: var(--surface-raised);
		max-height: 120px;
		overflow-y: auto;
	}

	.citation-preview-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: var(--z-modal, 1000);
	}

	.citation-preview-panel {
		background: var(--surface-base);
		border-radius: var(--radius-lg);
		border: 1px solid color-mix(in srgb, var(--text-muted) 20%, transparent);
		width: 640px;
		max-height: 70vh;
		overflow: auto;
	}

	/* Timeline layout */
	.timeline-layout {
		flex: 1;
		overflow: hidden;
	}

	/* Responsive */
	@media (max-width: 768px) {
		.panel-tree {
			width: 200px;
			min-width: 160px;
		}

		.history-sidebar {
			width: 240px;
			min-width: 200px;
		}

		.template-picker-panel {
			width: 90vw;
		}

		.citation-preview-panel {
			width: 90vw;
		}
		}

		/* File context menu */
		.ctx-backdrop {
		position: fixed;
		inset: 0;
		z-index: 300;
		background: transparent;
		}
		.ctx-menu {
		position: fixed;
		z-index: 301;
		min-width: 160px;
		background: var(--surface-raised, #24243e);
		border: 1px solid var(--border-color, #2a2a4a);
		border-radius: 8px;
		padding: 0.25rem;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
		}
		.ctx-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.45rem 0.6rem;
		border-radius: 6px;
		font-size: 0.82rem;
		color: var(--text-secondary, #b3b3ff);
		cursor: pointer;
		}
		.ctx-item:hover {
		background: var(--surface-base, #1a1a2e);
		color: var(--text-heading, #e0e0ff);
		}
		.ctx-danger {
		color: var(--color-danger, #ef4444);
		}
		.ctx-danger:hover {
		background: rgba(239, 68, 68, 0.12);
		color: #ff6b6b;
		}
		
	/* ── P0/P1/P2 polish additions ─────────────────────────────── */

	.danger-btn {
		color: var(--color-danger, #ef4444);
	}

	.danger-btn:hover {
		background: color-mix(in srgb, var(--color-danger, #ef4444) 12%, transparent);
	}

	.upload-banner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		padding: var(--space-1) var(--space-2);
		font-size: var(--font-size-xs);
		background: color-mix(in srgb, var(--accent-primary) 12%, var(--surface-raised));
		border-bottom: 1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent);
		color: var(--text-secondary);
		overflow: hidden;
	}

	.upload-banner span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.mini-cancel {
		flex-shrink: 0;
		padding: 2px var(--space-2);
		border-radius: var(--radius-sm);
		border: 1px solid color-mix(in srgb, var(--text-muted) 30%, transparent);
		background: transparent;
		color: var(--text-heading);
		cursor: pointer;
		font-size: var(--font-size-xs);
	}

	.ctx-sep {
		height: 1px;
		margin: var(--space-1) 0;
		background: color-mix(in srgb, var(--text-muted) 20%, transparent);
	}

	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.55);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: calc(var(--z-modal, 1000) + 10);
		backdrop-filter: blur(2px);
	}

	.danger-modal {
		width: min(480px, 92vw);
		padding: var(--space-4);
		background: var(--surface-base);
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--color-danger, #ef4444) 35%, transparent);
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
	}

	.danger-modal h3 {
		margin: 0 0 var(--space-2);
		color: var(--text-heading);
	}

	.danger-copy {
		margin: 0 0 var(--space-2);
		font-size: var(--font-size-sm);
		line-height: 1.5;
		color: var(--text-secondary);
		overflow-wrap: anywhere;
	}

	.danger-copy.small {
		font-size: var(--font-size-xs);
		color: var(--text-muted);
	}

	.danger-input {
		width: 100%;
		padding: 6px var(--space-2);
		border-radius: var(--radius-sm);
		border: 1px solid color-mix(in srgb, var(--color-danger, #ef4444) 45%, transparent);
		background: var(--surface-sunken);
		color: var(--text-heading);
		font-family: var(--font-family-mono, monospace);
		font-size: var(--font-size-sm);
		margin-bottom: var(--space-2);
	}

	.danger-error {
		margin: 0 0 var(--space-2);
		color: var(--color-danger, #ef4444);
		font-size: var(--font-size-xs);
	}

	.danger-actions {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.danger-go {
		background: var(--color-danger, #ef4444);
		border-color: transparent;
		color: #fff;
		font-weight: 600;
	}

	.warn-go {
		border-color: color-mix(in srgb, var(--accent-primary) 60%, transparent);
		color: var(--accent-primary);
		font-weight: 600;
	}

	.viewer-image-frame {
		flex: 1;
		min-height: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: auto;
		padding: var(--space-2);
	}

	.viewer-image-frame img {
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
		border-radius: var(--radius-sm);
	}

	.automation-layout {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-3);
		overflow-y: auto;
		height: 100%;
	}

	.automation-card {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-3);
		background: color-mix(in srgb, var(--surface-raised, #1c1c24) 72%, transparent);
		border: 1px solid color-mix(in srgb, var(--accent-primary) 22%, transparent);
		border-radius: var(--radius-md, 8px);
	}

	.automation-card h3 {
		margin: 0;
		font-size: var(--font-size-sm);
		color: var(--text-heading);
	}

	.automation-hint {
		margin: 0;
		font-size: var(--font-size-xs);
		color: var(--text-muted);
	}

	.editor-overlay {
		position: fixed;
		inset: 0;
		z-index: calc(var(--z-modal, 1000) + 5);
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.editor-panel {
		width: min(560px, 94vw);
		max-height: 86vh;
		overflow-y: auto;
		background: var(--surface-base);
		border-radius: var(--radius-lg);
		border: 1px solid color-mix(in srgb, var(--text-muted) 25%, transparent);
		padding: var(--space-3);
	}

	.editor-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: var(--space-2);
		font-size: var(--font-size-sm);
		color: var(--text-heading);
	}
</style>