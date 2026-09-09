<script lang="ts">
	import { onMount } from 'svelte';
	import { users, serverMembers, currentUser, kickGroupMember, addGroupMember, leaveGroup } from '$lib/socket';
	import { buildDmDirectoryUsers, getDmDirectoryKey } from '$lib/dmUserDirectory';
	import GroupAvatar from './GroupAvatar.svelte';
	import type { Channel, User } from '$lib/socket';

	let { channel }: { channel: Channel } = $props();
	let showAddMember = $state(false);
	let addSearchQuery = $state('');
	let busy = $state(false);
	let operationError = $state('');

	// Mirrors the popout `disableAllBanners` profile-visibility kill switch
	// (localStorage `wabi:profile:visibility` -> disableAll).
	let disableAllBanners = $state(false);

	onMount(() => {
		try {
			const raw = localStorage.getItem('wabi:profile:visibility');
			if (!raw) return;
			const v = JSON.parse(raw);
			if (typeof v.disableAll === 'boolean') disableAllBanners = v.disableAll;
		} catch {
			// ignore malformed local state
		}
	});
	let myStableId = $derived($currentUser ? getDmDirectoryKey($currentUser) : null);
	let isOwner = $derived(Boolean(myStableId && channel.ownerId === myStableId));
	let directory = $derived(buildDmDirectoryUsers({
		onlineUsers: $users, serverMembers: $serverMembers, currentUser: null
	}));
	let memberRecords = $derived((channel.members || []).map((stableId): User => {
		return directory.find(user => getDmDirectoryKey(user) === stableId) ||
			(channel.memberUsers || []).find(user => getDmDirectoryKey(user) === stableId) ||
			{ id: stableId, username: stableId.startsWith('user-') ? `User ${stableId.slice(5)}` : stableId,
			  color: 'var(--text-muted)', status: 'offline' };
	}));
	let addableUsers = $derived(buildDmDirectoryUsers({
		onlineUsers: $users, serverMembers: $serverMembers, currentUser: $currentUser, searchQuery: addSearchQuery
	}).filter(user => /^user-[1-9][0-9]*$/.test(getDmDirectoryKey(user)) &&
		!channel.members?.includes(getDmDirectoryKey(user))));

	async function perform(work: () => Promise<void>, after?: () => void) {
		if (busy) return;
		const id = channel.id;
		busy = true;
		operationError = '';
		try {
			await work();
			if (channel?.id === id) after?.();
		} catch (error) {
			if (channel?.id === id) operationError = error instanceof Error ? error.message : 'Could not confirm the group change';
		} finally { busy = false; }
	}
	function handleKick(member: User) {
		return perform(() => kickGroupMember(channel.id, getDmDirectoryKey(member)));
	}
	function handleAdd(user: User) {
		return perform(() => addGroupMember(channel.id, getDmDirectoryKey(user)), () => {
			showAddMember = false;
			addSearchQuery = '';
		});
	}
	function handleLeave() {
		// The authoritative removal closes only this group's selected surfaces.
		return perform(() => leaveGroup(channel.id));
	}
	function isMemberCurrentUser(member: User): boolean {
		return getDmDirectoryKey(member) === myStableId;
	}
</script>

<div class="group-settings" aria-busy={busy}>
	{#if operationError}<p class="operation-error" role="alert">{operationError}</p>{/if}
	{#if busy}<p role="status">Waiting for server confirmation…</p>{/if}
	<div class="settings-section avatar-section">
		<div class="avatar-display">
			<GroupAvatar {channel} size={64} />
		</div>
		<h3 class="group-name">{channel.name}</h3>
		<span class="member-count">{channel.members?.length || 0} members</span>
		{#if isOwner}
			<p class="avatar-note">Custom group avatars are not available yet.</p>
		{/if}
	</div>

	<div class="settings-section">
		<div class="section-header">
			<h4>Members</h4>
			{#if isOwner}
				<button class="add-member-btn" disabled={busy} onclick={() => { showAddMember = !showAddMember; }}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
					Add
				</button>
			{/if}
		</div>

		{#if showAddMember && isOwner}
			<div class="add-member-panel">
				<input
					type="text"
					class="add-search"
					placeholder="Search users..." aria-label="Search group invitees" disabled={busy}
					bind:value={addSearchQuery}
				/>
				<div class="add-user-list">
					{#each addableUsers.slice(0, 10) as user (user.id)}
						<button class="add-user-item" disabled={busy} onclick={() => handleAdd(user)}>
							{#if user.profilePicture}
								<img src={user.profilePicture} alt={user.username} class="add-user-avatar" />
							{:else}
								<div class="add-user-avatar-ph" style="background-color: {user.roleColor || user.color}">
									{user.username.charAt(0).toUpperCase()}
								</div>
							{/if}
							<span>{user.username}</span>
						</button>
					{:else}
						<div class="no-users">No users to add</div>
					{/each}
				</div>
			</div>
		{/if}

		<div class="member-list">
			{#each memberRecords as member (member.id)}
				<div class="member-item">
					<div class="member-avatar-wrap">
						{#if member.profilePicture}
							<img src={member.profilePicture} alt={member.username} class="member-avatar" />
						{:else}
							<div class="member-avatar-ph" style="background-color: {member.roleColor || member.color}">
								{member.username.charAt(0).toUpperCase()}
							</div>
						{/if}
						{#if member.overlayUrl && !disableAllBanners}
							<span class="avatar-overlay-badge" style="background-image: url({member.overlayUrl})" aria-hidden="true"></span>
						{/if}
					</div>
					<div class="member-info">
						<span class="member-name">{member.username}</span>
						{#if channel.ownerId === getDmDirectoryKey(member)}
							<span class="role-badge owner">Owner</span>
						{/if}
						{#if isMemberCurrentUser(member)}
							<span class="you-badge">You</span>
						{/if}
					</div>
					{#if isOwner && !isMemberCurrentUser(member)}
						<button class="kick-btn" disabled={busy} aria-label={`Remove ${member.username} from group`} onclick={() => handleKick(member)} title="Remove from group">
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
						</button>
					{/if}
				</div>
			{/each}
		</div>
	</div>

	<div class="settings-section leave-section">
		<button class="leave-btn" disabled={busy} onclick={handleLeave}>
			Leave Group
		</button>
	</div>
</div>

<style>
	.group-settings {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem;
		overflow-y: auto;
		height: 100%;
	}

	.settings-section {
		padding: 0.75rem;
		background: var(--bg-secondary);
		border-radius: 8px;
	}

	.avatar-section {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
	}

	.avatar-display {
		margin-bottom: 0.25rem;
	}

	.group-name {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.member-count {
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.avatar-note { color: var(--text-muted); font-size: var(--text-sm, 0.8125rem); text-align: center; }
	.operation-error { color: var(--color-danger, #f44336); overflow-wrap: anywhere; }
	button:disabled { opacity: 0.5; cursor: default; }
	button:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }

	.section-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.5rem;
	}

	.section-header h4 {
		margin: 0;
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.add-member-btn {
		min-height: 44px;
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.25rem 0.5rem;
		background: none;
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 0.75rem;
	}

	.add-member-btn:hover {
		color: var(--text-primary);
		background: var(--bg-hover);
	}

	.add-member-panel {
		margin-bottom: 0.5rem;
		padding: 0.5rem;
		background: var(--bg-primary);
		border-radius: 6px;
	}

	.add-search {
		width: 100%;
		padding: 0.5rem;
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-primary);
		border-radius: 4px;
		font-size: 0.85rem;
		margin-bottom: 0.375rem;
	}

	.add-user-list {
		max-height: 150px;
		overflow-y: auto;
	}

	.add-user-item {
		min-height: 44px;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.375rem 0.5rem;
		background: none;
		border: none;
		color: var(--text-primary);
		cursor: pointer;
		border-radius: 4px;
		text-align: left;
		font-size: 0.85rem;
	}

	.add-user-item:hover {
		background: var(--bg-hover);
	}

	.add-user-avatar,
	.add-user-avatar-ph {
		width: 24px;
		height: 24px;
		border-radius: 50%;
		flex-shrink: 0;
		object-fit: cover;
	}

	.add-user-avatar-ph {
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.7rem;
		font-weight: 600;
		color: white;
	}

	.no-users {
		padding: 0.5rem;
		text-align: center;
		color: var(--text-secondary);
		font-size: 0.8rem;
	}

	.member-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.member-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.375rem 0.25rem;
		border-radius: 4px;
	}

	.member-item:hover {
		background: var(--bg-hover);
	}

	.member-avatar-wrap {
		position: relative;
		flex-shrink: 0;
		width: 28px;
		height: 28px;
	}

	.member-avatar,
	.member-avatar-ph {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		object-fit: cover;
	}

	.member-avatar-ph {
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.7rem;
		font-weight: 600;
		color: white;
	}

	.member-info {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex: 1;
		min-width: 0;
	}

	.member-name {
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.role-badge {
		font-size: 0.65rem;
		padding: 1px 5px;
		border-radius: 3px;
		font-weight: 600;
		flex-shrink: 0;
	}

	.role-badge.owner {
		background: var(--accent);
		color: white;
	}

	.you-badge {
		font-size: 0.65rem;
		padding: 1px 5px;
		border-radius: 3px;
		background: var(--bg-hover);
		color: var(--text-secondary);
		flex-shrink: 0;
	}

	.kick-btn {
		flex-shrink: 0;
		width: 44px;
		height: 44px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		border-radius: 4px;
		opacity: 0.7;
		transition: opacity 0.15s;
	}

	.member-item:hover .kick-btn,
	.kick-btn:focus-visible {
		opacity: 1;
	}

	.kick-btn:hover {
		color: #f44336;
		background: rgba(244, 67, 54, 0.1);
	}

	.leave-section {
		margin-top: auto;
	}

	.leave-btn {
		width: 100%;
		padding: 0.625rem;
		background: none;
		border: 1px solid #f44336;
		border-radius: 6px;
		color: #f44336;
		font-size: 0.85rem;
		font-weight: 500;
		cursor: pointer;
		transition: background-color 0.15s;
	}

	.leave-btn:hover {
		background: rgba(244, 67, 54, 0.1);
	}
</style>
