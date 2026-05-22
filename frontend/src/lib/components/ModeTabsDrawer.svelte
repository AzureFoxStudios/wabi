<script lang="ts">
	import { channelUnreadCounts, channels, currentChannel, joinChannel, joinVoiceChannel } from '$lib/socket';
	import { mobileTabQueue, type MobileQueueTab } from '$lib/mobileTabQueue';
	import { currentSavedServer, savedServers, switchToSavedServerChannel } from '$lib/savedServers';
	import { allServerFollowedChannels, getCurrentFollowServerUrl, unfollowChannel } from '$lib/following';
	import { followedChannelSnapshots } from '$lib/followingSnapshots';
	import { isServerScopedChannel } from '$lib/channelTypes';
	import { buildChannelItem, buildFollowedServerGroups, followedServerGroupBodyId, type DrawerChannelItem, type FollowedServerGroup } from './modeTabsDrawerHelpers';
	import './ModeTabsDrawer.css';

	export let embedded = false;
	let drawerVisible = false;
	let activeSection: 'recent' | 'saved' = 'recent';
	let collapsedFollowedServerUrls: Record<string, boolean> = {};
	const { tabs: queueTabs } = mobileTabQueue;

	$: serverScopedChannels = $channels.filter(isServerScopedChannel);
	$: channelById = new Map(serverScopedChannels.map((channel) => [channel.id, channel] as const));
	$: serverIconUrl = $currentSavedServer?.effectiveIconUrl || null;
	$: serverIconLabel = ($currentSavedServer?.effectiveName || 'Wabi').trim().charAt(0).toUpperCase() || 'W';
	$: activeFollowServerUrl = getCurrentFollowServerUrl();
	$: snapshotByKey = new Map($followedChannelSnapshots.map((snapshot) => [`${snapshot.serverUrl}::${snapshot.channelId}`, snapshot] as const));
	$: followedServerGroups = buildFollowedServerGroups($allServerFollowedChannels, $savedServers, snapshotByKey, activeFollowServerUrl, $currentSavedServer, channelById, $channelUnreadCounts, $currentChannel);
	$: recentChannelItems = $queueTabs.filter((item): item is Extract<MobileQueueTab, { type: 'channel' }> => item.type === 'channel').map((item) => { const channel = channelById.get(item.channelId); if (!channel) return null; return buildChannelItem(channel, 'recent', activeFollowServerUrl, $currentChannel, $channelUnreadCounts); }).filter((item): item is DrawerChannelItem => item !== null);
	$: followedCount = followedServerGroups.reduce((sum, group) => sum + group.channels.length, 0);
	$: recentCount = recentChannelItems.length;
	$: hasVisibleItems = recentCount > 0 || followedCount > 0;
	$: drawerToggleLabel = ['Open server shortcuts', recentCount > 0 ? `${recentCount} recent channel${recentCount === 1 ? '' : 's'}` : '', followedCount > 0 ? `${followedCount} followed channel${followedCount === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
	$: activeSectionSubtitle = activeSection === 'recent' ? 'Recent channels on this server' : 'Followed channels across your servers';

	function setDrawerOpen(open: boolean): void { drawerVisible = open; }
	function toggleDrawer(): void { drawerVisible = !drawerVisible; }
	async function selectChannel(item: DrawerChannelItem): Promise<void> {
		if (item.serverUrl !== activeFollowServerUrl) { switchToSavedServerChannel(item.serverUrl, item.channelId); setDrawerOpen(false); return; }
		if (item.channelType === 'voice') { try { await joinVoiceChannel(item.channelId); } catch (error) { console.error('Failed to join voice channel from server shortcuts:', error); } setDrawerOpen(false); return; }
		joinChannel(item.channelId);
		setDrawerOpen(false);
	}
	function removeSavedChannel(item: DrawerChannelItem): void { unfollowChannel(item.channelId, item.serverUrl); }
	function setFollowedServerGroupCollapsed(serverUrl: string, collapsed: boolean): void { collapsedFollowedServerUrls = { ...collapsedFollowedServerUrls, [serverUrl]: collapsed }; }
	function isFollowedServerGroupCollapsed(serverUrl: string): boolean { return collapsedFollowedServerUrls[serverUrl] === true; }
	function handleKeydown(event: KeyboardEvent): void { if (event.key === 'Escape' && drawerVisible) drawerVisible = false; }
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="mode-tabs-wrapper" class:embedded>
	{#if !embedded}
		<button class="drawer-toggle" class:active={drawerVisible} class:has-tabs={hasVisibleItems} type="button" aria-label={drawerToggleLabel} aria-expanded={drawerVisible} on:click={toggleDrawer} title={drawerToggleLabel}>
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect></svg>
			{#if hasVisibleItems}<span class="toggle-indicators" aria-hidden="true">{#if followedCount > 0}<span class="toggle-indicator toggle-indicator-bookmarks"></span>{/if}</span>{/if}
		</button>
	{/if}

	{#if !embedded && drawerVisible}<div class="drawer-backdrop" on:click={() => setDrawerOpen(false)} on:keydown={() => {}} role="button" tabindex="-1"></div>{/if}

	{#if embedded || drawerVisible}
		<div class="drawer-panel" class:embedded role={embedded ? 'region' : 'dialog'} aria-label="Server shortcuts panel" aria-hidden={embedded ? undefined : !drawerVisible}>
			{#if !embedded}
				<div class="drawer-header">
					<div><span class="drawer-title">Shortcuts</span><p class="drawer-subtitle">{activeSectionSubtitle}</p></div>
					<button class="drawer-close" type="button" aria-label="Close panel" on:click={() => setDrawerOpen(false)}><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
				</div>
			{/if}

			<div class="drawer-content">
				<div class="drawer-sections" role="tablist" aria-label="Server shortcut sections" style:--active-section-index={activeSection === 'recent' ? 0 : 1}>
					<span class="drawer-section-highlight" aria-hidden="true"></span>
					<button class="drawer-section-tab" class:active={activeSection === 'recent'} type="button" role="tab" aria-selected={activeSection === 'recent'} on:click={() => (activeSection = 'recent')}><span>Recent</span>{#if recentCount > 0}<span class="section-tab-count">{recentCount}</span>{/if}</button>
					<button class="drawer-section-tab" class:active={activeSection === 'saved'} type="button" role="tab" aria-selected={activeSection === 'saved'} on:click={() => (activeSection = 'saved')}><span>Followed</span>{#if followedCount > 0}<span class="section-tab-count">{followedCount}</span>{/if}</button>
				</div>

				{#if activeSection === 'recent'}
					<div class="drawer-section">
						{#if !embedded}<span class="section-label">Recent</span>{/if}
						{#if recentChannelItems.length === 0}<div class="drawer-empty"><p>Channels you visit show up here so you can jump back quickly.</p></div>{:else}
							<div class="item-list">
								{#each recentChannelItems as item (item.id)}
									<div class="drawer-item-row" class:active={item.active}>
										<button class="drawer-item" type="button" on:click={() => void selectChannel(item)}>
											<span class="item-icon">{#if serverIconUrl}<img src={serverIconUrl} alt="" />{:else}<span>{serverIconLabel}</span>{/if}</span>
											<span class="item-label">{item.label}</span>
											{#if item.badgeCount > 0}<span class="item-badge">{item.badgeCount > 99 ? '99+' : item.badgeCount}</span>{/if}
										</button>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{:else}
					<div class="drawer-section">
						{#if !embedded}<span class="section-label">Followed</span>{/if}
						{#if followedServerGroups.length === 0}<div class="drawer-empty"><p>Follow channels with the star in the sidebar to keep them handy here.</p></div>{:else}
							<div class="followed-server-groups">
								{#each followedServerGroups as group (group.serverUrl)}
									<details class="followed-server-group" open={!isFollowedServerGroupCollapsed(group.serverUrl)} on:toggle={(event) => setFollowedServerGroupCollapsed(group.serverUrl, !(event.currentTarget as HTMLDetailsElement).open)}>
										<summary class="followed-server-header" class:current={group.currentServer} aria-expanded={!isFollowedServerGroupCollapsed(group.serverUrl)} aria-controls={followedServerGroupBodyId(group.serverUrl)}>
											<span class="followed-server-icon">{#if group.serverIconUrl}<img src={group.serverIconUrl} alt="" />{:else}<span>{group.serverIconLabel}</span>{/if}</span>
											<div class="followed-server-copy"><div class="followed-server-title-row"><strong class:current={group.currentServer}>{group.serverName}</strong></div></div>
											<span class="followed-server-count" aria-hidden="true">{group.channels.length}</span>
											<span class="followed-server-toggle" class:collapsed={isFollowedServerGroupCollapsed(group.serverUrl)} aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M6 8l4 4 4-4" /></svg></span>
										</summary>
										<div id={followedServerGroupBodyId(group.serverUrl)} class="followed-server-body">
											<div class="item-list item-list-grouped">
												{#each group.channels as item (item.id)}
													<div class="drawer-item-row" class:active={item.active}>
														<button class="drawer-item" type="button" on:click={() => void selectChannel(item)}>
															<span class="item-channel-prefix" aria-hidden="true">{item.channelType === 'voice' ? '🔊' : '#'}</span>
															<span class="item-label">{item.label}</span>
															{#if item.badgeCount > 0}<span class="item-badge">{item.badgeCount > 99 ? '99+' : item.badgeCount}</span>{/if}
														</button>
														<button class="item-close" type="button" aria-label={`Unfollow ${item.label}`} title={`Unfollow ${item.label}`} on:click={() => removeSavedChannel(item)}>★</button>
													</div>
												{/each}
											</div>
										</div>
									</details>
								{/each}
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>
