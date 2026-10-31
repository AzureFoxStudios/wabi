<!--
	Activity (design contract §8.11): what needs you, as one quiet list.

	Row A (setStageHeader): "Activity" with the segment All | Mentions | Follows, and Notification
	settings. Rows are 56px: a 28px stamp in the person's identity disc (a channel or group shows
	its glyph), one sentence with the name in its ink, the place in --w-t-small --w-faint, the time
	in mono, and a 6px --w-accent dot at the text's left edge while it is unread (no bars, no cards).
	Friend requests are rows with Accept (primary sm) and Decline (quiet sm); a request on another
	server switches there to review it. Friends themselves are managed in the DMs hub (Conversations
	| Friends), so Activity no longer repeats that panel.

	Empty states say what is missing and what happens next (§7.16). Failures are one notice.
-->
<script lang="ts">
	import { createEventDispatcher, onDestroy, onMount } from 'svelte';
	import { channels, channelMessages, channelUnreadCounts, currentUser, serverMembers, users, type User } from '$lib/socket';
	import { friendships, startFriendshipSync, acceptFriendship, dismissFriendship } from '$lib/friendships';
	import { followedChannelSnapshots, markFollowedChannelRead } from '$lib/followingSnapshots';
	import { savedServers, switchToSavedServer, switchToSavedServerChannel } from '$lib/savedServers';
	import { remoteFriendRequests } from '$lib/crossServerFriendRequests';
	import { normalizeServerUrl, resolveServerUrl } from '$lib/serverUrl';
	import { messageMentionsUser } from '$lib/notificationDisplay';
	import { isNotificationPreviewEnabled } from '$lib/notificationSettings';
	import { resolveDmOtherUser } from '$lib/dmConversations';
	import { inkFor } from '$lib/theme/identity';
	import { clearStageHeader, setStageHeader, type StageHeaderAction } from '$lib/stageHeader';
	import { isMobile } from '$lib/layoutStoreStates';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Notice from '$lib/components/ui/Notice.svelte';
	import Segmented from '$lib/components/ui/Segmented.svelte';
	import Switch from '$lib/components/ui/Switch.svelte';
	import type { IconName } from '$lib/components/ui/icons';
	import ActivityStageHeader, { type ActivityFilter } from './ActivityStageHeader.svelte';
	export let error = '';

	const dispatch = createEventDispatcher<{ openDm: { channelId: string }; message: User; settings: void; openChannel: { channelId: string } }>();
	const HEADER_OWNER = 'activity';
	let filter: ActivityFilter = 'all';
	let serverFilter = 'all';
	let unreadOnly = false;
	let showPreviews = false;
	let actionError = '';
	let actionDetail: unknown = null;
	let busyRequest = '';
	let mounted = false;

	onMount(() => {
		mounted = true;
		showPreviews = isNotificationPreviewEnabled();
		const refreshPreviews = () => { showPreviews = isNotificationPreviewEnabled(); };
		window.addEventListener('wabi:notification-settings-changed', refreshPreviews);
		// A request on another server switched here to be reviewed: it is in All.
		if (sessionStorage.getItem('wabi.pendingActivityTab') === 'friends') {
			filter = 'all';
			sessionStorage.removeItem('wabi.pendingActivityTab');
		}
		const stopFriendshipSync = startFriendshipSync();
		return () => { window.removeEventListener('wabi:notification-settings-changed', refreshPreviews); stopFriendshipSync(); };
	});
	onDestroy(() => clearStageHeader(HEADER_OWNER));

	type Row = {
		key: string;
		kind: 'request' | 'remote-request' | 'dm' | 'mention' | 'follow';
		/** The person or place the sentence starts with. */
		name: string;
		/** Identity color for a person (their ink and disc); null for a channel or group. */
		color: string | null;
		glyph: IconName | null;
		text: string;
		/** `#channel` after the sentence, for mentions. */
		where?: string;
		place: string;
		preview?: string;
		time?: number;
		unread: boolean;
		open?: () => void;
		requestId?: string;
		serverUrl?: string;
	};

	$: currentServerUrl = normalizeServerUrl(resolveServerUrl().url) || resolveServerUrl().url;
	$: currentServer = $savedServers.find((server) => server.url === currentServerUrl);
	$: currentServerName = currentServer?.effectiveName || 'This server';
	$: people = [...$serverMembers, ...$users];
	$: dmAlerts = $channels
		.filter((channel) => (channel.type === 'dm' || channel.type === 'group') && ($channelUnreadCounts[channel.id] || 0) > 0)
		.map((channel) => ({ channel, unread: $channelUnreadCounts[channel.id] || 0, last: ($channelMessages[channel.id] || []).at(-1) }));
	$: mentionAlerts = $channels
		.filter((channel) => channel.type !== 'dm' && channel.type !== 'group' && ($channelUnreadCounts[channel.id] || 0) > 0)
		.map((channel) => ({ channel, message: [...($channelMessages[channel.id] || [])].reverse().find((message) => messageMentionsUser(message, $currentUser?.username)) }))
		.filter((entry) => Boolean(entry.message));
	$: followItems = $followedChannelSnapshots.filter((item) => (serverFilter === 'all' || item.serverUrl === serverFilter) && (!unreadOnly || item.unreadCount > 0));
	$: savedServerChoices = $savedServers.filter((server) => server.hasRegisteredSession || server.hasGuestSession);
	$: remoteRequests = Object.entries($remoteFriendRequests).flatMap(([url, entry]) => {
		const server = $savedServers.find((item) => item.url === url);
		if (!server || (server.lastDbUserId != null && server.lastDbUserId !== entry.accountId)) return [];
		return entry.requests.map((request) => ({ server, request }));
	});

	function colorOf(username: string | undefined): string | null {
		if (!username) return null;
		const person = people.find((user) => user.username === username);
		return person?.color || null;
	}
	function personName(channelId: string): { name: string; color: string | null; group: boolean } {
		const channel = $channels.find((item) => item.id === channelId);
		if (!channel) return { name: 'Conversation', color: null, group: false };
		if (channel.type === 'group') return { name: channel.name || 'Group conversation', color: null, group: true };
		const member = resolveDmOtherUser(channel, $currentUser, $users, $serverMembers);
		return { name: member?.handle || member?.username || channel.name || 'Direct message', color: member?.color || null, group: false };
	}
	const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

	$: requestRows = [
		...$friendships.incoming.map((request): Row => ({
			key: `request:${request.id}`, kind: 'request', name: request.username, color: colorOf(request.username), glyph: null,
			text: 'wants to be friends', place: currentServerName, time: request.created_at, unread: true, requestId: request.id
		})),
		...remoteRequests.map(({ server, request }): Row => ({
			key: `remote:${server.url}:${request.id}`, kind: 'remote-request', name: request.username, color: null, glyph: null,
			text: 'wants to be friends', place: server.effectiveName, time: request.created_at, unread: true, serverUrl: server.url
		}))
	];
	$: dmRows = dmAlerts.map(({ channel, unread, last }): Row => {
		const who = personName(channel.id);
		return {
			key: `dm:${channel.id}`, kind: 'dm', name: who.name, color: who.color, glyph: who.group ? 'users' : null,
			text: who.group ? `has ${plural(unread, 'new message', 'new messages')}` : `sent you ${plural(unread, 'message', 'messages')}`,
			place: `${currentServerName} · ${who.group ? 'Group' : 'Direct message'}`,
			preview: showPreviews && last && !last.id.startsWith('live_') ? last.text || 'New message' : undefined,
			time: last?.timestamp, unread: true, open: () => dispatch('openDm', { channelId: channel.id })
		};
	});
	$: mentionRows = mentionAlerts.map(({ channel, message }): Row => ({
		key: `mention:${channel.id}`, kind: 'mention', name: message?.user || 'Someone', color: colorOf(message?.user), glyph: null,
		text: 'mentioned you in', where: `#${channel.name}`, place: currentServerName,
		preview: showPreviews && message && !message.id.startsWith('live_') ? message.text : undefined,
		time: message?.timestamp, unread: true, open: () => dispatch('openChannel', { channelId: channel.id })
	}));
	$: followRows = followItems.map((item): Row => ({
		key: `follow:${item.serverUrl}:${item.channelId}`, kind: 'follow', name: `#${item.channelName}`, color: null, glyph: 'hash',
		text: item.unreadCount ? `has ${plural(item.unreadCount, 'new message', 'new messages')}` : 'is quiet', place: item.serverName || item.serverUrl,
		preview: showPreviews && item.previewMessages.length ? item.previewMessages.at(-1)?.text : undefined,
		time: item.lastActivityAt, unread: item.unreadCount > 0, open: () => openFollow(item.serverUrl, item.channelId)
	}));
	$: byTime = (a: Row, b: Row) => (b.time || 0) - (a.time || 0);
	$: allRows = [...requestRows, ...[...dmRows, ...mentionRows, ...followRows.filter((row) => row.unread)].sort(byTime)];
	$: counts = { all: allRows.length, mentions: mentionRows.length, follows: followRows.filter((row) => row.unread).length };
	$: rows = filter === 'all' ? allRows : filter === 'mentions' ? mentionRows.slice().sort(byTime) : followRows.slice().sort(byTime);

	function openRemoteFriends(serverUrl: string): void {
		sessionStorage.setItem('wabi.pendingActivityServer', serverUrl);
		sessionStorage.setItem('wabi.pendingActivityTab', 'friends');
		switchToSavedServer(serverUrl);
	}
	function openFollow(serverUrl: string, channelId: string): void {
		markFollowedChannelRead(serverUrl, channelId);
		if (serverUrl === currentServerUrl) dispatch('openChannel', { channelId });
		else switchToSavedServerChannel(serverUrl, channelId);
	}
	async function answer(requestId: string, accept: boolean): Promise<void> {
		if (busyRequest) return;
		busyRequest = requestId;
		actionError = '';
		try { await (accept ? acceptFriendship(requestId) : dismissFriendship(requestId)); }
		catch (e) { actionDetail = e; actionError = accept ? "Couldn't accept the request" : "Couldn't decline the request"; }
		finally { busyRequest = ''; }
	}
	function time(value: number | undefined): string {
		if (!value) return '';
		const date = new Date(value), now = new Date();
		const sameDay = date.toDateString() === now.toDateString();
		return new Intl.DateTimeFormat(undefined, sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' }).format(date);
	}
	const initial = (name: string) => (name.replace(/^[#@]/, '').trim().charAt(0) || '?').toUpperCase();

	const EMPTY: Record<ActivityFilter, { title: string; text: string; glyph: IconName }> = {
		all: { title: 'Nothing needs you right now.', text: 'Messages to you, mentions and friend requests on this server show up here, newest first.', glyph: 'bell' },
		mentions: { title: 'No mentions yet', text: 'When someone mentions you in a channel this device has loaded, it shows up here.', glyph: 'at' },
		follows: { title: 'No followed channels yet', text: 'Follow a channel from its server to see it here. Following starts silent; raise its alert level from the channel list.', glyph: 'star' }
	};
	$: headerActions = [{ id: 'settings', label: 'Notification settings', icon: 'gear', iconOnly: true, onSelect: () => dispatch('settings') }] as StageHeaderAction[];
	$: if (mounted) setStageHeader(HEADER_OWNER, {
		view: 'notifications',
		title: 'Activity',
		component: ActivityStageHeader,
		props: { value: filter, counts, onchange: (next: ActivityFilter) => (filter = next) },
		actions: headerActions
	});
	$: shownError = error || actionError;
</script>

<main class="activity" aria-label="Activity">
	{#if $isMobile}
		<div class="activity__phone-seg">
			<Segmented label="Show" value={filter} options={[{ value: 'all', label: counts.all ? `All ${counts.all}` : 'All' }, { value: 'mentions', label: 'Mentions' }, { value: 'follows', label: 'Follows' }]} onchange={(next) => (filter = next as ActivityFilter)} />
		</div>
	{/if}
	<div class="activity__scroll">
		<div class="activity__column">
			{#if shownError}<Notice class="activity__notice" title={shownError} text="Nothing else changed." error={actionDetail} ondismiss={() => { actionError = ''; }} />{/if}
			{#if filter === 'follows'}
				<div class="activity__filters">
					<label class="activity__server"><span class="w-label">Server</span><span class="w-field"><select aria-label="Server" bind:value={serverFilter}><option value="all">All saved servers</option>{#each savedServerChoices as server (server.url)}<option value={server.url}>{server.effectiveName}</option>{/each}</select></span></label>
					<span class="activity__unread"><span id="activity-unread-label">Unread only</span><Switch labelledby="activity-unread-label" bind:checked={unreadOnly} /></span>
				</div>
			{/if}
			{#if rows.length}
				<ul class="activity__list" aria-label={filter === 'all' ? 'Needs you' : filter === 'mentions' ? 'Mentions' : 'Followed channels'}>
					{#each rows as row (row.key)}
						<li class="activity-row" class:activity-row--unread={row.unread} class:activity-row--open={!!row.open}>
							<span class="activity-row__stamp" class:activity-row__stamp--glyph={!!row.glyph} style={row.color ? $inkFor(row.color) : ''} aria-hidden="true">
								{#if row.glyph}<Icon name={row.glyph} size={14} />{:else}{initial(row.name)}{/if}
							</span>
							<span class="activity-row__text">
								<span class="activity-row__sentence"><strong class="activity-row__name" style={row.color ? $inkFor(row.color) : ''}>{row.name}</strong> {row.text}{#if row.where} <strong class="activity-row__where">{row.where}</strong>{/if}</span>
								<span class="activity-row__place">{row.place}{#if row.unread}<span class="sr-only"> · unread</span>{/if}</span>
								{#if row.preview}<span class="activity-row__preview">{row.preview}</span>{/if}
							</span>
							{#if row.kind === 'request' && row.requestId}
								{@const id = row.requestId}
								<span class="activity-row__actions">
									<button type="button" class="w-btn w-btn--primary w-btn--sm" disabled={!!busyRequest} aria-label={`Accept ${row.name}'s friend request`} on:click={() => void answer(id, true)}>Accept</button>
									<button type="button" class="w-btn w-btn--quiet w-btn--sm" disabled={!!busyRequest} aria-label={`Decline ${row.name}'s friend request`} on:click={() => void answer(id, false)}>Decline</button>
								</span>
							{:else if row.kind === 'remote-request' && row.serverUrl}
								{@const url = row.serverUrl}
								<span class="activity-row__actions"><button type="button" class="w-btn w-btn--sm" on:click={() => openRemoteFriends(url)}>Switch to review</button></span>
							{/if}
							{#if row.time}<time class="activity-row__time" datetime={new Date(row.time).toISOString()}>{time(row.time)}</time>{/if}
							{#if row.open}
								<button type="button" class="activity-row__hit" aria-label={`${row.name} ${row.text}${row.where ? ` ${row.where}` : ''}, ${row.place}`} on:click={row.open}></button>
							{/if}
						</li>
					{/each}
				</ul>
			{:else}
				{@const empty = EMPTY[filter]}
				<div class="activity__empty">
					<Icon name={empty.glyph} size={28} class="activity__empty-glyph" />
					<h2 class="activity__empty-title">{empty.title}</h2>
					<p class="activity__empty-text">{empty.text}</p>
					<button type="button" class="w-btn" on:click={() => dispatch('settings')}>Notification settings</button>
				</div>
			{/if}
		</div>
	</div>
</main>

<style>
	.activity { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--w-bg); color: var(--w-text); }
	.activity__phone-seg { flex: none; padding: 10px 16px; border-bottom: var(--w-bw) solid var(--w-line); }
	.activity__phone-seg :global(.w-seg) { width: 100%; }
	.activity__phone-seg :global(.w-seg > *) { flex: 1; }
	.activity__scroll { flex: 1; min-height: 0; overflow-y: auto; }
	.activity__column { box-sizing: border-box; width: min(760px, 100%); margin: 0 auto; padding: 20px var(--w-gutter, 32px) 48px; }
	.activity__column :global(.activity__notice) { margin-bottom: 12px; }
	.activity__filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px 20px; margin-bottom: 12px; }
	.activity__server { display: flex; flex-direction: column; width: min(280px, 100%); }
	.activity__unread { display: inline-flex; align-items: center; gap: 10px; min-height: 38px; font: var(--w-t-label); color: var(--w-text); }
	.activity__list { margin: 0; padding: 0; list-style: none; }

	.activity-row { position: relative; display: grid; grid-template-columns: 28px minmax(0, 1fr) auto auto; align-items: center; column-gap: 14px; min-height: 56px; padding: 8px 10px; border-bottom: var(--w-bw) solid var(--w-line); border-radius: 0; }
	.activity-row--open:hover { background: color-mix(in srgb, var(--w-raise) 60%, transparent); }
	.activity-row__hit { position: absolute; inset: 0; z-index: 0; min-height: 0; margin: 0; padding: 0; border: 0; border-radius: var(--radius-md); background: transparent; cursor: pointer; }
	.activity-row__hit:focus-visible { outline: 2px solid var(--w-accent); outline-offset: -2px; }
	.activity-row__actions { position: relative; z-index: 1; display: inline-flex; gap: 6px; }
	.activity-row__stamp { display: grid; place-items: center; width: 28px; height: 28px; border-radius: var(--w-avr); background: var(--disc, var(--w-raise)); color: var(--on, var(--w-text)); font: 600 calc(12px * var(--w-fs)) / 1 var(--w-serif); user-select: none; }
	.activity-row__stamp--glyph { background: var(--w-raise); color: var(--w-mute); }
	.activity-row__text { position: relative; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	/* Unread: a 6px accent dot at the text's left edge, never a bar. */
	.activity-row--unread .activity-row__text::before { content: ''; position: absolute; left: -10px; top: calc(9px * var(--w-fs)); width: 6px; height: 6px; border-radius: var(--w-pill); background: var(--w-accent); }
	.activity-row__sentence { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: var(--w-t-ui); color: var(--w-mute); }
	.activity-row--unread .activity-row__sentence { color: var(--w-text); }
	.activity-row__name { font-weight: 500; color: var(--ink, var(--w-text)); }
	.activity-row__where { font-weight: 500; color: var(--w-text); }
	.activity-row__place { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: var(--w-t-small); color: var(--w-faint); }
	.activity-row__preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: var(--w-t-small); color: var(--w-mute); }
	.activity-row__time { font: var(--w-t-mono); font-variant-numeric: tabular-nums; color: var(--w-faint); white-space: nowrap; }

	.activity__empty { padding: 48px 0 0; max-width: 460px; }
	.activity__empty :global(.activity__empty-glyph) { color: var(--w-faint); }
	.activity__empty-title { margin: 12px 0 6px; font: 600 calc(20px * var(--w-fs)) / calc(26px * var(--w-fs)) var(--w-serif); color: var(--w-text); }
	.activity__empty-text { margin: 0 0 16px; font: var(--w-t-ui); color: var(--w-mute); }

	:global(:root[data-char='contrast']) .activity-row--open:hover { background: transparent; box-shadow: inset 0 0 0 var(--w-bw) var(--w-text); }

	@media (max-width: 768px) {
		.activity__column { padding: 8px 16px 32px; }
		.activity-row { grid-template-columns: 28px minmax(0, 1fr) auto; row-gap: 6px; padding: 10px 4px; }
		.activity-row__actions { grid-column: 2 / -1; grid-row: 2; }
		.activity-row__time { grid-column: 3; grid-row: 1; }
	}
	@media (pointer: coarse) {
		.activity-row { min-height: 64px; }
	}
</style>
