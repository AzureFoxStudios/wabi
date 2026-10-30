<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import type { WorkspacePanelManifest } from '$lib/workspacePanels';
	import type { Channel } from '$lib/socket-types';
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
	import Icon from './ui/Icon.svelte';
	import { channels, currentChannel } from '$lib/socket';
	import { choosePanelChannel, panelChannelChoice, resolvePanelChannel } from '$lib/workspacePanels';

	export let panel: WorkspacePanelManifest;

	// Wiki and Forum companions (§8.4): with one channel of the kind, open it directly; with
	// several, a picker of 40px rows with the real kind glyphs. The choice lives in a store so the
	// frame's "Open in center stage" opens the same channel and a re-mounted panel keeps it.
	$: wikiChannels = $channels.filter((ch) => ch.type === 'wiki');
	$: forumChannels = $channels.filter((ch) => ch.type === 'forum');
	$: wikiPanelChannelId = resolvePanelChannel($panelChannelChoice.wiki, wikiChannels, $currentChannel);
	$: forumPanelChannelId = resolvePanelChannel($panelChannelChoice.forum, forumChannels, $currentChannel);
	// Latch what the panel opened on, so moving around the stage does not change what it reads.
	$: if (panel.component === 'wiki' && wikiPanelChannelId && !$panelChannelChoice.wiki) choosePanelChannel('wiki', wikiPanelChannelId);
	$: if (panel.component === 'forum' && forumPanelChannelId && !$panelChannelChoice.forum) choosePanelChannel('forum', forumPanelChannelId);
	$: wikiPanelChannel = wikiChannels.find((ch) => ch.id === wikiPanelChannelId) ?? null;
	$: forumPanelChannel = forumChannels.find((ch) => ch.id === forumPanelChannelId) ?? null;

	const dispatch = createEventDispatcher<{
		openSettings: { paymentSurface?: 'connections' } | undefined;
	}>();
</script>

{#snippet channelCompanion(kind: 'wiki' | 'forum', ofKind: Channel[], openId: string | null, open: Channel | null)}
	{@const glyph = kind === 'wiki' ? 'book' : 'forum'}
	{@const noun = kind === 'wiki' ? 'wiki' : 'forum'}
	{#if openId}
		<!-- Row B of the frame: what this companion is reading, and the way back to the list. -->
		<div class="w-panel__b panel-channel-bar">
			<span class="panel-channel-name">
				<Icon name={glyph} size={16} />
				<span class="panel-channel-label">{open?.name ?? noun}</span>
			</span>
			{#if ofKind.length > 1}
				<button type="button" class="w-btn w-btn--quiet w-btn--sm panel-channel-back" on:click={() => choosePanelChannel(kind, null)}>
					<Icon name="chevLeft" size={14} />
					{kind === 'wiki' ? 'All wikis' : 'All forums'}
				</button>
			{/if}
		</div>
		<div class="right-panel-embedded">
			{#if kind === 'wiki'}
				<WikiChannel channelId={openId} draftSurface="panel" />
			{:else}
				<ForumChannel channelId={openId} draftSurface="panel" />
			{/if}
		</div>
	{:else if ofKind.length > 0}
		<div class="w-panel__b panel-channel-bar">
			<span class="panel-channel-hint">Choose a {noun} to read beside the page.</span>
		</div>
		<ul class="channel-picker" aria-label={kind === 'wiki' ? 'Wiki channels' : 'Forum channels'}>
			{#each ofKind as ch (ch.id)}
				<li>
					<button type="button" class="channel-picker-item" on:click={() => choosePanelChannel(kind, ch.id)}>
						<Icon name={glyph} size={18} />
						<span class="channel-picker-name">{ch.name}</span>
					</button>
				</li>
			{/each}
		</ul>
	{:else}
		<div class="w-panel__b panel-channel-bar">
			<span class="panel-channel-hint">Read a {noun} channel beside the page.</span>
		</div>
		<div class="channel-picker-empty">
			<Icon name={glyph} size={28} />
			<p class="channel-picker-empty-title">No {noun} channels yet</p>
			<p class="channel-picker-empty-text">
				{kind === 'wiki'
					? 'A wiki channel shows up here once someone in this community creates one.'
					: 'A forum channel shows up here once someone in this community creates one.'}
			</p>
		</div>
	{/if}
{/snippet}

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
	<div class="channel-companion">
		{@render channelCompanion('wiki', wikiChannels, wikiPanelChannelId, wikiPanelChannel)}
	</div>
{:else if panel.component === 'forum'}
	<div class="channel-companion">
		{@render channelCompanion('forum', forumChannels, forumPanelChannelId, forumPanelChannel)}
	</div>
{:else}
	<AddonFallbackPanel {panel} />
{/if}

<style>
	.channel-companion { display: flex; flex-direction: column; min-height: 0; }
	.right-panel-embedded { flex: 1; min-height: 0; overflow: auto; }
	/* Row B: the channel the companion reads (a place name, so serif would compete with the
	   frame title; it is the label face) and the quiet way back to the list. */
	.panel-channel-bar { justify-content: space-between; }
	.panel-channel-name { display: inline-flex; align-items: center; gap: 8px; min-width: 0; color: var(--w-text); font: var(--w-t-label); }
	.panel-channel-name :global(svg) { flex: none; color: var(--w-sig); }
	.panel-channel-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.panel-channel-back { flex: none; color: var(--w-mute); }
	.panel-channel-hint { color: var(--w-faint); font: var(--w-t-small); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	/* Picker: 40px rows with the kind glyph, the sidebar's selection grammar. */
	.channel-picker { display: flex; flex-direction: column; gap: 1px; margin: 0; padding: 8px 0 16px; list-style: none; overflow-y: auto; }
	.channel-picker-item {
		display: grid;
		grid-template-columns: 20px minmax(0, 1fr);
		align-items: center;
		column-gap: 10px;
		box-sizing: border-box;
		width: calc(100% - 16px);
		height: 40px;
		margin: 0 8px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--w-mute);
		font: var(--w-t-ui);
		text-align: left;
		cursor: pointer;
		transition: background-color var(--w-dur-1) var(--w-ease), color var(--w-dur-1) var(--w-ease);
	}
	.channel-picker-item :global(svg) { justify-self: center; color: var(--w-faint); }
	.channel-picker-item:hover { background: color-mix(in srgb, var(--w-raise) 70%, transparent); color: var(--w-text); }
	.channel-picker-item:hover :global(svg) { color: var(--w-mute); }
	.channel-picker-item:focus-visible { outline: 2px solid var(--w-accent); outline-offset: -2px; }
	:global(:root[data-char='contrast']) .channel-picker-item:hover { background: transparent; box-shadow: inset 0 0 0 1px var(--w-line-strong); }
	.channel-picker-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	/* Empty (§7.16): left-aligned glyph, serif title, one sentence; no box. */
	.channel-picker-empty { padding: 32px 20px; color: var(--w-faint); }
	.channel-picker-empty-title { margin: 12px 0 0; color: var(--w-text); font: 600 calc(20px * var(--w-fs)) / calc(26px * var(--w-fs)) var(--w-serif); }
	.channel-picker-empty-text { margin: 6px 0 0; color: var(--w-mute); font: var(--w-t-ui); text-wrap: pretty; }
	.right-panel-embedded :global(.forum-body) {
		display: flex;
		flex-direction: column;
		overflow-y: auto;
	}
	.right-panel-embedded :global(.forum-category-pane) {
		max-height: 180px;
		border-right: 0;
		border-bottom: var(--w-bw) solid var(--w-line);
		flex-shrink: 0;
	}
	.right-panel-embedded :global(.forum-reading-pane) {
		overflow: visible;
	}
</style>
