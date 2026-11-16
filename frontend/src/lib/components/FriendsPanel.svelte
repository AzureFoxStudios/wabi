<script lang="ts">
	import { _ } from '$lib/i18n';
	import { createEventDispatcher, onMount } from 'svelte';
	import { getAuthToken } from '$lib/authSession';
	import { currentUser, serverMembers, users } from '$lib/socket';
	import type { User } from '$lib/socket-types';
	import { buildDmDirectoryUsers } from '$lib/dmUserDirectory';
	import { mediaUrl } from '$lib/mediaUrl';
	import ProfileName from './ProfileName.svelte';
	import ProfileMedia from './ProfileMedia.svelte';
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
	$: rosterById = new Map([...$serverMembers, ...$users]
		.filter((person) => typeof person.dbUserId === 'number')
		.map((person) => [person.dbUserId!, person] as const));

	function matchesSearch(person: FriendPerson, queryText: string): boolean {
		const query = queryText.trim().toLowerCase();
		return !query || person.username.toLowerCase().includes(query) || (person.handle || '').toLowerCase().includes(query);
	}

	function rosterUser(userId: number): User | null {
		return rosterById.get(userId) || null;
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
			actionError = error instanceof Error ? error.message : $_('friends.action_failed');
		} finally {
			pendingAction = '';
		}
	}

	function message(person: FriendPerson) {
		dispatch('message', userFromPerson(person));
	}

	function confirmRemove(person: FriendPerson) {
		if (!window.confirm($_('friends.confirm_remove', { values: { name: person.username } }))) return;
		void runAction(`remove-${person.user_id}`, () => removeFriendship(person.user_id), $_('friends.removed'));
	}
</script>

<div class="friends-panel">
	<header class="friends-hero"><div><h2>{$_('friends.heading')}</h2><p>{$_('friends.intro')}</p></div><span>{$friendships.friends.length === 1 ? $_('friends.count_one') : $_('friends.count_many', { values: { count: $friendships.friends.length } })}</span></header>
	{#if !canManageFriends}<p class="friends-empty">{$_('friends.sign_in')}</p>{/if}

	{#if $friendships.error}
		<div class="friends-feedback error" role="alert">
			<span>{$friendships.error}</span>
			<button type="button" on:click={() => refreshFriendships()}>{$_('friends.retry')}</button>
		</div>
	{/if}
	{#if actionError}<p class="friends-feedback error" role="alert">{actionError}</p>{/if}
	{#if actionNotice}<p class="friends-feedback" role="status">{actionNotice}</p>{/if}
	{#if $friendships.loading && !$friendships.ready}<p class="friends-feedback" role="status">{$_('friends.loading')}</p>{/if}

	{#if $friendships.ready}
		<div class="friends-request-overview" class:has-requests={$friendships.incoming.length > 0} role="status" aria-live="polite">
			<strong>{$friendships.incoming.length > 0 ? ($friendships.incoming.length === 1 ? $_('friends.incoming_one') : $_('friends.incoming_many', { values: { count: $friendships.incoming.length } })) : $_('friends.no_requests')}</strong>
			<span>{$friendships.outgoing.length > 0 ? ($friendships.outgoing.length === 1 ? $_('friends.outgoing_one') : $_('friends.outgoing_many', { values: { count: $friendships.outgoing.length } })) : $_('friends.find_people')}</span>
		</div>

		<section class="friends-section friends-request-section" class:has-requests={$friendships.incoming.length > 0} aria-labelledby="incoming-friends-title">
			<h3 id="incoming-friends-title">{$_('friends.requests_to_review')} <span>{$friendships.incoming.length}</span></h3>
			{#if $friendships.incoming.length === 0}
				<p class="friends-empty">{$_('friends.no_incoming')}</p>
			{:else}
				{#each $friendships.incoming as request (request.id)}
					{@const profile = rosterById.get(request.user_id)}
					{@const avatar = profile?.profilePicture || request.profile_picture}
					<div class="friend-row">
						<div class="friend-avatar" style:background={request.color || 'var(--accent-primary)'}>
							{#if avatar}<ProfileMedia src={mediaUrl(avatar)} decorative />{:else}{request.username[0]?.toUpperCase() || '?'}{/if}
						</div>
						<div class="friend-details"><strong><ProfileName username={request.username} font={profile?.usernameFont} color={profile?.color || request.color} /></strong><span>{$_('friends.wants_friends')}</span></div>
						<div class="friend-actions">
							<button type="button" class="friend-primary" disabled={Boolean(pendingAction)} on:click={() => runAction(`accept-${request.id}`, () => acceptFriendship(request.id), $_('friends.now_friends', { values: { name: request.username } }))}>{pendingAction === `accept-${request.id}` ? $_('friends.accepting') : $_('friends.accept')}</button>
							<button type="button" disabled={Boolean(pendingAction)} on:click={() => runAction(`decline-${request.id}`, () => dismissFriendship(request.id), $_('friends.declined'))}>{pendingAction === `decline-${request.id}` ? $_('friends.declining') : $_('friends.decline')}</button>
						</div>
					</div>
				{/each}
			{/if}
		</section>

		<section class="friends-section friends-request-section" aria-labelledby="outgoing-friends-title">
			<h3 id="outgoing-friends-title">{$_('friends.sent_requests')} <span>{$friendships.outgoing.length}</span></h3>
			{#if $friendships.outgoing.length === 0}
				<p class="friends-empty">{$_('friends.no_outgoing')}</p>
			{:else}
				{#each $friendships.outgoing as request (request.id)}
					{@const profile = rosterById.get(request.user_id)}
					{@const avatar = profile?.profilePicture || request.profile_picture}
					<div class="friend-row friend-row-outgoing">
						<div class="friend-avatar" style:background={request.color || 'var(--accent-primary)'}>
							{#if avatar}<ProfileMedia src={mediaUrl(avatar)} decorative />{:else}{request.username[0]?.toUpperCase() || '?'}{/if}
						</div>
						<div class="friend-details"><strong><ProfileName username={request.username} font={profile?.usernameFont} color={profile?.color || request.color} /></strong><span>{$_('friends.waiting_reply')}</span></div>
						<div class="friend-actions">
							<button type="button" class="cancel-request" aria-label={$_('friends.cancel_label', { values: { name: request.username } })} title={$_('friends.cancel_title')} disabled={Boolean(pendingAction)} on:click={() => runAction(`cancel-${request.id}`, () => dismissFriendship(request.id), $_('friends.cancelled'))}>{pendingAction === `cancel-${request.id}` ? '…' : '×'}</button>
						</div>
					</div>
				{/each}
			{/if}
		</section>
	{/if}

	<div class="friends-search-wrap">
		<label for="friends-search">{$_('friends.search_label')}</label>
		<input id="friends-search" type="search" bind:value={search} placeholder={$_('friends.search_placeholder')} autocomplete="off" />
	</div>

	{#if $friendships.ready}
		<section class="friends-section" aria-labelledby="friends-list-title">
			<h3 id="friends-list-title">{$_('friends.friends_heading')} <span>{$friendships.friends.length}</span></h3>
			{#if visibleFriends.length === 0}
				<p class="friends-empty">{$friendships.friends.length ? $_('friends.no_match') : $_('friends.none_yet')}</p>
			{:else}
				{#each visibleFriends as person (person.user_id)}
					{@const profile = rosterById.get(person.user_id)}
					{@const avatar = profile?.profilePicture || person.profile_picture}
					{@const status = profile?.status || person.status || 'offline'}
					<div class="friend-row">
						<div class="friend-avatar" style:background={person.color || 'var(--accent-primary)'}>
							{#if avatar}<ProfileMedia src={mediaUrl(avatar)} decorative />{:else}{person.username[0]?.toUpperCase() || '?'}{/if}
							<span class="friend-status" style:background={statusColor(status)} aria-label={status}></span>
						</div>
						<div class="friend-details"><strong><ProfileName username={person.username} font={profile?.usernameFont} color={profile?.color || person.color} /></strong><span>{status}</span></div>
						<div class="friend-actions">
							<button type="button" class="friend-primary" disabled={Boolean(pendingAction)} on:click={() => message(person)}>{$_('friends.message')}</button>
							<button type="button" disabled={Boolean(pendingAction)} on:click={() => confirmRemove(person)} aria-label={$_('friends.remove_label', { values: { name: person.username } })}>{pendingAction === `remove-${person.user_id}` ? $_('friends.removing') : $_('friends.remove')}</button>
						</div>
					</div>
				{/each}
			{/if}
		</section>

	{/if}

	<section class="friends-section" aria-labelledby="find-friends-title">
		<h3 id="find-friends-title">{$_('friends.people_heading')}</h3>
		{#if discoverable.length === 0}
			<p class="friends-empty">{!canManageFriends ? $_('friends.need_account') : search ? $_('friends.no_people_match') : $_('friends.all_here')}</p>
		{:else}
			{#each discoverable as person (person.dbUserId)}
				{@const relation = friendshipRelation($friendships, person.dbUserId)}
				<div class="friend-row">
					<div class="friend-avatar" style:background={person.color || 'var(--accent-primary)'}>
						{#if person.profilePicture}<ProfileMedia src={mediaUrl(person.profilePicture)} decorative />{:else}{person.username[0]?.toUpperCase() || '?'}{/if}
						<span class="friend-status" style:background={statusColor(person.status)} aria-label={person.status}></span>
					</div>
					<div class="friend-details"><strong><ProfileName username={person.username} font={person.usernameFont} color={person.color} /></strong><span>{relation.kind === 'outgoing' ? $_('friends.request_sent_status') : person.handle ? `@${person.handle}` : person.status}</span></div>
					<div class="friend-actions">
						{#if relation.kind === 'outgoing'}
							<span class="friend-pending-label" aria-label={$_('friends.request_sent_label', { values: { name: person.username } })}>{$_('friends.request_sent')}</span>
						{:else}
							<button type="button" class="friend-primary" disabled={Boolean(pendingAction) || !$friendships.ready} on:click={() => runAction(`add-${person.dbUserId}`, () => requestFriendship(person.dbUserId!), $_('friends.sent_to', { values: { name: person.username } }))}>{pendingAction === `add-${person.dbUserId}` ? $_('friends.sending') : $_('friends.add')}</button>
						{/if}
						<button type="button" disabled={Boolean(pendingAction)} on:click={() => dispatch('message', person)}>{$_('friends.message')}</button>
					</div>
				</div>
			{/each}
		{/if}
	</section>
</div>

<style>
.friends-hero{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1.25rem;border:1px solid var(--border-subtle);border-radius:var(--radius-lg);background:var(--surface-raised)}.friends-hero h2{margin:0;color:var(--text-heading)}.friends-hero p{margin:.5rem 0 0;color:var(--text-secondary)}.friends-hero>span{white-space:nowrap;color:var(--text-secondary)}
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
	.friend-row { border:1px solid var(--border-subtle);background:var(--surface-raised);margin-block:.5rem;display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; gap: var(--space-2, 8px); align-items: center; padding: var(--space-2, 8px); border-radius: var(--radius-lg, 12px); }
	.friend-row:hover { background: color-mix(in srgb, var(--text-heading) 5%, transparent); }
	.friend-avatar { position: relative; display: flex; align-items: center; justify-content: center; width: 38px; height: 38px; border-radius: var(--radius-full, 9999px); color: white; font-weight: 700; overflow: visible; }
	.friend-avatar :global(img), .friend-avatar :global(canvas) { width: 100%; height: 100%; border-radius: inherit; object-fit: cover; }
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

	@container friends-panel (max-width: 600px) {
		.friend-row.friend-row-outgoing { grid-template-columns: 32px minmax(0, 1fr) 36px; padding: 8px; }
		.friend-row-outgoing .friend-avatar { width: 32px; height: 32px; }
		.friend-row-outgoing .friend-actions { grid-column: 3; grid-row: 1; }
	}
	.friend-actions .cancel-request { width: 36px; height: 36px; padding: 0; font-size: 22px; }
</style>
