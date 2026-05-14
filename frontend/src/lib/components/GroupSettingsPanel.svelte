<script lang="ts">
	import { users, currentUser, kickGroupMember, addGroupMember, leaveGroup, updateGroupAvatar } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import { getServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';
	import GroupAvatar from './GroupAvatar.svelte';
	import type { Channel, User } from '$lib/socket';

	export let channel: Channel;

	let showAddMember = false;
	let addSearchQuery = '';
	let avatarUploading = false;
	let avatarInput: HTMLInputElement;

	$: myStableId = $currentUser?.dbUserId ? `user-${$currentUser.dbUserId}` : $currentUser?.id;
	$: memberRecords = (channel.members || []).map((stableId) => {
		const fromChannel = (channel.memberUsers || []).find((member) => {
			const memberStableId = member.dbUserId ? `user-${member.dbUserId}` : member.id;
			return memberStableId === stableId;
		});
		if (fromChannel) return fromChannel;

		const fromOnlineUsers = $users.find((user) => {
			const userStableId = user.dbUserId ? `user-${user.dbUserId}` : user.id;
			return userStableId === stableId;
		});
		if (fromOnlineUsers) return fromOnlineUsers;

		const fallbackName = stableId.startsWith('user-') ? `User ${stableId.slice(5)}` : stableId;
		return {
			id: stableId,
			username: fallbackName,
			color: '#888888',
			status: 'offline' as const
		};
	});
	$: isOwner = channel.members && myStableId ? isUserOwner(myStableId) : false;

	function isUserOwner(stableId: string): boolean {
		// The owner is the creator — the first member or whoever has "owner" role
		// For simplicity, check if this user's stable ID is the first in the members list
		// or use the created_by field (not available client-side, so use first member heuristic)
		return channel.members?.[0] === stableId || false;
	}

	$: addableUsers = $users.filter(u => {
		if (u.id === $currentUser?.id) return false;
		const uStableId = u.dbUserId ? `user-${u.dbUserId}` : u.id;
		if (channel.members?.includes(uStableId)) return false;
		if (addSearchQuery) {
			return u.username.toLowerCase().includes(addSearchQuery.toLowerCase());
		}
		return true;
	});

	function handleKick(memberUser: User) {
		const stableId = memberUser.dbUserId ? `user-${memberUser.dbUserId}` : memberUser.id;
		kickGroupMember(channel.id, stableId);
	}

	function handleAdd(user: User) {
		const stableId = user.dbUserId ? `user-${user.dbUserId}` : user.id;
		addGroupMember(channel.id, stableId);
		showAddMember = false;
		addSearchQuery = '';
	}

	function handleLeave() {
		leaveGroup(channel.id);
		layoutStore.closeDM();
	}

	async function handleAvatarUpload(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		avatarUploading = true;
		try {
			const formData = new FormData();
			formData.append('avatar', file);
			formData.append('channelId', channel.id);

			const token = getAuthToken();
			const serverUrl = getServerUrl();
			const res = await fetch(`${serverUrl}/api/upload-group-avatar`, {
				method: 'POST',
				headers: token ? { 'Authorization': `Bearer ${token}` } : undefined,
				credentials: 'include',
				body: formData
			});

			const data = await res.json();
			if (data.success) {
				updateGroupAvatar(channel.id, data.avatarUrl);
			}
		} catch (err) {
			console.error('Group avatar upload failed:', err);
		} finally {
			avatarUploading = false;
		}
	}

	function isMemberCurrentUser(member: User): boolean {
		if (!$currentUser) return false;
		if (member.id === $currentUser.id) return true;
		if ($currentUser.dbUserId && member.dbUserId === $currentUser.dbUserId) return true;
		return false;
	}
</script>

<div class="group-settings">
	<div class="settings-section avatar-section">
		<div class="avatar-display">
			<GroupAvatar {channel} size={64} />
		</div>
		<h3 class="group-name">{channel.name}</h3>
		<span class="member-count">{channel.members?.length || 0} members</span>
		{#if isOwner}
			<input
				type="file"
				accept="image/png,image/jpeg,image/gif,image/webp"
				bind:this={avatarInput}
				on:change={handleAvatarUpload}
				class="hidden"
			/>
			<button class="change-avatar-btn" on:click={() => avatarInput.click()} disabled={avatarUploading}>
				{avatarUploading ? 'Uploading...' : 'Change Avatar'}
			</button>
		{/if}
	</div>

	<div class="settings-section">
		<div class="section-header">
			<h4>Members</h4>
			{#if isOwner}
				<button class="add-member-btn" on:click={() => { showAddMember = !showAddMember; }}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
					Add
				</button>
			{/if}
		</div>

		{#if showAddMember}
			<div class="add-member-panel">
				<input
					type="text"
					class="add-search"
					placeholder="Search users..."
					bind:value={addSearchQuery}
				/>
				<div class="add-user-list">
					{#each addableUsers.slice(0, 10) as user (user.id)}
						<button class="add-user-item" on:click={() => handleAdd(user)}>
							{#if user.profilePicture}
								<img src={user.profilePicture} alt={user.username} class="add-user-avatar" />
							{:else}
								<div class="add-user-avatar-ph" style="--avatar-color: {user.roleColor || user.color}">
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
							<div class="member-avatar-ph" style="--avatar-color: {member.roleColor || member.color}">
								{member.username.charAt(0).toUpperCase()}
							</div>
						{/if}
					</div>
					<div class="member-info">
						<span class="member-name">{member.username}</span>
						{#if channel.members?.[0] === (member.dbUserId ? `user-${member.dbUserId}` : member.id)}
							<span class="role-badge owner">Owner</span>
						{/if}
						{#if isMemberCurrentUser(member)}
							<span class="you-badge">You</span>
						{/if}
					</div>
					{#if isOwner && !isMemberCurrentUser(member)}
						<button class="kick-btn" on:click={() => handleKick(member)} title="Remove from group">
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
						</button>
					{/if}
				</div>
			{/each}
		</div>
	</div>

	<div class="settings-section leave-section">
		<button class="leave-btn" on:click={handleLeave}>
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
		background: var(--surface-base);
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
		color: var(--text-heading);
	}

	.member-count {
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.change-avatar-btn {
		padding: 0.375rem 0.75rem;
		background: var(--surface-hover);
		border: 1px solid var(--border-subtle);
		border-radius: 6px;
		color: var(--text-heading);
		font-size: 0.8rem;
		cursor: pointer;
	}

	.change-avatar-btn:hover:not(:disabled) {
		background: var(--surface-app);
	}

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
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.25rem 0.5rem;
		background: none;
		border: 1px solid var(--border-subtle);
		border-radius: 4px;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 0.75rem;
	}

	.add-member-btn:hover {
		color: var(--text-heading);
		background: var(--surface-hover);
	}

	.add-member-panel {
		margin-bottom: 0.5rem;
		padding: 0.5rem;
		background: var(--surface-app);
		border-radius: 6px;
	}

	.add-search {
		width: 100%;
		padding: 0.5rem;
		border: 1px solid var(--border-subtle);
		background: var(--surface-base);
		color: var(--text-heading);
		border-radius: 4px;
		font-size: 0.85rem;
		margin-bottom: 0.375rem;
	}

	.add-user-list {
		max-height: 150px;
		overflow-y: auto;
	}

	.add-user-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.375rem 0.5rem;
		background: none;
		border: none;
		color: var(--text-heading);
		cursor: pointer;
		border-radius: 4px;
		text-align: left;
		font-size: 0.85rem;
	}

	.add-user-item:hover {
		background: var(--surface-hover);
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
		background: var(--surface-hover);
	}

	.member-avatar-wrap {
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
		color: var(--text-heading);
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
		background: var(--accent-primary);
		color: white;
	}

	.you-badge {
		font-size: 0.65rem;
		padding: 1px 5px;
		border-radius: 3px;
		background: var(--surface-hover);
		color: var(--text-secondary);
		flex-shrink: 0;
	}

	.kick-btn {
		flex-shrink: 0;
		width: 22px;
		height: 22px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		border-radius: 4px;
		opacity: 0;
		transition: opacity 0.15s;
	}

	.member-item:hover .kick-btn {
		opacity: 1;
	}

	.kick-btn:hover {
		color: var(--color-danger, #f44336);
		background: rgba(var(--color-danger-rgb, 244, 67, 54), 0.1);
	}

	.leave-section {
		margin-top: auto;
	}

	.leave-btn {
		width: 100%;
		padding: 0.625rem;
		background: none;
		border: 1px solid var(--color-danger, #f44336);
		border-radius: 6px;
		color: var(--color-danger, #f44336);
		font-size: 0.85rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s;
	}

	.leave-btn:hover {
		background: rgba(var(--color-danger-rgb, 244, 67, 54), 0.1);
	}

	.add-user-avatar-ph, .member-avatar-ph { background-color: var(--avatar-color, var(--accent-primary)); }
</style>
