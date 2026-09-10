<script lang="ts">
	/** Lore workspace — channel-backed repo-first Code view.
	 *
	 * Channels ARE repos. The selected lore channel is the target; no repo rail.
	 * Current lore channel wins, then localStorage:wabi:lastLoreChannelId, then
	 * first lore channel. Selection is persisted on every change.
	 */
	import { onMount } from 'svelte';
	import { currentChannel, channels } from '$lib/socket';
	import { switchChannel } from '$lib/channelStore';
	import { layoutStore } from '$lib/layoutStore';
	import LoreChannelShell from './lore/LoreChannelShell.svelte';
	import { getAuthToken } from '$lib/authSession';
	import { getLoreRepo, getLoreRepoHistory, getLoreBranches, listLoreFiles, getSignedLoreUrl, reviewLoreBranch, updateLoreRepoSettings, parseLoreChannelId, type LoreRepo, type LoreRevision, type LoreBranch, type LoreFileInfo } from '$lib/api/lore';
import { loreArtifactKind } from '$lib/loreArtifactCompare';
import LoreImageCompare from './lore/LoreImageCompare.svelte';

	// Store auto-subscription inside $derived (NOT get(): a one-shot read
	// froze these at mount — the hub then kept showing one project forever
	// while the user switched channels, and channels created later never
	// appeared in the picker. 2026-09-04 "all channels same repo" report).
	let activeChannelId = $derived($currentChannel);
	let allChannels = $derived($channels);

	let loreChannels = $derived(allChannels.filter((c) => (c.type as string | undefined) === 'lore'));

	let selectedId = $state<string | null>(null);
	let activeTab = $state<'overview' | 'files' | 'history' | 'review' | 'settings'>('overview');

	// Repo metadata for the selected channel.
	let repoMeta = $state<LoreRepo | null>(null);
	let repoLoading = $state(false);
	let repoHistory = $state<LoreRevision[]>([]);
	let repoBranches = $state<LoreBranch[]>([]);
	let repoFiles = $state<LoreFileInfo[]>([]);
	let compareImagePath = $state<string | null>(null);
	let compareImageUrls = $state<{ before: string; after: string } | null>(null);
	let dataLoading = $state(false);
	let dataError = $state('');
	let settingsSaving = $state(false);

	const LAST_LORE_KEY = 'wabi:lastLoreChannelId';

	function persistSelection(id: string): void {
		try {
			localStorage.setItem(LAST_LORE_KEY, id);
		} catch {
			/* storage disabled */
		}
	}

	function selectChannel(id: string): void {
		selectedId = id;
		persistSelection(id);
		switchChannel(id);
		layoutStore.closeRightPanel();
		void loadRepoMeta(id);
	}

	function openCreateForm(): void {
		window.dispatchEvent(new CustomEvent('wabi:create-channel', { detail: { type: 'lore' } }));
	}

	async function loadRepoMeta(channelId: string): Promise<void> {
		const token = getAuthToken();
		const numericId = parseLoreChannelId(channelId);
		if (!token || !numericId) {
			repoMeta = null;
			return;
		}
		repoLoading = true;
		try {
			repoMeta = await getLoreRepo(token, numericId);
			dataLoading = true;
			dataError = '';
			const [history, branches] = await Promise.all([
				getLoreRepoHistory(token, numericId),
				getLoreBranches(token, numericId)
			]);
			repoHistory = history;
			repoBranches = branches;
			repoFiles = await listLoreFiles(token, numericId);
		} catch {
			dataError = 'Repository data could not be loaded.';
		} finally {
			repoLoading = false;
			dataLoading = false;
		}
	}

	async function decideReview(branchName: string, decision: 'approve' | 'reject'): Promise<void> {
		const token = getAuthToken();
		const numericId = selectedId ? parseLoreChannelId(selectedId) : null;
		if (!token || !numericId) return;
		try {
			await reviewLoreBranch(token, numericId, branchName, decision);
			await loadRepoMeta(selectedId as string);
		} catch {
			dataError = 'Review action failed. Check your permissions and try again.';
		}
	}

	async function toggleReviewWorkflow(enabled: boolean): Promise<void> {
		const token = getAuthToken();
		const numericId = selectedId ? parseLoreChannelId(selectedId) : null;
		if (!token || !numericId || !repoMeta) return;
		settingsSaving = true;
		try { repoMeta = await updateLoreRepoSettings(token, numericId, { auto_branch_on_upload: enabled }); }
		catch { dataError = 'Repository settings could not be saved.'; }
		finally { settingsSaving = false; }
	}


	async function prepareImageCompare(path: string): Promise<void> {
		const token = getAuthToken();
		const numericId = selectedId ? parseLoreChannelId(selectedId) : null;
		if (!token || !numericId || repoHistory.length < 2) return;
		compareImagePath = path;
		try {
			const [before, after] = await Promise.all([
				getSignedLoreUrl(token, numericId, path, repoHistory[1].hash),
				getSignedLoreUrl(token, numericId, path, repoHistory[0].hash)
			]);
			compareImageUrls = { before, after };
		} catch { dataError = 'This artwork could not be compared yet.'; }
	}

	function formatRevTs(ts: number): string {
		return Number.isFinite(ts) && ts > 0 ? new Date(ts).toLocaleString() : '\u2014';
	}

	function repoLabel(repo: LoreRepo | null): string {
		if (repoLoading) return 'Loading…';
		if (repo?.repoName) return repo.repoName;
		return 'No repository connected';
	}

	function repoKind(repo: LoreRepo | null): 'native' | 'mirror' | 'imported' | null {
		if (!repo) return null;
		const kind = typeof repo.class === 'string' ? repo.class : null;
		if (kind === 'mirror' || (repo.class && typeof repo.class === 'object' && 'mirror' in repo.class)) return 'mirror';
		if (kind === 'imported' || repo.imported_from) return 'imported';
		return 'native';
	}

	onMount(() => {
		let saved: string | null = null;
		try {
			saved = localStorage.getItem(LAST_LORE_KEY);
		} catch {
			/* storage disabled */
		}
		const currentLore = loreChannels.some((c) => c.id === activeChannelId)
			? activeChannelId
			: null;
		const target =
			currentLore ??
			(saved && loreChannels.some((c) => c.id === saved) ? saved : null) ??
			loreChannels[0]?.id ??
			null;
		if (target) {
			selectedId = target;
			persistSelection(target);
			void loadRepoMeta(target);
		}
	});

	// Reload repo meta when the selected channel changes from outside.
	$effect(() => {
		if (activeChannelId && loreChannels.some((channel) => channel.id === activeChannelId)) {
			if (selectedId !== activeChannelId) {
				selectedId = activeChannelId;
				persistSelection(activeChannelId);
			}
		}
		if (selectedId) void loadRepoMeta(selectedId);
	});
</script>

{#if loreChannels.length === 0}
	<div class="lore-workspace">
		<header class="lore-workspace-header">
			<div class="lore-workspace-title">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="28" height="28">
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
					<polyline points="14 2 14 8 20 8"/>
					<line x1="16" y1="13" x2="8" y2="13"/>
					<line x1="16" y1="17" x2="8" y2="17"/>
					<path d="M10 9H8"/>
				</svg>
				<div>
					<h2>Project</h2>
					<p>Versioned repositories — browse files, history, diffs, and scripts</p>
				</div>
			</div>
			<button class="new-code-btn" onclick={openCreateForm} title="Create a project channel">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
					<line x1="12" y1="5" x2="12" y2="19"/>
					<line x1="5" y1="12" x2="19" y2="12"/>
				</svg>
				New Project Channel
			</button>
		</header>

		<div class="lore-empty">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" width="64" height="64">
				<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
				<polyline points="14 2 14 8 20 8"/>
				<line x1="16" y1="13" x2="8" y2="13"/>
				<line x1="16" y1="17" x2="8" y2="17"/>
			</svg>
			<h3>No project channels yet</h3>
			<p>Create a Project channel to start a versioned repository — browse files, commit history, and diffs right inside Wabi.</p>
			<button class="new-code-btn" onclick={openCreateForm}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
					<line x1="12" y1="5" x2="12" y2="19"/>
					<line x1="5" y1="12" x2="19" y2="12"/>
				</svg>
				Create your first Project channel
			</button>
			<p class="lore-empty-hint">Uses Epic Games Lore — a fully open-source version control system. No cloud, no third party.</p>
		</div>
	</div>
{:else}
	<div class="lore-workspace">
		<!-- Repo header -->
		<header class="repo-header">
			<div class="repo-identity">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="22" height="22">
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
					<polyline points="14 2 14 8 20 8"/>
				</svg>
				<div class="repo-name-group">
					<span class="repo-name">{repoLabel(repoMeta)}</span>
					{#if repoKind(repoMeta) === "native"}
						<span class="repo-badge repo-native">Native</span>
					{:else if repoKind(repoMeta) === "mirror"}
						<span class="repo-badge repo-mirror">Mirror</span>
					{:else if repoKind(repoMeta) === "imported"}
						<span class="repo-badge repo-imported">Imported</span>
					{/if}
				</div>
			</div>

			<div class="repo-controls">
				<div class="channel-select-wrap">
					<select
						class="channel-select"
						value={selectedId ?? undefined}
						onchange={(e) => {
							const id = (e.target as HTMLSelectElement).value;
							if (id) selectChannel(id);
						}}
					>
						{#each loreChannels as ch}
							<option value={ch.id}>{ch.name}</option>
						{/each}
					</select>
				<svg class="select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
					<polyline points="6 9 12 15 18 9"/>
				</svg>
			</div>
			<button class="new-code-btn small" onclick={openCreateForm} title="Create a project channel">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
					<line x1="12" y1="5" x2="12" y2="19"/>
					<line x1="5" y1="12" x2="19" y2="12"/>
				</svg>
				New
			</button>
		</div>
	</header>

	<!-- Tabs -->
	<nav class="repo-tabs">
		<button class="repo-tab" class:active={activeTab === "overview"} onclick={() => activeTab = "overview"}>
			Overview
		</button>
		<button class="repo-tab" class:active={activeTab === "files"} onclick={() => activeTab = "files"}>
			Files
		</button>
		<button class="repo-tab" class:active={activeTab === "history"} onclick={() => activeTab = "history"}>
			History
		</button>
		<button class="repo-tab" class:active={activeTab === "review"} onclick={() => activeTab = "review"}>
			Review
		</button>
		<button class="repo-tab" class:active={activeTab === "settings"} onclick={() => activeTab = "settings"}>
			Settings
		</button>
	</nav>

	<!-- Tab content -->
	<div class="repo-content">
		{#if activeTab === "overview"}
			<div class="overview-layout">
				<div class="overview-card">
					<h3>Repository</h3>
					<p class="overview-line">
						<span class="overview-label">Channel</span>
						<span class="overview-value">{loreChannels.find((c) => c.id === selectedId)?.name ?? "Unknown"}</span>
					</p>
					<p class="overview-line">
						<span class="overview-label">Repo name</span>
						<span class="overview-value">{repoMeta?.repoName ?? (repoLoading ? "Loading…" : "No repository connected")}</span>
					</p>
					{#if repoMeta?.auto_branch_on_upload}
					<p class="overview-line">
						<span class="overview-label">Workflow</span>
						<span class="overview-value">Uploads require review</span>
					</p>
					{/if}
					<p class="overview-description">
						This channel hosts a versioned repository powered by Lore. Browse files, inspect history, and collaborate on code right inside Wabi.
					</p>
					<button class="overview-files-btn" onclick={() => activeTab = "files"}>
						Browse Files
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
							<path d="M5 12h14"/>
							<path d="M12 5l7 7-7 7"/>
						</svg>
					</button>
				</div>
			</div>
		{:else if activeTab === "files"}
			<div class="files-tab">
				<!-- Bind the shell to the hub's resolved lore channel: the hub can be
				     open while a non-lore channel is globally active, and an unbound
				     shell silently targeted the wrong repo (ghost-channel bug). -->
				<LoreChannelShell channelKey={selectedId} />
			</div>
		{:else if activeTab === "history"}
			{#if compareImageUrls && compareImagePath}
				<div class="compare-panel"><button type="button" class="back-button" onclick={() => { compareImageUrls = null; compareImagePath = null; }}>← Back to history</button><h3>{compareImagePath}</h3><LoreImageCompare before={compareImageUrls.before} after={compareImageUrls.after} beforeLabel="Previous revision" afterLabel="Current revision" /></div>
			{:else}
			<div class="history-tab">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" width="48" height="48">
					<circle cx="12" cy="12" r="10"/>
					<polyline points="12 6 12 12 16 14"/>
				</svg>
				<h3>Commit History</h3>
				{#if dataError}<p class="repo-error">{dataError}</p>{/if}
				{#if dataLoading}<p>Loading history…</p>{:else if repoHistory.length === 0}<p>No revisions yet.</p>{:else}<ul>{#each repoHistory.slice(0, 20) as revision}<li><strong>{revision.hash.slice(0, 8)}</strong><span>{revision.message}</span><small>{formatRevTs(revision.timestamp)}</small></li>{/each}</ul>{/if}
				{#each repoFiles.filter((file) => loreArtifactKind(file.path) === 'image').slice(0, 12) as file}
					<button type="button" class="compare-art" onclick={() => void prepareImageCompare(file.path)}>Compare artwork · {file.path}</button>
				{/each}
			</div>
			{/if}
		{:else if activeTab === "review"}
			<div class="placeholder-tab">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" width="48" height="48">
					<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
					<circle cx="8.5" cy="7" r="4"/>
					<line x1="20" y1="8" x2="20" y2="14"/>
					<line x1="23" y1="11" x2="17" y2="11"/>
				</svg>
				<h3>Review</h3>
				{#if repoBranches.filter((branch) => typeof branch.name === 'string' && branch.name.startsWith('uploads/')).length === 0}<p>No upload branches are waiting for review.</p>{:else}<p>Approve to make uploads official, or reject to retire the upload branch.</p>{#each repoBranches.filter((branch) => typeof branch.name === 'string' && branch.name.startsWith('uploads/')) as branch}<div class="review-row"><strong>{branch.name}</strong><span><button type="button" onclick={() => void decideReview(branch.name, 'approve')}>Approve</button><button type="button" onclick={() => void decideReview(branch.name, 'reject')}>Reject</button></span></div>{/each}{/if}
			</div>
		{:else if activeTab === "settings"}
			<div class="placeholder-tab">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" width="48" height="48">
					<circle cx="12" cy="12" r="3"/>
					<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68 1.65 1.65 0 0 0 10 3.17V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
				</svg>
				<h3>Repository Settings</h3>
				{#if repoMeta}
					<label class="setting-toggle"><input type="checkbox" checked={repoMeta.auto_branch_on_upload === true} disabled={settingsSaving} onchange={(event) => void toggleReviewWorkflow((event.currentTarget as HTMLInputElement).checked)} /> Require review for uploads</label>
					<p>{repoMeta.imported_from ? `Imported from ${repoMeta.imported_from}` : 'Native Lore repository'}</p>
				{:else}<p>No repository is connected to this channel.</p>{/if}
			</div>
		{/if}
	</div>
	</div>
{/if}

<style>
	.lore-workspace {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		padding: var(--space-3);
		gap: var(--space-3);
	}

	.lore-workspace-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		padding-bottom: var(--space-2);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
	}

	.lore-workspace-title {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.lore-workspace-title svg {
		color: var(--accent-primary);
	}

	.lore-workspace-title h2 {
		margin: 0;
		font-size: var(--font-size-lg);
		color: var(--text-heading);
	}

	.lore-workspace-title p {
		margin: 0;
		font-size: var(--font-size-xs);
		color: var(--text-muted);
	}

	.new-code-btn {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: var(--space-1) var(--space-3);
		border-radius: var(--radius-sm);
		background: var(--accent-primary);
		color: white;
		border: none;
		cursor: pointer;
		font-size: var(--font-size-sm);
		font-weight: 600;
		transition: background var(--duration-fast) var(--ease-out);
		white-space: nowrap;
	}

	.new-code-btn:hover {
		background: var(--accent-secondary);
	}

	.new-code-btn.small {
		padding: 4px var(--space-2);
		font-size: var(--font-size-xs);
	}

	.lore-empty {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		text-align: center;
		color: var(--text-muted);
	}

	.lore-empty svg {
		opacity: 0.4;
	}

	.lore-empty h3 {
		margin: 0;
		font-size: var(--font-size-lg);
		color: var(--text-heading);
	}

	.lore-empty p {
		margin: 0;
		max-width: 420px;
		font-size: var(--font-size-sm);
		line-height: 1.6;
	}

	.lore-empty-hint {
		font-size: var(--font-size-xs) !important;
		opacity: 0.8;
	}

	/* Repo header */
	.repo-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		padding-bottom: var(--space-2);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		flex-shrink: 0;
	}

	.repo-identity {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
	}

	.repo-identity > svg {
		color: var(--accent-primary);
		flex-shrink: 0;
	}

	.repo-name-group {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		min-width: 0;
	}

	.repo-name {
		font-weight: 600;
		font-size: var(--font-size-md);
		color: var(--text-heading);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.repo-badge {
		font-size: var(--font-size-2xs);
		font-weight: 600;
		padding: 2px 6px;
		border-radius: var(--radius-full);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		flex-shrink: 0;
	}

	.repo-native {
		background: color-mix(in srgb, var(--accent-primary) 15%, transparent);
		color: var(--accent-secondary);
	}

	.repo-mirror {
		background: color-mix(in srgb, #f59e0b 15%, transparent);
		color: var(--color-warning, #f59e0b);
	}

	.repo-imported {
		background: color-mix(in srgb, #22c55e 15%, transparent);
		color: var(--color-success, #22c55e);
	}

	.repo-controls {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		flex-shrink: 0;
	}

	.channel-select-wrap {
		position: relative;
		display: flex;
		align-items: center;
	}

	.channel-select {
		appearance: none;
		background: var(--surface-sunken);
		border: 1px solid color-mix(in srgb, var(--text-muted) 20%, transparent);
		color: var(--text-heading);
		border-radius: var(--radius-sm);
		padding: 4px 28px 4px var(--space-2);
		font-size: var(--font-size-sm);
		font-family: var(--font-sans);
		cursor: pointer;
		max-width: 200px;
	}

	.channel-select:focus {
		outline: none;
		border-color: color-mix(in srgb, var(--accent-primary) 50%, transparent);
	}

	.select-chevron {
		position: absolute;
		right: 8px;
		pointer-events: none;
		color: var(--text-muted);
	}

	/* Tabs */
	.repo-tabs {
		display: flex;
		gap: 0;
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		flex-shrink: 0;
	}

	.repo-tab {
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

	.repo-tab:hover {
		color: var(--text-heading);
	}

	.repo-tab.active {
		color: var(--accent-primary);
		border-bottom-color: var(--accent-primary);
	}

	/* Tab content */
	.repo-content {
		flex: 1;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.history-tab { max-width: 900px; margin: var(--space-4) auto; padding: var(--space-4); color: var(--text-muted); overflow-y: auto; }
	.history-tab ul { display: grid; gap: var(--space-1); margin: var(--space-3) 0 0; padding: 0; list-style: none; }
	.history-tab li, .review-row { display: flex; align-items: center; gap: var(--space-2); justify-content: space-between; padding: var(--space-2); border: 1px solid color-mix(in srgb, var(--text-muted) 12%, transparent); border-radius: var(--radius-md); background: var(--surface-base); }
	.history-tab li span { flex: 1; color: var(--text-heading); }
	.history-tab li small { color: var(--text-muted); }
	.review-row { margin-top: var(--space-2); }
	.review-row button { margin-left: var(--space-1); padding: var(--space-1) var(--space-2); border: 1px solid color-mix(in srgb, var(--accent-primary) 35%, transparent); border-radius: var(--radius-sm); background: transparent; color: var(--text-heading); cursor: pointer; }
	.repo-error { color: var(--color-danger, var(--text-muted)); }
	.compare-panel { display: flex; flex-direction: column; min-height: 0; height: 100%; gap: var(--space-2); padding: var(--space-3); }
	.compare-panel h3 { margin: 0; color: var(--text-heading); font-size: var(--font-size-sm); }
	.compare-panel :global(.image-compare) { min-height: 0; flex: 1; }
	.back-button, .compare-art { align-self: flex-start; padding: var(--space-1) var(--space-2); border: 1px solid color-mix(in srgb, var(--text-muted) 20%, transparent); border-radius: var(--radius-sm); background: transparent; color: var(--text-heading); cursor: pointer; }
	.compare-art { display: block; margin-top: var(--space-1); color: var(--accent-secondary); }

	.files-tab {
		flex: 1;
		overflow: hidden;
	}

	.overview-layout {
		flex: 1;
		overflow-y: auto;
		padding: var(--space-3);
	}

	.overview-card {
		max-width: 520px;
		background: var(--surface-raised);
		border: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		border-radius: var(--radius-md);
		padding: var(--space-3);
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.overview-card h3 {
		margin: 0;
		font-size: var(--font-size-md);
		color: var(--text-heading);
	}

	.overview-line {
		display: flex;
		justify-content: space-between;
		gap: var(--space-2);
		margin: 0;
		font-size: var(--font-size-sm);
	}

	.overview-label {
		color: var(--text-muted);
	}

	.overview-value {
		color: var(--text-heading);
		font-weight: 500;
	}

	.overview-description {
		margin: 0;
		font-size: var(--font-size-sm);
		color: var(--text-secondary);
		line-height: 1.6;
	}

	.overview-files-btn {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: var(--space-1) var(--space-3);
		border-radius: var(--radius-sm);
		background: var(--accent-primary);
		color: white;
		border: none;
		cursor: pointer;
		font-size: var(--font-size-sm);
		font-weight: 600;
		align-self: flex-start;
		transition: background var(--duration-fast) var(--ease-out);
	}

	.overview-files-btn:hover {
		background: var(--accent-secondary);
	}

	.setting-toggle { display: flex; align-items: center; gap: var(--space-2); color: var(--text-heading); }
	.placeholder-tab {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		text-align: center;
		color: var(--text-muted);
	}

	.placeholder-tab svg {
		opacity: 0.4;
	}

	.placeholder-tab h3 {
		margin: 0;
		font-size: var(--font-size-lg);
		color: var(--text-heading);
	}

	.placeholder-tab p {
		margin: 0;
		max-width: 320px;
		font-size: var(--font-size-sm);
		line-height: 1.6;
	}
</style>
