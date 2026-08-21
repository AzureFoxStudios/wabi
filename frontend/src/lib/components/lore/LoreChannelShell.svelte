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
	} from '$lib/loreStore';
	import {
		getSignedLoreUrl,
		parseLoreChannelId,
		uploadLoreFile,
		createLoreRepo,
		getLoreRepo,
		getLoreBranches,
		listLoreFiles,
		mintLoreConnectToken,
		createLoreSnapshot,
		createLoreBranch,
		lockLoreFile,
		unlockLoreFile,
		deleteLoreFile,
		reviewLoreBranch,
		type LoreFileInfo,
		type LoreRevision,
		type LoreBranch,
	} from '$lib/api/lore';
	import { getAuthToken } from '$lib/authSession';

	// VCS components
	import LoreFileTree from './LoreFileTree.svelte';
	import LoreFileViewer from './LoreFileViewer.svelte';
	import LoreHistoryPanel from './LoreHistoryPanel.svelte';
	import LoreDiffViewer from './LoreDiffViewer.svelte';
	import LoreBranchPicker from './LoreBranchPicker.svelte';
	import LoreBlameView from './LoreBlameView.svelte';
	import LoreLockBadge from './LoreLockBadge.svelte';
	import LoreConnectModal from './LoreConnectModal.svelte';

	// Timeline / governance
	import LoreActivityFeed from './LoreActivityFeed.svelte';
	import LorePushCalendar from './LorePushCalendar.svelte';
	import LoreAuditViewer from './LoreAuditViewer.svelte';

	// Review
	import LoreReviewPanel from './LoreReviewPanel.svelte';

	// Templates
	import LoreTemplatePicker from './LoreTemplatePicker.svelte';

	// Citations
	import LoreCitationPreview from './LoreCitationPreview.svelte';
	import LoreCitationChip from './LoreCitationChip.svelte';
	import LoreCitationRegistry from './LoreCitationRegistry.svelte';

	type Tab = 'files' | 'history' | 'diff' | 'review' | 'timeline' | 'governance';
	type FileView = 'view' | 'blame';

	let activeChannel = $derived($currentChannel);
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
	let fileView = $state<FileView>('view');
	let selectedPath = $state<string | null>(null);
	let fileContent = $state<string | null>(null);
	let selectedFileInfo = $state<LoreFileInfo | null>(null);
	let diffMode = $state<'unified' | 'side-by-side'>('unified');
	let currentBranch = $state('main');

	// Template picker
	let showTemplates = $state(false);

	// Citation state
	let activeCitation = $state<{
		file_path: string;
		start_line: number;
		end_line: number;
		mode: 'Pinned' | 'Tracking';
		branch?: string;
		revision?: string;
	} | null>(null);
	let citationContent = $state<string>('');
	let citationLanguage = $state<string>('');

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

	// Audit events (placeholder — real data comes from backend audit log endpoint)
	let auditEvents = $state<Array<{
		id: string;
		type: string;
		author_id: string;
		description: string;
		timestamp: number;
		details: Record<string, any>;
	}>>([]);

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
		const token = getAuthToken();
		const channelId = parseLoreChannelId(activeChannel);
		if (!token || !channelId) return;
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

	// Review data (placeholder — real data comes from backend review endpoint)
	let activeReview = $state<{
		id: string;
		title: string;
		source_branch: string;
		target_branch: string;
		status: 'Open' | 'Approved' | 'ChangesRequested' | 'Merged' | 'Closed';
		author_id: string;
		commit_count: number;
		file_change_count: number;
		insertions: number;
		deletions: number;
	} | null>(null);

	// Citation registry (placeholder)
	let citations = $state<Array<{
		id: string;
		file_path: string;
		start_line: number;
		end_line: number;
		mode: 'Pinned' | 'Tracking';
		branch?: string;
		revision?: string;
		label?: string;
		drift?: 'Current' | 'Drifted' | 'Missing';
	}>>([]);

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
		fileView = 'view';
		activeTab = 'files';

		const token = getAuthToken();
		const channelId = parseLoreChannelId(activeChannel);
		if (!token || !channelId) return;

		try {
			const url = await getSignedLoreUrl(token, channelId, path);
			const res = await fetch(url);
			if (res.ok) {
				fileContent = await res.text();
			}
		} catch {
			fileContent = null;
		}
	}

	let contextMenu = $state<{ path: string; x: number; y: number } | null>(null);

	function handleContextMenu(path: string, event: MouseEvent) {
		event.preventDefault();
		contextMenu = { path, x: event.clientX, y: event.clientY };
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
		if (contextMenu) void handleDelete(contextMenu.path);
		closeContextMenu();
	}

	function contextMenuCompare() {
		const path = contextMenu?.path ?? selectedPath;
		if (path) {
			// Preview the file, then open the diff tab against it.
			selectedPath = path;
			selectedFileInfo = files.find(f => f.path === path) || null;
			void handleCompare('HEAD', 'working');
		}
		closeContextMenu();
	}

	async function handleCreateBranch(name: string, from: string) {
		const token = getAuthToken();
		const channelId = parseLoreChannelId(activeChannel);
		if (!token || !channelId) return;
		try {
			await createLoreBranch(token, channelId, name, from);
			await loadLoreHistory();
		} catch (e) {
			console.error('Failed to create branch:', e);
		}
	}

	async function handleSwitchBranch(name: string) {
		currentBranch = name;
		await loadLoreRepo();
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
		const token = getAuthToken();
		const channelId = parseLoreChannelId(activeChannel);
		if (!token || !channelId || reviewBusy) return;

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

		const token = getAuthToken();
		const channelId = parseLoreChannelId(activeChannel);
		if (!token || !channelId) return;

		try {
			const repoPath = `uploads/${file.name}`;
			await uploadLoreFile(token, channelId, repoPath, file, `Upload ${file.name}`);
			await loadLoreRepo();
		} catch (e) {
			console.error('Upload failed:', e);
		}

		input.value = '';
	}

	async function handleTemplateSelect(template: any) {
		showTemplates = false;
		selectedPath = template.file_path;
		fileContent = null;
		// Create the file in the repo from the template's starter content
		// (templates are the built-in list above; content is a small boilerplate
		// per language). Uses the same upload path as file uploads so the file
		// lands in the repo and the tree refreshes.
		const token = getAuthToken();
		const channelId = parseLoreChannelId(activeChannel);
		if (!token || !channelId) return;
		try {
			const content = templateContent(template);
			const blob = new Blob([content], { type: 'text/plain' });
			const file = new File([blob], template.file_path.split('/').pop() || 'template.txt');
			await uploadLoreFile(token, channelId, template.file_path, file, `Create ${template.file_path} from template`);
			await loadLoreRepo();
			// Refresh the file view with the created content.
			selectedFileInfo = $loreFiles.find(f => f.path === template.file_path) || null;
			fileContent = content;
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
		const token = getAuthToken();
		const channelId = parseLoreChannelId(activeChannel);
		if (!token || !channelId) return;
		try {
			await lockLoreFile(token, channelId, path);
			await loadLoreRepo();
		} catch (e) {
			console.error('Lock failed:', e);
		}
	}

	async function handleUnlock(path: string) {
		const token = getAuthToken();
		const channelId = parseLoreChannelId(activeChannel);
		if (!token || !channelId) return;
		try {
			await unlockLoreFile(token, channelId, path);
			await loadLoreRepo();
		} catch (e) {
			console.error('Unlock failed:', e);
		}
	}

	async function handleDelete(path: string) {
		if (!confirm(`Delete ${path}?`)) return;
		const token = getAuthToken();
		const channelId = parseLoreChannelId(activeChannel);
		if (!token || !channelId) return;
		try {
			await deleteLoreFile(token, channelId, path, `Delete ${path}`);
			selectedPath = null;
			await loadLoreRepo();
		} catch (e) {
			console.error('Delete failed:', e);
		}
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
					<input type="file" style="display:none" onchange={handleUpload} />
				</label>
			{/if}

			<span class="lore-health" class:healthy={health === 'ok'} class:error={health === 'error'}>
				<span class="health-dot"></span>
				{health || '...'}
			</span>
		</div>

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
			<button class="tab {activeTab === 'governance' ? 'active' : ''}" onclick={() => activeTab = 'governance'}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
					<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
					<path d="M7 11V7a5 5 0 0 1 10 0v4"/>
				</svg>
				Governance
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
								<button
									class="action-btn {fileView === 'blame' ? 'active' : ''}"
									onclick={() => fileView = fileView === 'blame' ? 'view' : 'blame'}
									title="Toggle blame view"
								>
									<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
										<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
										<circle cx="12" cy="12" r="3"/>
									</svg>
								</button>
								<button class="action-btn" onclick={() => { selectedPath = null; fileContent = null; }} title="Close">
									<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
										<line x1="18" y1="6" x2="6" y2="18"/>
										<line x1="6" y1="6" x2="18" y2="18"/>
									</svg>
								</button>
							</div>
						</div>
						{#if fileView === 'blame'}
							<LoreBlameView
								filePath={selectedPath}
								blameData={[]}
								loading={false}
							/>
						{:else}
							<LoreFileViewer
								filePath={selectedPath}
								{fileContent}
								fileInfo={selectedFileInfo}
								loading={isLoading}
								onClose={() => { selectedPath = null; fileContent = null; }}
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
							<span>Select two revisions in History to compare</span>
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
					{:else if activeReview}
						<LoreReviewPanel
							review={activeReview}
							onApprove={() => {}}
							onRequestChanges={() => {}}
							onMerge={() => {}}
							onClose={() => activeReview = null}
						/>
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
			{:else if activeTab === 'governance'}
				<div class="panel-full">
					<LoreAuditViewer
						events={auditEvents}
						onFreezeUser={() => {}}
						onPauseEgress={() => {}}
					/>
				</div>
			{/if}
		</div>

		<!-- Citation registry (bottom bar, shown when citations exist) -->
		{#if citations.length > 0}
			<div class="citation-bar">
				<LoreCitationRegistry
					{citations}
					onCitationClick={(id: string) => {
						const c = citations.find(ci => ci.id === id);
						if (c) activeCitation = {
							file_path: c.file_path,
							start_line: c.start_line,
							end_line: c.end_line,
							mode: c.mode,
							branch: c.branch,
							revision: c.revision,
						};
					}}
					onPin={() => {}}
					onUpdate={() => {}}
				/>
			</div>
		{/if}

		<!-- Citation preview (shown when a citation is active) -->
		{#if activeCitation}
			<div class="citation-preview-overlay" onclick={() => activeCitation = null}>
				<div class="citation-preview-panel" onclick={(e) => e.stopPropagation()}>
					<LoreCitationPreview
						citation={activeCitation}
						content={citationContent}
						language={citationLanguage}
						drift="Current"
						onOpen={() => {}}
					/>
				</div>
			</div>
		{/if}
	{/if}

	<!-- File context menu (right-click a tree node) -->
	{#if contextMenu}
		<div class="ctx-backdrop" role="presentation" onclick={closeContextMenu} oncontextmenu={(e) => e.preventDefault()}></div>
		<div
			class="ctx-menu"
			role="menu"
			style="left: {Math.min(contextMenu.x, window.innerWidth - 200)}px; top: {Math.min(contextMenu.y, window.innerHeight - 200)}px;"
		>
			<div class="ctx-item" role="menuitem" onclick={contextMenuLock} title="Lock this file for editing">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
				Lock
			</div>
			<div class="ctx-item" role="menuitem" onclick={contextMenuUnlock} title="Release the lock on this file">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
				Unlock
			</div>
			<div class="ctx-item" role="menuitem" onclick={contextMenuCompare} title="Compare this file against the latest revision">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/></svg>
				Compare
			</div>
			<div class="ctx-item ctx-danger" role="menuitem" onclick={contextMenuDelete} title="Delete this file from the repo">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
				Delete
			</div>
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
		</style>