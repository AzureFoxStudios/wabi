<script lang="ts">
	import { onMount } from 'svelte';
	import { currentChannel } from '$lib/channelStore';
	import { getAuthToken } from '$lib/authSession';
	import { loreRepo, loreFiles, loadLoreRepo } from '$lib/loreStore';
	import { getSignedLoreUrl, parseLoreChannelId, type LoreFileInfo } from '$lib/api/lore';
	import LoreFileTree from './LoreFileTree.svelte';
	import LoreFileViewer from './LoreFileViewer.svelte';

	let selectedPath = $state<string | null>(null);
	let fileContent = $state<string | null>(null);
	let fileInfo = $state<LoreFileInfo | null>(null);
	let loading = $state(false);
	let loadingFile = $state(false);

	let channelId = $derived(parseLoreChannelId($currentChannel));

	async function refresh() {
		if (!channelId) return;
		loading = true;
		try {
			await loadLoreRepo();
		} catch {
			// repo may not exist yet — stores stay empty, empty state shows
		} finally {
			loading = false;
		}
	}

	async function handleSelect(path: string) {
		selectedPath = path;
		fileInfo = $loreFiles.find((f) => f.path === path) || null;
		fileContent = null;
		loadingFile = true;
		const token = getAuthToken();
		if (!token) {
			loadingFile = false;
			return;
		}
		try {
			const url = await getSignedLoreUrl(token, channelId, path);
			const res = await fetch(url);
			if (res.ok) fileContent = await res.text();
		} catch {
			fileContent = null;
		} finally {
			loadingFile = false;
		}
	}

	function handleOpen(path: string) {
		// In the compact panel, open = show the file (same as select).
		void handleSelect(path);
	}

	function handleContextMenu(_path: string, _event: MouseEvent) {
		// Context menu lives in the center-stage channel shell; panel is read-only.
	}

	onMount(() => {
		void refresh();
	});
</script>

{#if channelId}
	<div class="lore-code-panel">
		<div class="panel-head">
			<span class="panel-title">Project</span>
			{#if $loreRepo}
				<span class="repo-name" title={$loreRepo.repoName}>{$loreRepo.repoName}</span>
			{/if}
			<button type="button" class="refresh-btn" on:click={refresh} title="Refresh repo">↻</button>
		</div>
		{#if loading}
			<div class="panel-empty">Loading repo…</div>
		{:else if !$loreRepo}
			<div class="panel-empty">Open a Project channel to browse its repo.</div>
		{:else}
			<div class="panel-tree">
				<LoreFileTree
					files={$loreFiles}
					selectedPath={selectedPath}
					loading={loading}
					onSelect={handleSelect}
					onOpen={handleOpen}
					onContextMenu={handleContextMenu}
				/>
			</div>
			{#if selectedPath}
				<div class="panel-viewer">
					<LoreFileViewer
						filePath={selectedPath}
						fileContent={loadingFile ? null : fileContent}
						fileInfo={fileInfo}
						loading={loadingFile}
						onClose={() => { selectedPath = null; fileContent = null; }}
						canEdit={true}
						token={getAuthToken() ?? undefined}
						{channelId}
						onSaved={() => { void refresh(); }}
					/>
				</div>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.lore-code-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		gap: 0.5rem;
		padding: 0.5rem;
		box-sizing: border-box;
	}
	.panel-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}
	.panel-title {
		font-weight: 600;
		font-size: 0.9rem;
		color: var(--text-heading, #e0e0ff);
	}
	.repo-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.75rem;
		color: var(--text-muted, #9999ff);
	}
	.refresh-btn {
		flex-shrink: 0;
		width: 26px;
		height: 26px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--surface-base, #24243e);
		border: 1px solid var(--border-color, #2a2a4a);
		border-radius: 6px;
		color: var(--text-secondary, #b3b3ff);
		cursor: pointer;
		font-size: 0.9rem;
		line-height: 1;
		padding: 0;
	}
	.refresh-btn:hover {
		background: var(--surface-raised, #302b63);
		color: var(--text-heading, #e0e0ff);
	}
	.panel-tree {
		flex: 1 1 45%;
		min-height: 0;
		overflow-y: auto;
		background: var(--surface-base, #24243e);
		border: 1px solid var(--border-color, #2a2a4a);
		border-radius: 8px;
		padding: 0.25rem;
	}
	.panel-viewer {
		flex: 1 1 55%;
		min-height: 0;
		overflow: auto;
		background: var(--surface-sunken, #0f0c29);
		border: 1px solid var(--border-color, #2a2a4a);
		border-radius: 8px;
	}
	.panel-empty {
		padding: 1rem 0.5rem;
		text-align: center;
		color: var(--text-muted, #9999ff);
		font-size: 0.8rem;
	}
</style>
