<script lang="ts">
	import {
		channelUnreadCounts,
		channels,
		currentChannel,
		joinChannel,
		joinVoiceChannel,
	} from '$lib/socket';
	import { mobileTabQueue, type MobileQueueTab } from '$lib/mobileTabQueue';
	import {
		currentSavedServer,
		savedServers,
		switchToSavedServerChannel
	} from '$lib/savedServers';
	import {
		allServerFollowedChannels,
		getCurrentFollowServerUrl,
		unfollowChannel
	} from '$lib/following';
	import { followedChannelSnapshots } from '$lib/followingSnapshots';

	export let embedded = false;

	type DrawerChannelItem = {
		id: string;
		channelId: string;
		serverUrl: string;
		label: string;
		channelType: string | null;
		badgeCount: number;
		active: boolean;
		followedAt: number;
	};

	type FollowedServerGroup = {
		serverUrl: string;
		serverName: string;
		serverIconUrl: string | null;
		serverIconLabel: string;
		currentServer: boolean;
		sortOrder: number;
		channels: DrawerChannelItem[];
	};

	let drawerVisible = false;
	let activeSection: 'recent' | 'saved' = 'recent';
	let collapsedFollowedServerUrls: Record<string, boolean> = {};

	const { tabs: queueTabs } = mobileTabQueue;

	$: serverScopedChannels = $channels.filter((channel) => channel.type !== 'dm');
	$: channelById = new Map(serverScopedChannels.map((channel) => [channel.id, channel] as const));
	$: serverIconUrl = $currentSavedServer?.effectiveIconUrl || null;
	$: serverIconLabel = ($currentSavedServer?.effectiveName || 'Wabi').trim().charAt(0).toUpperCase() || 'W';
	$: activeFollowServerUrl = getCurrentFollowServerUrl();
	$: savedServerByUrl = new Map($savedServers.map((server) => [server.url, server] as const));
	$: snapshotByKey = new Map(
		$followedChannelSnapshots.map((snapshot) => [
			`${snapshot.serverUrl}::${snapshot.channelId}`,
			snapshot
		] as const)
	);

	$: followedServerGroups = buildFollowedServerGroups();

	$: recentChannelItems = $queueTabs
		.filter((item): item is Extract<MobileQueueTab, { type: 'channel' }> => item.type === 'channel')
		.map((item) => {
			const channel = channelById.get(item.channelId);
			if (!channel) return null;
			return buildChannelItem(channel, 'recent');
		})
		.filter((item): item is DrawerChannelItem => item !== null);

	$: followedCount = followedServerGroups.reduce((sum, group) => sum + group.channels.length, 0);
	$: recentCount = recentChannelItems.length;
	$: hasVisibleItems = recentCount > 0 || followedCount > 0;
	$: drawerToggleLabel = [
		'Open server shortcuts',
		recentCount > 0 ? `${recentCount} recent channel${recentCount === 1 ? '' : 's'}` : '',
		followedCount > 0 ? `${followedCount} followed channel${followedCount === 1 ? '' : 's'}` : ''
	]
		.filter(Boolean)
		.join(' · ');
	$: activeSectionSubtitle =
		activeSection === 'recent'
			? 'Recent channels on this server'
			: 'Followed channels across your servers';

	function buildChannelItem(
		channel: (typeof serverScopedChannels)[number],
		source: 'recent' | 'saved'
	): DrawerChannelItem {
		return {
			id: `${source}:${channel.id}`,
			channelId: channel.id,
			serverUrl: activeFollowServerUrl,
			label: channel.name,
			channelType: channel.type || 'text',
			badgeCount: $channelUnreadCounts[channel.id] || 0,
			active: $currentChannel === channel.id,
			followedAt: Date.now()
		};
	}

	function defaultServerName(serverUrl: string): string {
		try {
			return new URL(serverUrl).hostname;
		} catch {
			return serverUrl;
		}
	}

	function buildFollowedServerGroups(): FollowedServerGroup[] {
		const grouped = new Map<string, FollowedServerGroup>();

		for (const { serverUrl, preference } of $allServerFollowedChannels) {
			const snapshot = snapshotByKey.get(`${serverUrl}::${preference.channelId}`);
			const savedServer = savedServerByUrl.get(serverUrl) || null;
			const currentServer = serverUrl === activeFollowServerUrl;
			const liveChannel = currentServer ? channelById.get(preference.channelId) : null;
			const serverName =
				savedServer?.effectiveName ||
				snapshot?.serverName ||
				(currentServer ? $currentSavedServer?.effectiveName : null) ||
				defaultServerName(serverUrl);
			const serverIconUrl =
				savedServer?.effectiveIconUrl ||
				(currentServer ? $currentSavedServer?.effectiveIconUrl || null : null);

			if (!grouped.has(serverUrl)) {
				grouped.set(serverUrl, {
					serverUrl,
					serverName,
					serverIconUrl,
					serverIconLabel: serverName.trim().charAt(0).toUpperCase() || 'W',
					currentServer,
					sortOrder: savedServer?.order ?? Number.MAX_SAFE_INTEGER,
					channels: []
				});
			}

			const group = grouped.get(serverUrl)!;
			group.channels.push({
				id: `saved:${serverUrl}:${preference.channelId}`,
				channelId: preference.channelId,
				serverUrl,
				label: liveChannel?.name || snapshot?.channelName || preference.channelId,
				channelType: liveChannel?.type || snapshot?.channelType || 'text',
				badgeCount:
					currentServer
						? $channelUnreadCounts[preference.channelId] || 0
						: snapshot?.unreadCount || 0,
				active: currentServer && $currentChannel === preference.channelId,
				followedAt: preference.followedAt
			});
		}

		return [...grouped.values()]
			.map((group) => ({
				...group,
				channels: [...group.channels].sort((a, b) => a.followedAt - b.followedAt)
			}))
			.sort((a, b) => {
				if (a.currentServer !== b.currentServer) return a.currentServer ? -1 : 1;
				if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
				return a.serverName.localeCompare(b.serverName);
			});
	}

	function setDrawerOpen(open: boolean): void {
		drawerVisible = open;
	}

	function toggleDrawer(): void {
		drawerVisible = !drawerVisible;
	}

	async function selectChannel(item: DrawerChannelItem): Promise<void> {
		if (item.serverUrl !== activeFollowServerUrl) {
			switchToSavedServerChannel(item.serverUrl, item.channelId);
			setDrawerOpen(false);
			return;
		}

		if (item.channelType === 'voice') {
			try {
				await joinVoiceChannel(item.channelId);
			} catch (error) {
				console.error('Failed to join voice channel from server shortcuts:', error);
			}
			setDrawerOpen(false);
			return;
		}

		joinChannel(item.channelId);
		setDrawerOpen(false);
	}

	function removeSavedChannel(item: DrawerChannelItem): void {
		unfollowChannel(item.channelId, item.serverUrl);
	}

	function setFollowedServerGroupCollapsed(serverUrl: string, collapsed: boolean): void {
		collapsedFollowedServerUrls = {
			...collapsedFollowedServerUrls,
			[serverUrl]: collapsed
		};
	}

	function isFollowedServerGroupCollapsed(serverUrl: string): boolean {
		return collapsedFollowedServerUrls[serverUrl] === true;
	}

	function followedServerGroupBodyId(serverUrl: string): string {
		return `followed-group-${serverUrl.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')}`;
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape' && drawerVisible) {
			drawerVisible = false;
		}
	}
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="mode-tabs-wrapper" class:embedded>
	{#if !embedded}
		<button
			class="drawer-toggle"
			class:active={drawerVisible}
			class:has-tabs={hasVisibleItems}
			type="button"
			aria-label={drawerToggleLabel}
			aria-expanded={drawerVisible}
			on:click={toggleDrawer}
			title={drawerToggleLabel}
		>
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<rect x="3" y="3" width="7" height="7" rx="1"></rect>
				<rect x="14" y="3" width="7" height="7" rx="1"></rect>
				<rect x="3" y="14" width="7" height="7" rx="1"></rect>
				<rect x="14" y="14" width="7" height="7" rx="1"></rect>
			</svg>
			{#if hasVisibleItems}
				<span class="toggle-indicators" aria-hidden="true">
					{#if followedCount > 0}
						<span class="toggle-indicator toggle-indicator-bookmarks"></span>
					{/if}
				</span>
			{/if}
		</button>
	{/if}

	{#if !embedded && drawerVisible}
		<div class="drawer-backdrop" on:click={() => setDrawerOpen(false)} on:keydown={() => {}} role="button" tabindex="-1"></div>
	{/if}

	{#if embedded || drawerVisible}
		<div
			class="drawer-panel"
			class:embedded
			role={embedded ? 'region' : 'dialog'}
			aria-label="Server shortcuts panel"
			aria-hidden={embedded ? undefined : !drawerVisible}
		>
			{#if !embedded}
				<div class="drawer-header">
					<div>
						<span class="drawer-title">Shortcuts</span>
						<p class="drawer-subtitle">{activeSectionSubtitle}</p>
					</div>
					<button class="drawer-close" type="button" aria-label="Close panel" on:click={() => setDrawerOpen(false)}>
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<line x1="18" y1="6" x2="6" y2="18"></line>
							<line x1="6" y1="6" x2="18" y2="18"></line>
						</svg>
					</button>
				</div>
			{/if}

			<div class="drawer-content">
				<div
					class="drawer-sections"
					role="tablist"
					aria-label="Server shortcut sections"
					style:--active-section-index={activeSection === 'recent' ? 0 : 1}
				>
					<span class="drawer-section-highlight" aria-hidden="true"></span>
					<button
						class="drawer-section-tab"
						class:active={activeSection === 'recent'}
						type="button"
						role="tab"
						aria-selected={activeSection === 'recent'}
						on:click={() => (activeSection = 'recent')}
					>
						<span>Recent</span>
						{#if recentCount > 0}
							<span class="section-tab-count">{recentCount}</span>
						{/if}
					</button>
					<button
						class="drawer-section-tab"
						class:active={activeSection === 'saved'}
						type="button"
						role="tab"
						aria-selected={activeSection === 'saved'}
						on:click={() => (activeSection = 'saved')}
					>
						<span>Followed</span>
						{#if followedCount > 0}
							<span class="section-tab-count">{followedCount}</span>
						{/if}
					</button>
				</div>

				{#if activeSection === 'recent'}
					<div class="drawer-section">
						{#if !embedded}
							<span class="section-label">Recent</span>
						{/if}
						{#if recentChannelItems.length === 0}
							<div class="drawer-empty">
								<p>Channels you visit show up here so you can jump back quickly.</p>
							</div>
						{:else}
							<div class="item-list">
								{#each recentChannelItems as item (item.id)}
									<div class="drawer-item-row" class:active={item.active}>
										<button class="drawer-item" type="button" on:click={() => void selectChannel(item)}>
											<span class="item-icon">
												{#if serverIconUrl}
													<img src={serverIconUrl} alt="" />
												{:else}
													<span>{serverIconLabel}</span>
												{/if}
											</span>
											<span class="item-label">{item.label}</span>
											{#if item.badgeCount > 0}
												<span class="item-badge">{item.badgeCount > 99 ? '99+' : item.badgeCount}</span>
											{/if}
										</button>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{:else}
					<div class="drawer-section">
						{#if !embedded}
							<span class="section-label">Followed</span>
						{/if}
						{#if followedServerGroups.length === 0}
							<div class="drawer-empty">
								<p>Follow channels with the star in the sidebar to keep them handy here.</p>
							</div>
						{:else}
							<div class="followed-server-groups">
								{#each followedServerGroups as group (group.serverUrl)}
									<details
										class="followed-server-group"
										open={!isFollowedServerGroupCollapsed(group.serverUrl)}
										on:toggle={(event) =>
											setFollowedServerGroupCollapsed(
												group.serverUrl,
												!(event.currentTarget as HTMLDetailsElement).open
											)}
									>
										<summary
											class="followed-server-header"
											class:current={group.currentServer}
											aria-expanded={!isFollowedServerGroupCollapsed(group.serverUrl)}
											aria-controls={followedServerGroupBodyId(group.serverUrl)}
										>
											<span class="followed-server-icon">
												{#if group.serverIconUrl}
													<img src={group.serverIconUrl} alt="" />
												{:else}
													<span>{group.serverIconLabel}</span>
												{/if}
											</span>
											<div class="followed-server-copy">
												<div class="followed-server-title-row">
													<strong class:current={group.currentServer}>{group.serverName}</strong>
												</div>
											</div>
											<span class="followed-server-count" aria-hidden="true">{group.channels.length}</span>
											<span
												class="followed-server-toggle"
												class:collapsed={isFollowedServerGroupCollapsed(group.serverUrl)}
												aria-hidden="true"
											>
												<svg viewBox="0 0 20 20">
													<path d="M6 8l4 4 4-4" />
												</svg>
											</span>
										</summary>

										<div
											id={followedServerGroupBodyId(group.serverUrl)}
											class="followed-server-body"
										>
											<div class="item-list item-list-grouped">
												{#each group.channels as item (item.id)}
													<div class="drawer-item-row" class:active={item.active}>
														<button class="drawer-item" type="button" on:click={() => void selectChannel(item)}>
															<span class="item-channel-prefix" aria-hidden="true">
																{item.channelType === 'voice' ? '🔊' : '#'}
															</span>
															<span class="item-label">{item.label}</span>
															{#if item.badgeCount > 0}
																<span class="item-badge">{item.badgeCount > 99 ? '99+' : item.badgeCount}</span>
															{/if}
														</button>
														<button
															class="item-close"
															type="button"
															aria-label={`Unfollow ${item.label}`}
															title={`Unfollow ${item.label}`}
															on:click={() => removeSavedChannel(item)}
														>
															★
														</button>
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

<style>
	.mode-tabs-wrapper {
		position: relative;
		display: inline-flex;
		align-items: center;
	}

	.mode-tabs-wrapper.embedded {
		display: block;
		width: 100%;
	}

	.drawer-toggle {
		position: relative;
		width: 32px;
		height: 32px;
		padding: 0;
		border: none;
		border-radius: 8px;
		background: var(--bg-secondary, #2b2d35);
		color: var(--text-secondary, #9ca3af);
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition: background 0.15s ease, color 0.15s ease;
	}

	.drawer-toggle:hover,
	.drawer-toggle.active,
	.drawer-toggle.has-tabs {
		background: var(--bg-tertiary, #3f4254);
		color: var(--text-primary, #f3f4f6);
	}

	.drawer-toggle svg {
		width: 18px;
		height: 18px;
	}

	.toggle-indicators {
		position: absolute;
		top: -3px;
		right: -3px;
		display: flex;
		gap: 3px;
		pointer-events: none;
	}

	.toggle-indicator {
		width: 10px;
		height: 10px;
		border-radius: 999px;
		border: 2px solid var(--bg-secondary, #20222f);
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
	}

	.toggle-indicator-bookmarks {
		background: color-mix(in srgb, #f59e0b 78%, white 22%);
	}

	.drawer-backdrop {
		position: fixed;
		inset: 0;
		z-index: 1999;
		background: rgba(0, 0, 0, 0.3);
	}

	.drawer-panel {
		position: absolute;
		top: 100%;
		right: 0;
		width: min(340px, calc(100vw - 16px));
		max-height: calc(100vh - 60px);
		margin-top: 4px;
		padding: 0;
		background: var(--bg-secondary, #20222f);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 12px;
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
		z-index: 2000;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.drawer-panel.embedded {
		position: relative;
		top: auto;
		right: auto;
		width: 100%;
		max-height: none;
		margin-top: 0;
		border: none;
		border-radius: 0;
		box-shadow: none;
		background: transparent;
	}

	.drawer-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		padding: 0.85rem 0.95rem 0.55rem;
		border-bottom: 1px solid rgba(255, 255, 255, 0.06);
	}

	.drawer-title {
		display: block;
		font-size: 0.86rem;
		font-weight: 700;
		color: var(--text-primary, #f3f4f6);
	}

	.drawer-subtitle {
		margin: 0.18rem 0 0;
		font-size: 0.72rem;
		color: var(--text-secondary, #9ca3af);
	}

	.drawer-close {
		width: 24px;
		height: 24px;
		padding: 0;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--text-secondary, #9ca3af);
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.drawer-close:hover {
		background: rgba(255, 255, 255, 0.08);
		color: var(--text-primary, #f3f4f6);
	}

	.drawer-close svg {
		width: 14px;
		height: 14px;
	}

	.drawer-content {
		padding: 0.65rem;
		overflow-y: auto;
		flex: 1;
	}

	.drawer-sections {
		position: relative;
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.25rem;
		padding: 0.25rem;
		margin-bottom: 0.8rem;
		border-radius: 12px;
		background: rgba(255, 255, 255, 0.04);
		border: 1px solid rgba(255, 255, 255, 0.06);
		overflow: hidden;
	}

	.drawer-section-highlight {
		position: absolute;
		top: 0.25rem;
		left: 0.25rem;
		bottom: 0.25rem;
		width: calc((100% - 0.5rem) / 2);
		border-radius: 10px;
		background:
			linear-gradient(180deg, color-mix(in srgb, var(--accent-primary, #6366f1) 24%, rgba(255, 255, 255, 0.08)), color-mix(in srgb, var(--accent-primary, #6366f1) 14%, transparent));
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.1),
			0 8px 20px rgba(0, 0, 0, 0.22);
		transform: translateX(calc(var(--active-section-index, 0) * (100% + 0.25rem)));
		transition: transform 0.2s ease;
		pointer-events: none;
	}

	.drawer-section-tab {
		height: 34px;
		padding: 0 0.65rem;
		position: relative;
		z-index: 1;
		border: none;
		border-radius: 9px;
		background: transparent;
		color: var(--text-secondary, #9ca3af);
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		font-size: 0.76rem;
		font-weight: 700;
	}

	.drawer-section-tab.active {
		color: var(--text-primary, #f3f4f6);
	}

	.section-tab-count {
		min-width: 18px;
		height: 18px;
		padding: 0 5px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.09);
		color: inherit;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 0.66rem;
	}

	.drawer-section {
		margin-bottom: 0.9rem;
	}

	.drawer-section:last-child {
		margin-bottom: 0;
	}

	.section-label {
		display: block;
		padding: 0.2rem 0.35rem 0.45rem;
		font-size: 0.66rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-secondary, #9ca3af);
		opacity: 0.8;
	}

	.drawer-empty {
		padding: 0.25rem 0.35rem 0.55rem;
	}

	.drawer-empty p {
		margin: 0;
		color: var(--text-secondary, #9ca3af);
		font-size: 0.8rem;
	}

	.item-list {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.item-list-grouped {
		gap: 0;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 12px;
		background: rgba(255, 255, 255, 0.03);
		overflow: hidden;
	}

	.followed-server-groups {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}

	.followed-server-group {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.followed-server-header {
		width: 100%;
		border: none;
		background: transparent;
		display: flex;
		align-items: flex-start;
		gap: 0.55rem;
		padding: 0.15rem 0.35rem 0.25rem;
		text-align: left;
		cursor: pointer;
		list-style: none;
	}

	.followed-server-header::-webkit-details-marker {
		display: none;
	}

	.followed-server-icon {
		width: 22px;
		height: 22px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.08);
		color: var(--text-secondary, #9ca3af);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		font-size: 0.72rem;
		font-weight: 700;
		overflow: hidden;
	}

	.followed-server-icon img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.followed-server-copy {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		min-width: 0;
		text-align: left;
		flex: 1;
	}

	.followed-server-title-row {
		display: flex;
		align-items: center;
		min-width: 0;
	}

	.followed-server-copy strong {
		font-size: 0.78rem;
		color: var(--text-primary, #f3f4f6);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.followed-server-copy strong.current,
	.followed-server-header.current .followed-server-copy strong {
		color: color-mix(in srgb, var(--accent-primary, #6366f1) 62%, white 20%);
	}

	.followed-server-count {
		min-width: 18px;
		height: 18px;
		padding: 0 5px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.08);
		color: var(--text-secondary, #9ca3af);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 0.64rem;
		font-weight: 700;
		flex-shrink: 0;
	}

	.followed-server-toggle {
		width: 22px;
		height: 22px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.06);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition: transform 0.18s ease;
	}

	.followed-server-toggle.collapsed {
		transform: rotate(-90deg);
	}

	.followed-server-toggle svg {
		width: 13px;
		height: 13px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.drawer-item-row {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.18rem;
		border-radius: 10px;
		border: 1px solid transparent;
		background: rgba(255, 255, 255, 0.02);
	}

	.drawer-item-row.active {
		border-color: color-mix(in srgb, var(--accent-primary, #6366f1) 55%, transparent);
		background: color-mix(in srgb, var(--accent-primary, #6366f1) 14%, transparent);
	}

	.item-list-grouped .drawer-item-row {
		padding: 0;
		border: none;
		border-radius: 0;
		background: transparent;
	}

	.item-list-grouped .drawer-item-row + .drawer-item-row {
		border-top: 1px solid rgba(255, 255, 255, 0.06);
	}

	.drawer-item {
		width: 100%;
		height: 38px;
		padding: 0 0.6rem;
		border: none;
		border-radius: 8px;
		background: transparent;
		color: var(--text-primary, #f3f4f6);
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.82rem;
		text-align: left;
	}

	.item-icon {
		width: 20px;
		height: 20px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.08);
		color: var(--text-secondary, #9ca3af);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		font-size: 0.72rem;
		font-weight: 700;
	}

	.item-channel-prefix {
		width: 14px;
		color: var(--text-secondary, #9ca3af);
		flex-shrink: 0;
		font-size: 0.84rem;
		font-weight: 700;
		line-height: 1;
		flex-shrink: 0;
		text-align: center;
	}

	.item-icon img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		border-radius: inherit;
	}

	.item-label {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.item-badge {
		min-width: 20px;
		height: 18px;
		padding: 0 5px;
		border-radius: 9px;
		background: #b91c1c;
		color: #fff;
		font-size: 0.68rem;
		font-weight: 700;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.item-close {
		width: 28px;
		height: 28px;
		border: none;
		border-radius: 8px;
		background: transparent;
		color: var(--text-secondary, #9ca3af);
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 1rem;
		line-height: 1;
		flex-shrink: 0;
	}

	.item-close:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.14);
		color: #fff;
	}

	.item-close:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}

	@media (max-width: 768px) {
		.drawer-toggle {
			width: 36px;
			height: 36px;
		}

		.drawer-toggle svg {
			width: 20px;
			height: 20px;
		}

		.drawer-panel {
			position: fixed;
			top: auto;
			bottom: 0;
			left: 0;
			right: 0;
			width: 100%;
			max-width: none;
			max-height: 72vh;
			margin: 0;
			border-radius: 16px 16px 0 0;
			border-bottom: none;
		}

		.drawer-panel.embedded {
			position: relative;
			bottom: auto;
			left: auto;
			right: auto;
			max-height: none;
			border-radius: 16px;
			border-bottom: 1px solid rgba(255, 255, 255, 0.1);
		}
	}
</style>
