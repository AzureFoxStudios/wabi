<script lang="ts">
	import { currentChannel, currentUser } from '$lib/socket';
	import {
		loreRepo,
		loreFiles,
		loreRevisions,
		loreBranches,
		loreFileDiff,
		loreLoading,
		loreHealth,
		loadLoreRepo,
		loadLoreHistory,
		loadLoreHealth,
	} from '$lib/loreStore';
	import {
		getSignedLoreUrl,
		parseLoreChannelId,
		type LoreFileInfo,
		type LoreRevision,
		type LoreBranch,
	} from '$lib/api/lore';
	import { getAuthToken } from '$lib/authSession';
	import LoreFileTree from './LoreFileTree.svelte';
	import LoreFileViewer from './LoreFileViewer.svelte';
	import LoreHistoryPanel from './LoreHistoryPanel.svelte';
	import LoreDiffViewer from './LoreDiffViewer.svelte';
	import LoreBranchPicker from './LoreBranchPicker.svelte';

	type Tab = 'files' | 'history' | 'diff';

	let activeChannel = $derived($currentChannel);
	let repo = $derived($loreRepo);
	let files = $derived($loreFiles);
	let revisions = $derived($loreRevisions);
	let branches = $derived($loreBranches);
	let fileDiff = $derived($loreFileDiff);
	let isLoading = $derived($loreLoading);
	let health = $derived($loreHealth);
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

	async function handleOpen(path: string) {
		selectedPath = path;
		selectedFileInfo = files.find(f => f.path === path) || null;
		fileContent = null;
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

	function handleContextMenu(path: string, event: MouseEvent) {
		event.preventDefault();
		// TODO: context menu
	}

	async function handleCreateBranch(name: string, from: string) {
		// TODO: wire createLoreBranch
		await loadLoreHistory();
	}

	async function handleDeleteBranch(name: string) {
		// TODO: wire delete branch
		await loadLoreHistory();
	}

	async function handleSwitchBranch(name: string) {
		currentBranch = name;
		await loadLoreRepo();
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
				<div class="lore-error">Lore service unavailable</div>
			{:else if isLoading}
				<div class="lore-loading">Connecting to Lore...</div>
			{:else}
				<div class="lore-prompt">No Lore repository connected to this channel</div>
			{/if}
		</div>
	{:else}
		<div class="lore-top-bar">
			<span class="repo-name">{repo.repoName}</span>
			<LoreBranchPicker
				branches={pickerBranches}
				currentBranch={currentBranch}
				onCreate={handleCreateBranch}
				onDelete={handleDeleteBranch}
				onSwitch={handleSwitchBranch}
			/>
			<span class="lore-health" class:healthy={health === 'ok'} class:error={health === 'error'}>
				{health || '...'}
			</span>
		</div>

		<div class="lore-tabs">
			<button class="tab {activeTab === 'files' ? 'active' : ''}" onclick={() => activeTab = 'files'}>Files</button>
			<button class="tab {activeTab === 'history' ? 'active' : ''}" onclick={() => activeTab = 'history'}>History</button>
			<button class="tab {activeTab === 'diff' ? 'active' : ''}" onclick={() => activeTab = 'diff'}>Diff</button>
		</div>

		<div class="lore-panels">
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
						<LoreFileViewer
							filePath={selectedPath}
							{fileContent}
							fileInfo={selectedFileInfo}
							loading={isLoading}
							onClose={() => { selectedPath = null; fileContent = null; }}
						/>
					{:else}
						<div class="viewer-placeholder">Select a file to view</div>
					{/if}
				</div>
			{:else if activeTab === 'history'}
				<div class="panel-full">
					<LoreHistoryPanel
						revisions={historyRevisions}
						branches={pickerBranches}
						loading={isLoading}
						onRevisionSelect={(hash: string) => {}}
						onCompare={(from: string, to: string) => {
							activeTab = 'diff';
						}}
					/>
				</div>
			{:else if activeTab === 'diff'}
				<div class="panel-full">
					{#if fileDiff}
						<LoreDiffViewer
							diff={fileDiff}
							mode={diffMode}
							onModeChange={(m) => diffMode = m}
						/>
					{:else}
						<div class="diff-placeholder">Select two revisions in History to compare</div>
					{/if}
				</div>
			{/if}
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
		color: var(--text-muted);
	}

	.lore-error {
		color: var(--color-danger, #ef4444);
	}

	.lore-top-bar {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-1) var(--space-2);
		background: var(--surface-raised);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
	}

	.repo-name {
		color: var(--text-heading);
		font-weight: 600;
		font-size: var(--font-size-sm);
	}

	.lore-health {
		margin-left: auto;
		font-size: var(--font-size-xs);
		color: var(--text-muted);
	}

	.lore-health.healthy {
		color: var(--color-success, #22c55e);
	}

	.lore-health.error {
		color: var(--color-danger, #ef4444);
	}

	.lore-tabs {
		display: flex;
		gap: 0;
		background: var(--surface-sunken);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
	}

	.tab {
		padding: var(--space-1) var(--space-3);
		background: transparent;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--text-muted);
		cursor: pointer;
		font-size: var(--font-size-sm);
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
	}

	.panel-full {
		flex: 1;
		overflow: hidden;
	}

	.viewer-placeholder, .diff-placeholder {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		color: var(--text-muted);
		font-size: var(--font-size-sm);
	}
</style>