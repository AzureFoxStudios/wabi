<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import { channels, channelMessages, channelUnreadCounts, currentUser, serverMembers, users, type User } from '$lib/socket';
	import { friendships, startFriendshipSync } from '$lib/friendships';
	import { followedChannelSnapshots, markFollowedChannelRead } from '$lib/followingSnapshots';
	import { savedServers, switchToSavedServer, switchToSavedServerChannel } from '$lib/savedServers';
	import { remoteFriendRequests } from '$lib/crossServerFriendRequests';
	import { normalizeServerUrl, resolveServerUrl } from '$lib/serverUrl';
	import { messageMentionsUser } from '$lib/notificationDisplay';
	import { isNotificationPreviewEnabled } from '$lib/notificationSettings';
	import { resolveDmOtherUser } from '$lib/dmConversations';
	import FriendsPanel from './FriendsPanel.svelte';
	export let error = '';

	const dispatch = createEventDispatcher<{ openDm: { channelId: string }; message: User; settings: void; openChannel: { channelId: string } }>();
	let tab: 'inbox' | 'following' | 'friends' = 'inbox';
	let serverFilter = 'all';
	let unreadOnly = false;
	let showPreviews = false;

	onMount(() => {
		showPreviews = isNotificationPreviewEnabled();
		const refreshPreviews = () => { showPreviews = isNotificationPreviewEnabled(); };
		window.addEventListener('wabi:notification-settings-changed', refreshPreviews);
		if (sessionStorage.getItem('wabi.pendingActivityTab') === 'friends') {
			tab = 'friends';
			sessionStorage.removeItem('wabi.pendingActivityTab');
		}
		const stopFriendshipSync = startFriendshipSync();
		return () => { window.removeEventListener('wabi:notification-settings-changed', refreshPreviews); stopFriendshipSync(); };
	});

	$: currentServerUrl = normalizeServerUrl(resolveServerUrl().url) || resolveServerUrl().url;
	$: currentServer = $savedServers.find((server) => server.url === currentServerUrl);
	$: currentServerName = currentServer?.effectiveName || 'Current server';
	$: dmAlerts = $channels
		.filter((channel) => (channel.type === 'dm' || channel.type === 'group') && ($channelUnreadCounts[channel.id] || 0) > 0)
		.map((channel) => ({ channel, unread: $channelUnreadCounts[channel.id] || 0,
			last: ($channelMessages[channel.id] || []).at(-1) }))
		.sort((a, b) => (b.last?.timestamp || 0) - (a.last?.timestamp || 0));
	$: mentionAlerts = $channels
		.filter((channel) => channel.type !== 'dm' && channel.type !== 'group' && ($channelUnreadCounts[channel.id] || 0) > 0)
		.map((channel) => ({ channel,
			message: [...($channelMessages[channel.id] || [])].reverse().find((message) => messageMentionsUser(message, $currentUser?.username)) }))
		.filter((entry) => Boolean(entry.message));
	$: followItems = $followedChannelSnapshots
		.filter((item) => (serverFilter === 'all' || item.serverUrl === serverFilter) && (!unreadOnly || item.unreadCount > 0));
	$: savedServerChoices = $savedServers.filter((server) => server.hasRegisteredSession || server.hasGuestSession);
	$: remoteRequests = Object.entries($remoteFriendRequests).flatMap(([url, entry]) => {
		const server = $savedServers.find((item) => item.url === url);
		if (!server || (server.lastDbUserId != null && server.lastDbUserId !== entry.accountId)) return [];
		return entry.requests.map((request) => ({ server, request }));
	});
	$: attentionCount = $friendships.incoming.length + remoteRequests.length + dmAlerts.length + mentionAlerts.length;

	function openRemoteFriends(serverUrl: string): void {
		sessionStorage.setItem('wabi.pendingActivityServer', serverUrl);
		sessionStorage.setItem('wabi.pendingActivityTab', 'friends');
		switchToSavedServer(serverUrl);
	}

	function openFollow(serverUrl: string, channelId: string): void {
		markFollowedChannelRead(serverUrl, channelId);
		if (serverUrl === currentServerUrl) {
			dispatch('openChannel', { channelId });
		} else {
			switchToSavedServerChannel(serverUrl, channelId);
		}
	}

	function personName(channelId: string): string {
		const channel = $channels.find((item) => item.id === channelId);
		if (!channel) return 'Conversation';
		if (channel.type === 'group') return channel.name || 'Group conversation';
		const member = resolveDmOtherUser(channel, $currentUser, $users, $serverMembers);
		return member?.handle || member?.username || channel.name || 'Direct message';
	}

	function formatTime(value: number | undefined): string {
		if (!value) return '';
		return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(value);
	}
</script>

<main class="activity-center" aria-labelledby="activity-title">
	<header class="activity-header">
		<div>
			<p class="activity-eyebrow">Your Wabi activity</p>
			<h1 id="activity-title">Activity</h1>
			<p>Review requests, current-server conversations, and channels you follow across saved servers.</p>
		</div>
		<button class="activity-settings" type="button" on:click={() => dispatch('settings')}>Notification settings</button>
	</header>

	<nav class="activity-tabs" aria-label="Activity sections">
		<button type="button" class:active={tab === 'inbox'} aria-current={tab === 'inbox' ? 'page' : undefined} on:click={() => (tab = 'inbox')}>Needs you{#if attentionCount}<span>{attentionCount}</span>{/if}</button>
		<button type="button" class:active={tab === 'following'} aria-current={tab === 'following' ? 'page' : undefined} on:click={() => (tab = 'following')}>Following</button>
		<button type="button" class:active={tab === 'friends'} aria-current={tab === 'friends' ? 'page' : undefined} on:click={() => (tab = 'friends')}>Friends{#if $friendships.incoming.length}<span>{$friendships.incoming.length}</span>{/if}</button>
	</nav>
	{#if error}<p class="activity-action-error" role="alert">{error}</p>{/if}

	{#if tab === 'inbox'}
		<div class="activity-content">
			{#if $friendships.incoming.length}
				<section aria-labelledby="activity-friend-requests">
					<h2 id="activity-friend-requests">Friend requests</h2>
					{#each $friendships.incoming as request (request.id)}
						<button class="activity-row" type="button" on:click={() => (tab = 'friends')}>
							<span class="activity-symbol" aria-hidden="true">+</span>
							<span class="activity-row-copy"><strong>{request.username} wants to be friends</strong><small>{currentServerName} · Review request</small></span>
							<time>{formatTime(request.created_at)}</time>
						</button>
					{/each}
				</section>
			{/if}
			{#if remoteRequests.length}
				<section aria-labelledby="activity-other-friend-requests">
					<h2 id="activity-other-friend-requests">Requests on other servers</h2>
					{#each remoteRequests as item (`${item.server.url}:${item.request.id}`)}
						<button class="activity-row" type="button" on:click={() => openRemoteFriends(item.server.url)}>
							<span class="activity-symbol" aria-hidden="true">+</span>
							<span class="activity-row-copy"><strong>{item.request.username} wants to be friends</strong><small>{item.server.effectiveName} · Switch to review</small></span>
							<time>{formatTime(item.request.created_at)}</time>
						</button>
					{/each}
				</section>
			{/if}
			{#if dmAlerts.length}
				<section aria-labelledby="activity-messages">
					<h2 id="activity-messages">Conversations</h2>
					{#each dmAlerts as item (item.channel.id)}
						<button class="activity-row" type="button" on:click={() => dispatch('openDm', { channelId: item.channel.id })}>
							<span class="activity-symbol" aria-hidden="true">✉</span>
							<span class="activity-row-copy"><strong>{personName(item.channel.id)}</strong><small>{currentServerName} · {item.unread} unread {item.unread === 1 ? 'message' : 'messages'}</small>{#if showPreviews && item.last && !item.last.id.startsWith('live_')}<span class="activity-preview">{item.last.text || 'New message'}</span>{/if}</span>
							<time>{formatTime(item.last?.timestamp)}</time>
						</button>
					{/each}
				</section>
			{/if}
			{#if mentionAlerts.length}
				<section aria-labelledby="activity-mentions">
					<h2 id="activity-mentions">Mentions in loaded channels</h2>
					{#each mentionAlerts as item (item.channel.id)}
						<button class="activity-row" type="button" on:click={() => dispatch('openChannel', { channelId: item.channel.id })}>
							<span class="activity-symbol" aria-hidden="true">@</span>
							<span class="activity-row-copy"><strong>{item.channel.name}</strong><small>{currentServerName} · Mentioned by {item.message?.user}</small>{#if showPreviews && item.message && !item.message.id.startsWith('live_')}<span class="activity-preview">{item.message.text}</span>{/if}</span>
							<time>{formatTime(item.message?.timestamp)}</time>
						</button>
					{/each}
				</section>
			{/if}
			{#if !attentionCount}
				<div class="activity-empty"><h2>All caught up here</h2><p>Friend requests from signed-in servers and unread conversations on this server appear here. Followed activity is under Following.</p></div>
			{/if}
		</div>
	{:else if tab === 'following'}
		<div class="activity-content">
			<div class="activity-filters">
				<label>Server <select bind:value={serverFilter}><option value="all">All saved servers</option>{#each savedServerChoices as server (server.url)}<option value={server.url}>{server.effectiveName}</option>{/each}</select></label>
				<label class="activity-check"><input type="checkbox" bind:checked={unreadOnly} /> Unread only</label>
			</div>
			{#if followItems.length}
				{#each followItems as item (`${item.serverUrl}:${item.channelId}`)}
					<button class="activity-row" type="button" on:click={() => openFollow(item.serverUrl, item.channelId)}>
						<span class="activity-symbol" aria-hidden="true">☆</span>
						<span class="activity-row-copy"><strong>{item.channelName}</strong><small>{item.serverName || item.serverUrl}{#if item.unreadCount} · {item.unreadCount} unread{/if}</small>{#if showPreviews && item.previewMessages.length}<span class="activity-preview">{item.previewMessages.at(-1)?.text}</span>{/if}</span>
						<time>{formatTime(item.lastActivityAt)}</time>
					</button>
				{/each}
			{:else}
				<div class="activity-empty"><h2>No followed activity yet</h2><p>Follow a channel from its server to add it here. Following starts silent; you can raise its alert level from the channel list.</p></div>
			{/if}
		</div>
	{:else}
		<div class="activity-content activity-friends"><p class="activity-scope">Friends belong to {currentServerName}. Switch servers to manage another community’s friends.</p><FriendsPanel on:message={(event) => dispatch('message', event.detail)} /></div>
	{/if}
</main>

<style>
	.activity-center { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; color: var(--text-heading); background: var(--surface-app); }
	.activity-header { display: flex; justify-content: space-between; align-items: center; gap: var(--space-4); padding: var(--space-5) var(--space-6) var(--space-4); border-bottom: 1px solid var(--border-subtle); }
	.activity-eyebrow { margin: 0 0 var(--space-1); color: var(--accent-primary-color); font-size: var(--text-xs); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
	.activity-header h1 { margin: 0; font-size: clamp(1.4rem, 3vw, 2rem); }
	.activity-header p:last-child { margin: var(--space-1) 0 0; color: var(--text-secondary); font-size: var(--text-sm); }
	.activity-settings, .activity-tabs button, .activity-row { font: inherit; cursor: pointer; }
	.activity-settings { flex-shrink: 0; padding: var(--space-2) var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--surface-raised); color: var(--text-heading); }
	.activity-tabs { display: flex; gap: var(--space-1); padding: var(--space-2) var(--space-6); border-bottom: 1px solid var(--border-subtle); overflow-x: auto; }
	.activity-tabs button { display: flex; gap: var(--space-2); align-items: center; white-space: nowrap; padding: var(--space-2) var(--space-3); border: 0; border-radius: var(--radius-md); color: var(--text-secondary); background: transparent; }
	.activity-tabs button.active { color: var(--text-heading); background: var(--surface-raised); font-weight: 700; }
	.activity-tabs span { padding: 1px 6px; border-radius: 999px; background: var(--accent-primary-color); color: var(--surface-app); font-size: var(--text-xs); }
	.activity-content { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-5) var(--space-6); }
	.activity-content section { margin-bottom: var(--space-5); }
	.activity-content h2 { margin: 0 0 var(--space-2); font-size: var(--text-sm); color: var(--text-secondary); }
	.activity-row { display: flex; align-items: center; gap: var(--space-3); width: 100%; min-height: 68px; padding: var(--space-3); text-align: start; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--surface-raised); color: var(--text-heading); margin-bottom: var(--space-2); }
	.activity-row:hover, .activity-settings:hover { background: var(--surface-hover); }
	.activity-row:focus-visible, .activity-tabs button:focus-visible, .activity-settings:focus-visible { outline: 2px solid var(--accent-primary-color); outline-offset: 2px; }
	.activity-symbol { display: grid; place-items: center; flex: 0 0 36px; height: 36px; border-radius: var(--radius-md); background: var(--surface-sunken); color: var(--accent-primary-color); font-weight: 700; }
	.activity-row-copy { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
	.activity-row-copy strong, .activity-preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.activity-row-copy small, .activity-row time, .activity-scope { color: var(--text-secondary); font-size: var(--text-xs); }
	.activity-row time { flex-shrink: 0; }
	.activity-preview { font-size: var(--text-sm); color: var(--text-secondary); }
	.activity-empty { padding: var(--space-6); border: 1px dashed var(--border-subtle); border-radius: var(--radius-lg); text-align: center; color: var(--text-secondary); }
	.activity-empty h2 { color: var(--text-heading); font-size: var(--text-lg); }
	.activity-filters { display: flex; gap: var(--space-4); align-items: end; flex-wrap: wrap; margin-bottom: var(--space-4); }
	.activity-filters label { display: grid; gap: var(--space-1); color: var(--text-secondary); font-size: var(--text-sm); }
	.activity-filters select { min-height: 38px; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--surface-raised); color: var(--text-heading); }
	.activity-filters .activity-check { display: flex; align-items: center; min-height: 38px; }
	.activity-friends { display: flex; flex-direction: column; }
	.activity-scope { margin: 0 0 var(--space-2); }
	.activity-action-error { margin: var(--space-3) var(--space-6) 0; color: var(--color-danger, #ef4444); }
	@media (max-width: 768px) { .activity-header, .activity-content { padding: var(--space-3); } .activity-header { align-items: flex-start; flex-direction: column; } .activity-tabs { padding: var(--space-2) var(--space-3); } .activity-row time { display: none; } }
</style>
