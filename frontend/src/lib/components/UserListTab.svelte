<script lang="ts">
	import { users, currentUser, createDM, socket } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import { startCall } from '$lib/calling';
	import type { User } from '$lib/socket';
	import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';
	import type { ContextMenuItem } from '$lib/context-menu/types';

	let contextMenuUser: User | null = null;
	let contextMenuPosition = { x: 0, y: 0 };
	let showContextMenu = false;

	// Role priority for sorting groups
	const rolePriority: Record<string, number> = {
		owner: 100, admin: 90, mod: 70, member: 10, guest: 0
	};

	const roleLabels: Record<string, string> = {
		owner: 'Owner', admin: 'Admin', mod: 'Moderator', member: 'Online', guest: 'Guest'
	};

	// Group users by highest hoisted role
	$: otherUsers = $users.filter(u => u.id !== $currentUser?.id);

	$: groupedUsers = (() => {
		const groups: Record<string, User[]> = {};
		for (const user of otherUsers) {
			const role = user.highestRole || 'member';
			if (!groups[role]) groups[role] = [];
			groups[role].push(user);
		}
		// Sort users alphabetically within each group
		for (const role of Object.keys(groups)) {
			groups[role].sort((a, b) => a.username.localeCompare(b.username));
		}
		return groups;
	})();

	$: sortedRoles = Object.keys(groupedUsers).sort(
		(a, b) => (rolePriority[b] || 0) - (rolePriority[a] || 0)
	);

	function handleUserClick(user: User) {
		createDM(user.id);
		layoutStore.showDMsTab();
	}

	function handleRightClick(event: MouseEvent, user: User) {
		event.preventDefault();
		contextMenuUser = user;
		contextMenuPosition = { x: event.clientX, y: event.clientY };
		showContextMenu = true;
	}

	function closeContextMenu() {
		showContextMenu = false;
		contextMenuUser = null;
	}

	function handleContextMessage() {
		if (!contextMenuUser) return;
		createDM(contextMenuUser.id);
		layoutStore.showDMsTab();
		closeContextMenu();
	}

	async function handleContextVoiceCall() {
		if (!contextMenuUser || !$socket) return;
		try { await startCall($socket, contextMenuUser.id, false); } catch { /* ignore */ }
		closeContextMenu();
	}

	async function handleContextVideoCall() {
		if (!contextMenuUser || !$socket) return;
		try { await startCall($socket, contextMenuUser.id, true); } catch { /* ignore */ }
		closeContextMenu();
	}

	$: userMenuItems = contextMenuUser ? buildUserMenuItems() : [];

	function buildUserMenuItems(): ContextMenuItem[] {
		return [
			{
				id: 'message',
				label: 'Message',
				icon: 'message-circle',
				onSelect: handleContextMessage
			},
			{
				id: 'voice',
				label: 'Voice Call',
				icon: 'phone',
				onSelect: handleContextVoiceCall
			},
			{
				id: 'video',
				label: 'Video Call',
				icon: 'video',
				onSelect: handleContextVideoCall
			}
		];
	}

	function getDisplayColor(user: User): string {
		return user.roleColor || user.color;
	}

	function getRoleBadge(user: User): string | null {
		const role = user.highestRole;
		if (role === 'owner') return '\u{1F451}';
		if (role === 'admin') return 'ADM';
		if (role === 'mod') return 'MOD';
		return null;
	}
</script>

<div class="user-list-tab">
	{#if otherUsers.length === 0}
		<div class="empty-state">No other users online</div>
	{:else}
		{#each sortedRoles as role}
			<div class="role-group">
				<div class="role-header">
					{roleLabels[role] || role} - {groupedUsers[role].length}
				</div>
				{#each groupedUsers[role] as user (user.id)}
					<button
						class="user-row"
						on:click={() => handleUserClick(user)}
						on:contextmenu={(e) => handleRightClick(e, user)}
					>
						<div class="user-avatar-wrap">
							{#if user.profilePicture}
								<img src={user.profilePicture} alt={user.username} class="user-avatar" />
							{:else}
								<div class="user-avatar-placeholder" style="background-color: {user.color}">
									{user.username.charAt(0).toUpperCase()}
								</div>
							{/if}
							<span class="presence-dot" class:active={user.status === 'active'} class:away={user.status === 'away'} class:busy={user.status === 'busy'}></span>
						</div>
						<div class="user-info">
							<span class="user-display-name" style="color: {getDisplayColor(user)}">
								{user.username}
								{#if getRoleBadge(user)}
									<span class="role-badge">{getRoleBadge(user)}</span>
								{/if}
							</span>
							{#if user.handle}
								<span class="user-handle">@{user.handle}</span>
							{/if}
						</div>
					</button>
				{/each}
			</div>
		{/each}
	{/if}

	<ContextMenu
		open={showContextMenu && !!contextMenuUser}
		x={contextMenuPosition.x}
		y={contextMenuPosition.y}
		items={userMenuItems}
		ariaLabel="User list actions"
		headerLabel={contextMenuUser?.username || null}
		on:close={closeContextMenu}
	/>
</div>

<style>
	.user-list-tab {
		flex: 1;
		overflow-y: auto;
		padding: 0.25rem 0;
	}

	.empty-state {
		padding: 2rem 1rem;
		text-align: center;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}

	.role-group {
		margin-bottom: 0.25rem;
	}

	.role-header {
		padding: 0.5rem 0.75rem 0.25rem;
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		color: var(--text-secondary);
		letter-spacing: 0.03em;
	}

	.user-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.375rem 0.75rem;
		width: 100%;
		background: none;
		border: none;
		color: var(--text-primary);
		cursor: pointer;
		text-align: left;
		border-radius: 4px;
		transition: background 0.15s;
	}

	.user-row:hover {
		background: var(--bg-hover);
	}

	.user-avatar-wrap {
		position: relative;
		flex-shrink: 0;
		width: 32px;
		height: 32px;
	}

	.user-avatar,
	.user-avatar-placeholder {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		object-fit: cover;
	}

	.user-avatar-placeholder {
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.8rem;
		font-weight: 600;
		color: white;
	}

	.presence-dot {
		position: absolute;
		bottom: -1px;
		right: -1px;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		border: 2px solid var(--bg-secondary);
		background: var(--status-offline, #666);
	}

	.presence-dot.active { background: var(--status-online, #44b700); }
	.presence-dot.away { background: var(--status-away, #ffa500); }
	.presence-dot.busy { background: var(--status-busy, #f44336); }

	.user-info {
		display: flex;
		flex-direction: column;
		min-width: 0;
		gap: 1px;
	}

	.user-display-name {
		font-size: 0.875rem;
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.role-badge {
		font-size: 0.65rem;
		font-weight: 700;
		vertical-align: middle;
		margin-left: 0.25rem;
		opacity: 0.7;
	}

	.user-handle {
		font-size: 0.7rem;
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	@media (max-width: 768px) {
		.user-row {
			padding: 0.625rem 0.75rem;
			min-height: 52px;
		}

		.user-avatar-wrap {
			width: 36px;
			height: 36px;
		}

		.user-avatar,
		.user-avatar-placeholder {
			width: 36px;
			height: 36px;
		}

		.user-display-name { font-size: 1rem; }
		.user-handle { font-size: 0.8rem; }

	}
</style>
