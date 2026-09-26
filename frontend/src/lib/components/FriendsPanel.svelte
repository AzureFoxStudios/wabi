<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import { getAuthToken } from '$lib/authSession';
	import { currentUser, serverMembers, users } from '$lib/socket';
	import type { User } from '$lib/socket-types';
	import { buildDmDirectoryUsers } from '$lib/dmUserDirectory';
	import { mediaUrl } from '$lib/mediaUrl';
	import type { FriendPerson } from '$lib/api/friends';
	import { canFriendUser, friendshipRelation } from '$lib/friendshipRelation';
	import {
		acceptFriendship,
		dismissFriendship,
		friendships,
		refreshFriendships,
		removeFriendship,
		requestFriendship,
		startFriendshipSync
	} from '$lib/friendships';

	const dispatch = createEventDispatcher<{ message: User }>();
	let search = '';
	let pendingAction = '';
	let actionError = '';
	let actionNotice = '';

	onMount(startFriendshipSync);
	$: canManageFriends = Boolean($currentUser?.dbUserId && getAuthToken());

	$: discoverable = buildDmDirectoryUsers({
		onlineUsers: $users,
		serverMembers: $serverMembers,
		currentUser: $currentUser,
		searchQuery: search
	}).filter((person) =>
		canManageFriends &&
		canFriendUser(person) &&
		!['friend', 'incoming'].includes(friendshipRelation($friendships, person.dbUserId).kind)
	);
	$: visibleFriends = $friendships.friends.filter((person) => matchesSearch(person, search));

	function matchesSearch(person: FriendPerson, queryText: string): boolean {
		const query = queryText.trim().toLowerCase();
		return !query || person.username.toLowerCase().includes(query) || (person.handle || '').toLowerCase().includes(query);
	}

	function rosterUser(userId: number): User | null {
		return [...$users, ...$serverMembers].find((person) => person.dbUserId === userId) || null;
	}

	function visibleStatus(person: FriendPerson): string {
		return rosterUser(person.user_id)?.status || person.status || 'offline';
	}

	function visibleAvatar(person: FriendPerson): string | null {
		return rosterUser(person.user_id)?.profilePicture || person.profile_picture;
	}

	function userFromPerson(person: FriendPerson): User {
		const known = rosterUser(person.user_id);
		if (known) return known;
		const status: User['status'] = person.status === 'active' || person.status === 'away' || person.status === 'busy'
			? person.status
			: 'offline';
		return {
			id: `user-${person.user_id}`,
			dbUserId: person.user_id,
			username: person.username,
			handle: person.handle || undefined,
			profilePicture: person.profile_picture || undefined,
			color: person.color || 'var(--accent-primary)',
			status,
			isRegistered: true
		};
	}

	function statusColor(status: string | null): string {
		if (status === 'active') return 'var(--status-online, #22c55e)';
		if (status === 'away') return 'var(--status-away, #f59e0b)';
		if (status === 'busy') return 'var(--status-busy, #ef4444)';
		return 'var(--status-offline, #708090)';
	}

	async function runAction(key: string, action: () => Promise<void>, success: string) {
		if (pendingAction) return;
		pendingAction = key;
		actionError = '';
		actionNotice = '';
		try {
			await action();
			actionNotice = success;
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Friend action failed.';
		} finally {
			pendingAction = '';
		}
	}

	function message(person: FriendPerson) {
		dispatch('message', userFromPerson(person));
	}

	function confirmRemove(person: FriendPerson) {
		if (!window.confirm(`Remove ${person.username} from your friends?`)) return;
		void runAction(`remove-${person.user_id}`, () => removeFriendship(person.user_id), 'Friend removed.');
	}
</script>

<div class="friends-panel">
	{#if !canManageFriends}<p class="friends-empty">Sign in with a registered account to add friends.</p>{/if}

	{#if $friendships.error}
		<div class="friends-feedback error" role="alert">
			<span>{$friendships.error}</span>
			<button type="button" on:click={() => refreshFriendships()}>Retry</button>
		</div>
	{/if}
	{#if actionError}<p class="friends-feedback error" role="alert">{actionError}</p>{/if}
	{#if actionNotice}<p class="friends-feedback" role="status">{actionNotice}</p>{/if}
	{#if $friendships.loading && !$friendships.ready}<p class="friends-feedback" role="status">Loading friends…</p>{/if}

	{#if $friendships.ready}
		<div class="friends-request-overview" class:has-requests={$friendships.incoming.length > 0} role="status" aria-live="polite">
			<strong>{$friendships.incoming.length > 0 ? `${$friendships.incoming.length} friend ${$friendships.incoming.length === 1 ? 'request' : 'requests'} waiting for you` : 'No requests to review'}</strong>
			<span>{$friendships.outgoing.length > 0 ? `${$friendships.outgoing.length} sent ${$friendships.outgoing.length === 1 ? 'request' : 'requests'} awaiting a reply` : 'Find people on this server to send a request.'}</span>
		</div>

		<section class="friends-section friends-request-section" class:has-requests={$friendships.incoming.length > 0} aria-labelledby="incoming-friends-title">
			<h3 id="incoming-friends-title">Requests to review <span>{$friendships.incoming.length}</span></h3>
			{#if $friendships.incoming.length === 0}
				<p class="friends-empty">No friend requests waiting for you.</p>
			{:else}
				{#each $friendships.incoming as request (request.id)}
					<div class="friend-row">
						<div class="friend-avatar" style:background={request.color || 'var(--accent-primary)'}>
							{#if visibleAvatar(request)}<img src={mediaUrl(visibleAvatar(request)!)} alt="" />{:else}{request.username[0]?.toUpperCase() || '?'}{/if}
						</div>
						<div class="friend-details"><strong>{request.username}</strong><span>Wants to be friends</span></div>
						<div class="friend-actions">
							<button type="button" class="friend-primary" disabled={Boolean(pendingAction)} on:click={() => runAction(`accept-${request.id}`, () => acceptFriendship(request.id), `You and ${request.username} are friends.`)}>{pendingAction === `accept-${request.id}` ? 'Accepting…' : 'Accept'}</button>
							<button type="button" disabled={Boolean(pendingAction)} on:click={() => runAction(`decline-${request.id}`, () => dismissFriendship(request.id), 'Request declined.')}>{pendingAction === `decline-${request.id}` ? 'Declining…' : 'Decline'}</button>
						</div>
					</div>
				{/each}
			{/if}
		</section>

		<section class="friends-section friends-request-section" aria-labelledby="outgoing-friends-title">
			<h3 id="outgoing-friends-title">Sent requests <span>{$friendships.outgoing.length}</span></h3>
			{#if $friendships.outgoing.length === 0}
				<p class="friends-empty">No requests awaiting a reply.</p>
			{:else}
				{#each $friendships.outgoing as request (request.id)}
					<div class="friend-row">
						<div class="friend-avatar" style:background={request.color || 'var(--accent-primary)'}>
							{#if visibleAvatar(request)}<img src={mediaUrl(visibleAvatar(request)!)} alt="" />{:else}{request.username[0]?.toUpperCase() || '?'}{/if}
						</div>
						<div class="friend-details"><strong>{request.username}</strong><span>Waiting for a reply</span></div>
						<div class="friend-actions">
							<button type="button" disabled={Boolean(pendingAction)} on:click={() => runAction(`cancel-${request.id}`, () => dismissFriendship(request.id), 'Request cancelled.')}>{pendingAction === `cancel-${request.id}` ? 'Cancelling…' : 'Cancel'}</button>
						</div>
					</div>
				{/each}
			{/if}
		</section>
	{/if}

	<div class="friends-search-wrap">
		<label for="friends-search">Search friends and members</label>
		<input id="friends-search" type="search" bind:value={search} placeholder="Search members" autocomplete="off" />
	</div>

	{#if $friendships.ready}
		<section class="friends-section" aria-labelledby="friends-list-title">
			<h3 id="friends-list-title">Friends <span>{$friendships.friends.length}</span></h3>
			{#if visibleFriends.length === 0}
				<p class="friends-empty">{$friendships.friends.length ? 'No friends match your search.' : 'No friends yet. Find someone below to send a request.'}</p>
			{:else}
				{#each visibleFriends as person (person.user_id)}
					<div class="friend-row">
						<div class="friend-avatar" style:background={person.color || 'var(--accent-primary)'}>
							{#if visibleAvatar(person)}<img src={mediaUrl(visibleAvatar(person)!)} alt="" />{:else}{person.username[0]?.toUpperCase() || '?'}{/if}
							<span class="friend-status" style:background={statusColor(visibleStatus(person))} aria-label={visibleStatus(person)}></span>
						</div>
						<div class="friend-details"><strong>{person.username}</strong><span>{visibleStatus(person)}</span></div>
						<div class="friend-actions">
							<button type="button" class="friend-primary" disabled={Boolean(pendingAction)} on:click={() => message(person)}>Message</button>
							<button type="button" disabled={Boolean(pendingAction)} on:click={() => confirmRemove(person)} aria-label={`Remove ${person.username} from friends`}>{pendingAction === `remove-${person.user_id}` ? 'Removing…' : 'Remove'}</button>
						</div>
					</div>
				{/each}
			{/if}
		</section>

	{/if}

	<section class="friends-section" aria-labelledby="find-friends-title">
		<h3 id="find-friends-title">People on this server</h3>
		{#if discoverable.length === 0}
			<p class="friends-empty">{!canManageFriends ? 'Friend requests need a registered account.' : search ? 'No people match your search.' : 'Everyone here is already a friend or has a pending request.'}</p>
		{:else}
			{#each discoverable as person (person.dbUserId)}
				{@const relation = friendshipRelation($friendships, person.dbUserId)}
				<div class="friend-row">
					<div class="friend-avatar" style:background={person.color || 'var(--accent-primary)'}>
						{#if person.profilePicture}<img src={mediaUrl(person.profilePicture)} alt="" />{:else}{person.username[0]?.toUpperCase() || '?'}{/if}
						<span class="friend-status" style:background={statusColor(person.status)} aria-label={person.status}></span>
					</div>
					<div class="friend-details"><strong>{person.username}</strong><span>{relation.kind === 'outgoing' ? 'Request sent · waiting for a reply' : person.handle ? `@${person.handle}` : person.status}</span></div>
					<div class="friend-actions">
						{#if relation.kind === 'outgoing'}
							<span class="friend-pending-label" aria-label={`Friend request sent to ${person.username}`}>Request sent</span>
						{:else}
							<button type="button" class="friend-primary" disabled={Boolean(pendingAction) || !$friendships.ready} on:click={() => runAction(`add-${person.dbUserId}`, () => requestFriendship(person.dbUserId!), `Request sent to ${person.username}.`)}>{pendingAction === `add-${person.dbUserId}` ? 'Sending…' : 'Add friend'}</button>
						{/if}
						<button type="button" disabled={Boolean(pendingAction)} on:click={() => dispatch('message', person)}>Message</button>
					</div>
				</div>
			{/each}
		{/if}
	</section>
</div>

<style>
	.friends-panel { flex: 1; width: 100%; max-width: 800px; min-height: 0; margin-inline: auto; box-sizing: border-box; container: friends-panel / inline-size; overflow: auto; padding: var(--space-3, 12px); color: var(--text-heading); }
	.friends-request-overview { display: grid; gap: var(--space-1, 4px); margin: var(--space-1, 4px) var(--space-1, 4px) var(--space-3, 12px); padding: var(--space-3, 12px); border: 1px solid var(--color-border-primary); border-radius: var(--radius-lg, 12px); background: var(--surface-raised); }
	.friends-request-overview.has-requests { border-color: color-mix(in srgb, var(--accent-primary-color, var(--accent-primary)) 55%, var(--color-border-primary)); background: color-mix(in srgb, var(--accent-primary-color, var(--accent-primary)) 13%, var(--surface-base)); }
	.friends-request-overview strong { font-size: var(--font-size-sm, 13px); }
	.friends-request-overview span { color: var(--text-secondary); font-size: var(--font-size-xs, 11px); line-height: 1.4; }
	.friends-search-wrap { display: grid; gap: var(--space-2, 8px); padding: var(--space-1, 4px) var(--space-1, 4px) var(--space-3, 12px); }
	.friends-search-wrap label { color: var(--text-secondary); font-size: var(--font-size-xs, 11px); font-weight: 600; }
	.friends-search-wrap input { width: 100%; min-height: 40px; padding: 0 var(--space-3, 12px); border-radius: var(--radius-md, 8px); border: 1px solid var(--color-border-primary); background: var(--surface-input, var(--surface-sunken)); color: var(--text-heading); font: inherit; font-size: var(--font-size-sm, 13px); }
	.friends-search-wrap input:focus-visible { outline: 2px solid var(--accent-primary-color, var(--accent-primary)); outline-offset: 2px; }
	.friends-section { margin: var(--space-2, 8px) 0 var(--space-4, 16px); }
	.friends-request-section { padding: var(--space-1, 4px); border: 1px solid var(--color-border-primary); border-radius: var(--radius-lg, 12px); }
	.friends-request-section.has-requests { border-color: color-mix(in srgb, var(--accent-primary-color, var(--accent-primary)) 42%, var(--color-border-primary)); }
	.friends-request-section:not(:has(.friend-row)) { display: none; }
	.friends-section h3 { display: flex; align-items: center; gap: var(--space-2, 8px); margin: 0 0 var(--space-1, 4px); padding: var(--space-2, 8px) var(--space-1, 4px); color: var(--text-secondary); font-size: var(--font-size-xs, 11px); font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
	.friends-section h3 span { color: var(--text-muted); font-weight: 600; }
	.friends-empty { margin: 0; padding: var(--space-2, 8px) var(--space-1, 4px); color: var(--text-muted); font-size: var(--font-size-sm, 13px); line-height: 1.5; }
	.friend-row { display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; gap: var(--space-2, 8px); align-items: center; padding: var(--space-2, 8px); border-radius: var(--radius-lg, 12px); }
	.friend-row:hover { background: color-mix(in srgb, var(--text-heading) 5%, transparent); }
	.friend-avatar { position: relative; display: flex; align-items: center; justify-content: center; width: 38px; height: 38px; border-radius: var(--radius-full, 9999px); color: white; font-weight: 700; overflow: visible; }
	.friend-avatar img { width: 100%; height: 100%; border-radius: inherit; object-fit: cover; }
	.friend-status { position: absolute; right: 0; bottom: 0; width: 10px; height: 10px; border: 2px solid var(--surface-base); border-radius: 50%; }
	.friend-details { display: grid; min-width: 0; gap: 2px; }
	.friend-details strong { font-size: var(--font-size-sm, 13px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.friend-details span { color: var(--text-muted); font-size: var(--font-size-xs, 11px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.friend-actions { grid-column: 3; display: flex; flex-wrap: wrap; gap: var(--space-1, 4px); }
	.friend-pending-label { display: inline-flex; align-items: center; min-height: 32px; padding: 0 var(--space-2, 8px); border: 1px solid color-mix(in srgb, var(--accent-primary-color, var(--accent-primary)) 45%, transparent); border-radius: var(--radius-md, 8px); color: var(--text-secondary); font-size: var(--font-size-xs, 11px); font-weight: 600; }
	.friend-actions button, .friends-feedback button { min-height: 32px; padding: var(--space-1, 4px) var(--space-2, 8px); border: 1px solid var(--color-border-primary); border-radius: var(--radius-md, 8px); background: var(--surface-raised); color: var(--text-heading); font: inherit; font-size: var(--font-size-xs, 11px); font-weight: 600; cursor: pointer; }
	.friend-actions button.friend-primary { border-color: color-mix(in srgb, var(--accent-primary-color, var(--accent-primary)) 45%, transparent); background: color-mix(in srgb, var(--accent-primary-color, var(--accent-primary)) 18%, var(--surface-base)); }
	.friend-actions button:hover:not(:disabled), .friends-feedback button:hover { background: var(--surface-hover, var(--surface-raised)); }
	.friend-actions button:disabled { opacity: .5; cursor: wait; }
	.friends-feedback { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2, 8px); margin: var(--space-2, 8px) 0; padding: var(--space-2, 8px); border-radius: var(--radius-md, 8px); background: var(--surface-raised); color: var(--text-secondary); font-size: var(--font-size-sm, 13px); }
	.friends-feedback.error { color: var(--color-danger, #ef4444); border: 1px solid color-mix(in srgb, var(--color-danger, #ef4444) 35%, transparent); }
	@container friends-panel (max-width: 600px) { .friend-row { grid-template-columns: 44px minmax(0, 1fr); padding: var(--space-3, 12px) var(--space-2, 8px); } .friend-avatar { width: 44px; height: 44px; } .friend-actions { grid-column: 2; grid-row: 2; } .friend-actions button { min-height: 40px; } }
</style>
