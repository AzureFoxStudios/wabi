<!--
	Server shortcuts (the "Shortcuts" disclosure inside the server switcher): Recent channels on
	this server and Followed channels across saved servers. A kit segmented key picks the list;
	rows are 44px on roles with the channel's real glyph (§6) and the ink unread badge (§7.9).
	Unfollow is a quiet x key per row. No emoji or text glyphs stand in for icons.
	The floating toggle-and-popover mode is gone: the switcher embeds this list, the only caller.
-->
<script lang="ts">
	import { channelUnreadCounts, channels, currentChannel, joinVoiceChannel, switchChannel } from '$lib/socket';
	import { mobileTabQueue, type MobileQueueTab } from '$lib/mobileTabQueue';
	import { currentSavedServer, savedServers, switchToSavedServerChannel } from '$lib/savedServers';
	import { allServerFollowedChannels, getCurrentFollowServerUrl, unfollowChannel } from '$lib/following';
	import { followedChannelSnapshots } from '$lib/followingSnapshots';
	import { isServerScopedChannel } from '$lib/channelTypes';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Segmented from '$lib/components/ui/Segmented.svelte';
	import type { IconName } from '$lib/components/ui/icons';
	import { buildChannelItem, buildFollowedServerGroups, followedServerGroupBodyId, type DrawerChannelItem } from './modeTabsDrawerHelpers';
	import './ModeTabsDrawer.css';

	/** The switcher embeds the list (its only caller); kept so that call site stays valid. */
	export let embedded = true;
	let activeSection: 'recent' | 'saved' = 'recent';
	let collapsedFollowedServerUrls: Record<string, boolean> = {};
	const { tabs: queueTabs } = mobileTabQueue;

	$: serverScopedChannels = $channels.filter(isServerScopedChannel);
	$: channelById = new Map(serverScopedChannels.map((channel) => [channel.id, channel] as const));
	$: activeFollowServerUrl = getCurrentFollowServerUrl();
	$: snapshotByKey = new Map($followedChannelSnapshots.map((snapshot) => [`${snapshot.serverUrl}::${snapshot.channelId}`, snapshot] as const));
	$: followedServerGroups = (buildFollowedServerGroups as any)($allServerFollowedChannels, $savedServers, snapshotByKey, activeFollowServerUrl, $currentSavedServer, channelById, $channelUnreadCounts, $currentChannel);
	$: recentChannelItems = ($queueTabs as any).filter((item): item is Extract<MobileQueueTab, { type: 'channel' }> => item.type === 'channel').map((item) => { const channel = channelById.get(item.channelId); if (!channel) return null; return buildChannelItem(channel as any, 'recent', activeFollowServerUrl, $currentChannel, $channelUnreadCounts); }).filter((item): item is DrawerChannelItem => item !== null);
	$: followedCount = followedServerGroups.reduce((sum, group) => sum + group.channels.length, 0);
	$: recentCount = recentChannelItems.length;
	$: sections = [
		{ value: 'recent' as const, label: recentCount > 0 ? `Recent ${recentCount}` : 'Recent' },
		{ value: 'saved' as const, label: followedCount > 0 ? `Followed ${followedCount}` : 'Followed' }
	];
	$: activeSectionSubtitle = activeSection === 'recent' ? 'Recent channels on this server' : 'Followed channels across your servers';

	/** The channel's own glyph; a text channel is a typeset #. */
	function glyphFor(type: string | null): IconName | null {
		if (type === 'voice') return 'voice';
		if (type === 'wiki') return 'book';
		if (type === 'forum') return 'forum';
		if (type === 'gallery') return 'image';
		return null;
	}
	function badgeText(count: number): string {
		return count > 99 ? '99+' : String(count);
	}

	async function selectChannel(item: DrawerChannelItem): Promise<void> {
		if (item.serverUrl !== activeFollowServerUrl) { switchToSavedServerChannel(item.serverUrl, item.channelId); return; }
		if (item.channelType === 'voice') { try { await joinVoiceChannel(item.channelId); } catch (error) { console.error('Failed to join voice channel from server shortcuts:', error); } return; }
		switchChannel(item.channelId);
	}
	function removeSavedChannel(item: DrawerChannelItem): void { unfollowChannel(item.channelId, item.serverUrl); }
	function setFollowedServerGroupCollapsed(serverUrl: string, collapsed: boolean): void { collapsedFollowedServerUrls = { ...collapsedFollowedServerUrls, [serverUrl]: collapsed }; }
	function isFollowedServerGroupCollapsed(serverUrl: string, collapsed: Record<string, boolean>): boolean { return collapsed[serverUrl] === true; }
</script>

<div class="mode-tabs" class:embedded role="region" aria-label="Server shortcuts">
	<Segmented class="mode-tabs__seg" label="Shortcut list" options={sections} bind:value={activeSection} />
	<p class="mode-tabs__hint">{activeSectionSubtitle}</p>

	{#if activeSection === 'recent'}
		{#if recentChannelItems.length === 0}
			<p class="mode-tabs__empty">Channels you visit show up here so you can jump back quickly.</p>
		{:else}
			<ul class="mode-tabs__list" role="list">
				{#each recentChannelItems as item (item.id)}
					{@const glyph = glyphFor(item.channelType)}
					<li class="mode-tabs__row" class:active={item.active}>
						<button type="button" class="mode-tabs__item" aria-current={item.active ? 'page' : undefined} on:click={() => void selectChannel(item)}>
							<span class="mode-tabs__glyph" aria-hidden="true">{#if glyph}<Icon name={glyph} size={16} />{:else}#{/if}</span>
							<span class="mode-tabs__label">{item.label}</span>
							{#if item.badgeCount > 0}<span class="w-badge" aria-label={`${item.badgeCount} unread`}>{badgeText(item.badgeCount)}</span>{/if}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	{:else if followedServerGroups.length === 0}
		<p class="mode-tabs__empty">Follow channels with the bell in the sidebar to keep them handy here.</p>
	{:else}
		<div class="mode-tabs__groups">
			{#each followedServerGroups as group (group.serverUrl)}
				{@const collapsed = isFollowedServerGroupCollapsed(group.serverUrl, collapsedFollowedServerUrls)}
				<details class="mode-tabs__group" open={!collapsed} on:toggle={(event) => setFollowedServerGroupCollapsed(group.serverUrl, !(event.currentTarget as HTMLDetailsElement).open)}>
					<summary class="mode-tabs__server" class:current={group.currentServer} aria-controls={followedServerGroupBodyId(group.serverUrl)}>
						<span class="mode-tabs__server-icon" aria-hidden="true">{#if group.serverIconUrl}<img src={group.serverIconUrl} alt="" />{:else}{group.serverIconLabel}{/if}</span>
						<span class="mode-tabs__server-name">{group.serverName}</span>
						<span class="w-count">{group.channels.length}</span>
						<Icon name={collapsed ? 'chevRight' : 'chevDown'} size={14} class="mode-tabs__chev" />
					</summary>
					<ul id={followedServerGroupBodyId(group.serverUrl)} class="mode-tabs__list" role="list">
						{#each group.channels as item (item.id)}
							{@const glyph = glyphFor(item.channelType)}
							<li class="mode-tabs__row" class:active={item.active}>
								<button type="button" class="mode-tabs__item" aria-current={item.active ? 'page' : undefined} on:click={() => void selectChannel(item)}>
									<span class="mode-tabs__glyph" aria-hidden="true">{#if glyph}<Icon name={glyph} size={16} />{:else}#{/if}</span>
									<span class="mode-tabs__label">{item.label}</span>
									{#if item.badgeCount > 0}<span class="w-badge" aria-label={`${item.badgeCount} unread`}>{badgeText(item.badgeCount)}</span>{/if}
								</button>
								<button type="button" class="w-ibtn mode-tabs__unfollow" aria-label={`Unfollow ${item.label}`} title={`Unfollow ${item.label}`} on:click={() => removeSavedChannel(item)}><Icon name="x" size={16} /></button>
							</li>
						{/each}
					</ul>
				</details>
			{/each}
		</div>
	{/if}
</div>
