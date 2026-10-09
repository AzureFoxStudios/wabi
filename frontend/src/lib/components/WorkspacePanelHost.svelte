<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import type { WorkspacePanelManifest } from '$lib/workspacePanels';
	import UserListTab from './UserListTab.svelte';
	import ProfilePanel from './ProfilePanel.svelte';
	import CallsPanel from './CallsPanel.svelte';
	import MediaAlbumsTab from './MediaAlbumsTab.svelte';
	import KeepNotesView from './KeepNotesView.svelte';
	import MapWorkspace from '$lib/addons/server-map/MapAddonWorkspace.svelte';
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
	import { channels, currentChannel } from '$lib/socket';

	export let panel: WorkspacePanelManifest;

	let wikiPanelChannelId: string | null = null;
	let forumPanelChannelId: string | null = null;
	$: activePanelChannel = $channels.find((ch) => ch.id === $currentChannel) || null;
	$: wikiChannels = $channels.filter((ch) => ch.type === 'wiki');
	$: forumChannels = $channels.filter((ch) => ch.type === 'forum');

	$: if (activePanelChannel?.type === 'wiki' && wikiPanelChannelId === null) {
		wikiPanelChannelId = activePanelChannel.id;
	}
	$: if (activePanelChannel?.type === 'forum' && forumPanelChannelId === null) {
		forumPanelChannelId = activePanelChannel.id;
	}

	const dispatch = createEventDispatcher<{
		openSettings: { paymentSurface?: 'connections' } | undefined;
	}>();
</script>

{#if panel.component === 'users'}
	<UserListTab on:openSettings={() => dispatch('openSettings', undefined)} />
{:else if panel.component === 'profile'}
	<ProfilePanel />
{:else if panel.component === 'calls'}
	<CallsPanel />
{:else if panel.component === 'dms'}
	<DMTab />
{:else if panel.component === 'notes'}
	<KeepNotesView compact />
{:else if panel.component === 'whiteboard-layers'}
	<WhiteboardLayerPanel />
{:else if panel.component === 'map'}
	<MapWorkspace variant="compact" />
{:else if panel.component === 'media'}
	<MediaAlbumsTab variant="compact" />
{:else if panel.component === 'admin'}
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
	<TaskPanel compact />
{:else if panel.component === 'wiki'}
	{#if wikiPanelChannelId}
		<div class="right-panel-embedded">
			<WikiChannel channelId={wikiPanelChannelId ?? undefined} draftSurface="panel" />
		</div>
	{:else if wikiChannels.length > 0}
		<div class="channel-picker">
			<div class="channel-picker-heading">Wiki channels</div>
			<div class="channel-picker-sub">Pick a wiki channel to view it here.</div>
			{#each wikiChannels as ch (ch.id)}
				<button type="button" class="channel-picker-item" on:click={() => (wikiPanelChannelId = ch.id)}>
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
	{#if forumPanelChannelId}
		<div class="right-panel-embedded">
			<ForumChannel channelId={forumPanelChannelId ?? undefined} draftSurface="panel" />
		</div>
	{:else if forumChannels.length > 0}
		<div class="channel-picker">
			<div class="channel-picker-heading">Forum channels</div>
			<div class="channel-picker-sub">Pick a forum channel to view it here.</div>
			{#each forumChannels as ch (ch.id)}
				<button type="button" class="channel-picker-item" on:click={() => (forumPanelChannelId = ch.id)}>
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
	.channel-picker { display: flex; flex-direction: column; gap: 0; padding: 14px 14px 10px; overflow-y: auto; }
	.channel-picker-heading { font: 600 1.15rem/1.2 var(--w-serif, serif); color: var(--w-text); letter-spacing: .01em; }
	.channel-picker-sub { color: var(--w-mute); font-size: .8rem; margin: 4px 0 12px; }
	.channel-picker-item { width: 100%; text-align: left; border: 0; border-top: var(--w-bw, 1px) solid var(--w-line); border-radius: 0; background: transparent; color: var(--w-text); font: 500 .85rem var(--w-sans); padding: 10px 2px; cursor: pointer; display: flex; align-items: center; gap: 8px; }
	.channel-picker-item::before { content: '#'; color: var(--w-deco); font-family: var(--w-mono); }
	.channel-picker-item:last-child { border-bottom: var(--w-bw, 1px) solid var(--w-line); }
	.channel-picker-item:hover { color: var(--w-accent); }
	.channel-picker-item:focus-visible { outline: 2px solid var(--w-accent); outline-offset: 2px; }
	.channel-picker-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
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
