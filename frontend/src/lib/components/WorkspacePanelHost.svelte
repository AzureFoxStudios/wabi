<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import type { WorkspacePanelManifest } from '$lib/workspacePanels';
	import UserListTab from './UserListTab.svelte';
	import CallsPanel from './CallsPanel.svelte';
	import MediaAlbumsTab from './MediaAlbumsTab.svelte';
	import KeepNotesView from './KeepNotesView.svelte';
	import MapWorkspace from './MapWorkspace.svelte';
	import AddonFallbackPanel from './AddonFallbackPanel.svelte';
	import ModelViewportTab from './ModelViewportTab.svelte';
	import ReaderTab from './ReaderTab.svelte';
	import FfxivReferencePanel from './FfxivReferencePanel.svelte';
	import TransferCenter from './TransferCenter.svelte';
	import DMTab from './DMTab.svelte';
	import AdminTab from './AdminTab.svelte';
	import LoreCodePanel from './lore/LoreCodePanel.svelte';
	import WhiteboardLayerPanel from './WhiteboardLayerPanel.svelte';
	import TaskPanel from './business/TaskPanel.svelte';
	import WikiChannel from './WikiChannel.svelte';
	import ForumChannel from './ForumChannel.svelte';
	import { channels, currentChannel, switchChannel } from '$lib/socket';

	export let panel: WorkspacePanelManifest;

	// Channel-scoped panels (wiki/forum): unlike workspace/addon panels such as
	// 'code' (LoreCodePanel repo browser), these render the CURRENT channel's
	// surface via the shared $currentChannel store. If the active channel is
	// not of the matching type, fall back to a small channel picker.
	$: activePanelChannel = $channels.find((ch) => ch.id === $currentChannel) || null;
	$: wikiChannels = $channels.filter((ch) => ch.type === 'wiki');
	$: forumChannels = $channels.filter((ch) => ch.type === 'forum');

	const dispatch = createEventDispatcher<{
		openSettings: { paymentSurface: 'connections' };
	}>();
</script>

{#if panel.component === 'users'}
	<UserListTab />
{:else if panel.component === 'calls'}
	<CallsPanel />
{:else if panel.component === 'dms'}
	<DMTab />
{:else if panel.component === 'notes'}
	<!-- N2: real notes panel (not DMTab / NOTES_DM_ID fake conversation) -->
	<KeepNotesView compact />
{:else if panel.component === 'whiteboard-layers'}
	<WhiteboardLayerPanel />
{:else if panel.component === 'map'}
	<MapWorkspace variant="compact" />
{:else if panel.component === 'media'}
	<MediaAlbumsTab variant="compact" />
{:else if panel.component === 'admin'}
	<!-- Design law: right = ambient staff ops. The Admin Ops Rail stays in the
	     right panel; "Open full dashboard" inside it flips the center stage. -->
	<AdminTab />
{:else if panel.component === 'model-viewport'}
	<ModelViewportTab />
{:else if panel.component === 'reader'}
	<ReaderTab />
{:else if panel.component === 'ffxiv-reference'}
	<FfxivReferencePanel />
{:else if panel.component === 'transfers'}
	<TransferCenter />
{:else if panel.component === 'code'}
	<LoreCodePanel />
{:else if panel.component === 'planner-tasks'}
	<!-- Planner Tasks in the right dock: compact TaskPanel, no close button
	     (the dock owns open/close). Shares the same store as the Planner. -->
	<TaskPanel compact />
{:else if panel.component === 'wiki'}
	{#if activePanelChannel?.type === 'wiki'}
		<div class="right-panel-embedded">
			<WikiChannel />
		</div>
	{:else if wikiChannels.length > 0}
		<div class="channel-picker">
			<div class="channel-picker-heading">Wiki channels</div>
			<div class="channel-picker-sub">Pick a wiki channel to view it here.</div>
			{#each wikiChannels as ch (ch.id)}
				<button type="button" class="channel-picker-item" on:click={() => switchChannel(ch.id)}>
					<span class="channel-picker-name">{ch.name}</span>
				</button>
			{/each}
		</div>
	{:else}
		<div class="channel-picker">
			<div class="channel-picker-heading">Wiki channels</div>
			<div class="channel-picker-sub">No wiki channels on this server yet.</div>
		</div>
	{/if}
{:else if panel.component === 'forum'}
	{#if activePanelChannel?.type === 'forum'}
		<div class="right-panel-embedded">
			<ForumChannel />
		</div>
	{:else if forumChannels.length > 0}
		<div class="channel-picker">
			<div class="channel-picker-heading">Forum channels</div>
			<div class="channel-picker-sub">Pick a forum channel to view it here.</div>
			{#each forumChannels as ch (ch.id)}
				<button type="button" class="channel-picker-item" on:click={() => switchChannel(ch.id)}>
					<span class="channel-picker-name">{ch.name}</span>
				</button>
			{/each}
		</div>
	{:else}
		<div class="channel-picker">
			<div class="channel-picker-heading">Forum channels</div>
			<div class="channel-picker-sub">No forum channels on this server yet.</div>
		</div>
	{/if}
{:else}
	<AddonFallbackPanel {panel} />
{/if}

<style>
	.channel-picker {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		padding: 0.75rem;
		overflow-y: auto;
	}
	.channel-picker-heading {
		color: var(--text-heading);
		font-size: var(--font-size-sm);
		font-weight: 600;
	}
	.channel-picker-sub {
		color: var(--text-muted);
		font-size: var(--font-size-xs);
		margin-bottom: 0.25rem;
	}
	.channel-picker-item {
		width: 100%;
		text-align: left;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--text-secondary);
		font-size: var(--font-size-sm);
		padding: 0.5rem 0.6rem;
		cursor: pointer;
	}
	.channel-picker-item:hover {
		background: var(--surface-hover);
		color: var(--text-heading);
		border-color: var(--accent-primary);
	}
	.channel-picker-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		display: block;
	}
	/* Narrow-mode for the forum surface (forum.css is not owned by this
	   change, so the collapse lives here). Mirrors the wiki
	   .right-panel-embedded rules in wiki.css. */
	.right-panel-embedded :global(.forum-body) {
		display: flex;
		flex-direction: column;
		overflow-y: auto;
	}
	.right-panel-embedded :global(.forum-category-pane) {
		max-height: 180px;
		border-right: 0;
		border-bottom: 1px solid var(--border-subtle);
		flex-shrink: 0;
	}
	.right-panel-embedded :global(.forum-reading-pane) {
		overflow: visible;
	}
</style>
