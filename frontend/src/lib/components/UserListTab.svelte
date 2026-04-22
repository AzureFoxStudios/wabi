<script lang="ts">
	import { get } from 'svelte/store';
	import { users, serverMembers, currentUser, channels, createDM, getDMChannelIdForUser, socket, assignRole, removeUserRole, banUser, roleDefinitions } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import { startCall } from '$lib/calling';
	import type { User } from '$lib/socket';
	import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';
	import type { ContextMenuItem } from '$lib/context-menu/types';
	import { resolveUserDisplayColor } from '$lib/accessibility';
	import {
		displayEnhancementSettingsStore
	} from '$lib/displayEnhancements';
	import {
		MAX_LOCAL_NICKNAME_LENGTH,
		clearLocalNicknameForUser,
		getLocalNicknameForUser,
		getUserIdentityKey,
		localNicknamesStore,
		setLocalNicknameForUser
	} from '$lib/localNicknames';
	import {
		isTrackedPersonStatusAlertsEnabled,
		rememberPeople,
		toggleTrackedPersonStatusAlerts
	} from '$lib/peopleTracker';
	import { queueConversationPaymentLaunch } from '$lib/paymentLaunch';

	let contextMenuUser: User | null = null;
	let contextMenuPosition = { x: 0, y: 0 };
	let showContextMenu = false;
	let friendSearchQuery = '';
	let friendPresenceFilter: 'all' | 'active' | 'away' | 'busy' | 'offline' = 'all';
	let friendSortMode: 'role' | 'name' | 'status' = 'role';

	const fallbackRolePriority: Record<string, number> = {
		owner: 100, admin: 90, mod: 70, member: 10, guest: 0
	};

	const fallbackRoleLabels: Record<string, string> = {
		owner: 'Owner', admin: 'Admin', mod: 'Moderator', member: 'Member', guest: 'Guest'
	};

	$: rolePriority = (() => {
		const map: Record<string, number> = { ...fallbackRolePriority };
		for (const role of $roleDefinitions) {
			map[role.roleName] = role.priority;
		}
		return map;
	})();

	$: roleLabelMap = (() => {
		const map: Record<string, string> = { ...fallbackRoleLabels };
		for (const role of $roleDefinitions) {
			map[role.roleName] = role.displayName;
		}
		return map;
	})();

	function getRoleLabel(role: string): string {
		return roleLabelMap[role] || role;
	}

	function isCurrentUserEntry(user: User): boolean {
		if (!$currentUser) return false;
		if (user.id === $currentUser.id) return true;
		if (user.dbUserId && $currentUser.dbUserId && user.dbUserId === $currentUser.dbUserId) return true;
		return false;
	}

	function getLocalNickname(user: User): string {
		if (!$displayEnhancementSettingsStore.localNicknamesEnabled) return '';
		const key = getUserIdentityKey(user);
		return key ? $localNicknamesStore[key] || '' : '';
	}

	function getDisplayName(user: User): string {
		return getLocalNickname(user) || user.username;
	}

	function isFriendTrackedForNotifications(user: User): boolean {
		return isTrackedPersonStatusAlertsEnabled(user);
	}

	function toggleTrackContextUserStatus(): void {
		if (!contextMenuUser || isCurrentUserEntry(contextMenuUser) || !contextMenuUser.dbUserId) return;
		rememberPeople([contextMenuUser]);
		toggleTrackedPersonStatusAlerts(contextMenuUser);
		closeContextMenu();
	}

	function promptSetContextLocalNickname(): void {
		if (!contextMenuUser) return;
		const currentNickname = getLocalNicknameForUser(contextMenuUser);
		const draft = window.prompt(
			`Set local nickname (max ${MAX_LOCAL_NICKNAME_LENGTH} characters)`,
			currentNickname || contextMenuUser.username
		);
		if (draft === null) return;
		setLocalNicknameForUser(contextMenuUser, draft);
		closeContextMenu();
	}

	function clearContextLocalNickname(): void {
		if (!contextMenuUser) return;
		clearLocalNicknameForUser(contextMenuUser);
		closeContextMenu();
	}

	function hasContextLocalNickname(): boolean {
		if (!contextMenuUser) return false;
		return Boolean(getLocalNickname(contextMenuUser));
	}

	function toStatusPriority(status: User['status']): number {
		if (status === 'active') return 0;
		if (status === 'away') return 1;
		if (status === 'busy') return 2;
		return 3;
	}

	function matchesSearch(user: User, query: string): boolean {
		if (!$displayEnhancementSettingsStore.betterFriendListEnabled) return true;
		const normalized = query.trim().toLowerCase();
		if (!normalized) return true;
		const username = user.username.toLowerCase();
		const displayName = getDisplayName(user).toLowerCase();
		const handle = (user.handle || '').toLowerCase();
		return username.includes(normalized) || displayName.includes(normalized) || handle.includes(normalized);
	}

	function matchesPresenceFilter(user: User, offline: boolean): boolean {
		if (!$displayEnhancementSettingsStore.betterFriendListEnabled) return true;
		if (friendPresenceFilter === 'all') return true;
		if (friendPresenceFilter === 'offline') return offline;
		if (offline) return false;
		return user.status === friendPresenceFilter;
	}

	function sortUsersList(input: User[]): User[] {
		const sorted = [...input];
		if (
			!$displayEnhancementSettingsStore.betterFriendListEnabled ||
			friendSortMode === 'role'
		) {
			sorted.sort((a, b) => {
				const priorityDelta = (rolePriority[b.highestRole || 'member'] || 0) - (rolePriority[a.highestRole || 'member'] || 0);
				if (priorityDelta !== 0) return priorityDelta;
				return a.username.localeCompare(b.username);
			});
			return sorted;
		}
		if (friendSortMode === 'name') {
			sorted.sort((a, b) => a.username.localeCompare(b.username));
			return sorted;
		}
		if (friendSortMode === 'status') {
			sorted.sort((a, b) => {
				const statusDelta = toStatusPriority(a.status) - toStatusPriority(b.status);
				if (statusDelta !== 0) return statusDelta;
				return a.username.localeCompare(b.username);
			});
			return sorted;
		}
		return sorted;
	}

	$: onlineOtherUsers = sortUsersList(
		$users.filter((user) => {
			if (!matchesSearch(user, friendSearchQuery)) return false;
			return matchesPresenceFilter(user, false);
		})
	);
	$: rememberPeople($users);
	$: rememberPeople($serverMembers);

	$: groupedUsers = (() => {
		const groups: Record<string, User[]> = {};
		for (const user of onlineOtherUsers) {
			const role = user.highestRole || 'member';
			if (!groups[role]) groups[role] = [];
			groups[role].push(user);
		}
		for (const role of Object.keys(groups)) {
			groups[role] = sortUsersList(groups[role]);
		}
		return groups;
	})();

	$: sortedRoles = Object.keys(groupedUsers).sort(
		(a, b) => (rolePriority[b] || 0) - (rolePriority[a] || 0)
	);

	// Offline members: in serverMembers but not in the online users list
	$: offlineUsers = (() => {
		const onlineDbIds = new Set($users.map(u => u.dbUserId).filter(Boolean));
		return $serverMembers
			.filter(m => !onlineDbIds.has(m.dbUserId))
			.filter((user) => matchesSearch(user, friendSearchQuery))
			.filter((user) => matchesPresenceFilter(user, true))
			.sort((a, b) => a.username.localeCompare(b.username));
	})();

	function handleUserClick(user: User) {
		if (isCurrentUserEntry(user)) {
			layoutStore.openNotes();
			return;
		}
		openDirectConversationWithUser(user);
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
		if (isCurrentUserEntry(contextMenuUser)) {
			layoutStore.openNotes();
			closeContextMenu();
			return;
		}
		openDirectConversationWithUser(contextMenuUser);
		closeContextMenu();
	}

	function openDirectConversationWithUser(user: User): void {
		const self = get(currentUser);
		if (!self || isCurrentUserEntry(user)) return;
		const dmId = getDMChannelIdForUser(self, user);
		const existingDM = get(channels).find((channel) => channel.id === dmId);
		if (existingDM) {
			layoutStore.openDM(dmId, user);
			return;
		}

		createDM(user.id);
		layoutStore.showDMsTab();
		const unsubscribe = channels.subscribe((allChannels) => {
			const newDM = allChannels.find(
				(channel) => channel.id === dmId || (channel.type === 'dm' && channel.otherUser?.id === user.id)
			);
			if (!newDM) return;
			layoutStore.openDM(newDM.id, user);
			unsubscribe();
		});
	}

	function handleContextRequestPayment(): void {
		if (!contextMenuUser || isCurrentUserEntry(contextMenuUser) || !contextMenuUser.dbUserId) return;
		queueConversationPaymentLaunch({
			surface: 'payment_request',
			targetUserId: contextMenuUser.id,
			targetDbUserId: contextMenuUser.dbUserId
		});
		openDirectConversationWithUser(contextMenuUser);
		closeContextMenu();
	}

	function handleContextManualCash(): void {
		if (!contextMenuUser || isCurrentUserEntry(contextMenuUser) || !contextMenuUser.dbUserId) return;
		queueConversationPaymentLaunch({
			surface: 'manual_cash',
			targetUserId: contextMenuUser.id,
			targetDbUserId: contextMenuUser.dbUserId
		});
		openDirectConversationWithUser(contextMenuUser);
		closeContextMenu();
	}

	async function handleContextVoiceCall() {
		if (!contextMenuUser || !$socket || isCurrentUserEntry(contextMenuUser)) return;
		closeContextMenu();
		await startCall($socket, getUserIdentityKey(contextMenuUser), false, { scope: 'dm', displayName: contextMenuUser.username });
	}

	async function handleContextVideoCall() {
		if (!contextMenuUser || !$socket || isCurrentUserEntry(contextMenuUser)) return;
		closeContextMenu();
		await startCall($socket, getUserIdentityKey(contextMenuUser), true, { scope: 'dm', displayName: contextMenuUser.username });
	}

	function canManageRoles(): boolean {
		const myRole = $currentUser?.highestRole;
		return myRole === 'owner' || myRole === 'admin';
	}

	function canBanUsers(): boolean {
		const myRole = $currentUser?.highestRole;
		return myRole === 'owner' || myRole === 'admin' || myRole === 'mod';
	}

	function canBanContextUser(): boolean {
		if (!contextMenuUser || !canBanUsers() || !$currentUser) return false;
		if (isCurrentUserEntry(contextMenuUser)) return false;
		if (!contextMenuUser.dbUserId) return false;
		if (contextMenuUser.highestRole === 'owner') return false;
		const myPriority = rolePriority[$currentUser.highestRole || 'guest'] || 0;
		const targetPriority = rolePriority[contextMenuUser.highestRole || 'guest'] || 0;
		return myPriority > targetPriority;
	}

	function handleBanContextUser(): void {
		if (!contextMenuUser?.dbUserId) return;
		const confirmBan = window.confirm(`Ban ${contextMenuUser.username}? They will lose access until manually re-enabled.`);
		if (!confirmBan) return;
		const reasonInput = window.prompt('Ban reason (optional):', '') || '';
		banUser(contextMenuUser.dbUserId, reasonInput);
		closeContextMenu();
	}

	function canManageContextUserRoles(): boolean {
		if (!contextMenuUser || !canManageRoles()) return false;
		if (!$currentUser || isCurrentUserEntry(contextMenuUser)) return false;
		if (!contextMenuUser.dbUserId) return false;
		return contextMenuUser.highestRole !== 'owner';
	}

	function handleAssignContextRole(roleName: 'admin' | 'mod') {
		if (!contextMenuUser?.dbUserId) return;
		assignRole(contextMenuUser.dbUserId, roleName);
		closeContextMenu();
	}

	function handleRemoveContextRole(roleName: 'admin' | 'mod') {
		if (!contextMenuUser?.dbUserId) return;
		removeUserRole(contextMenuUser.dbUserId, roleName);
		closeContextMenu();
	}

	function handleResetContextUserToMember() {
		if (!contextMenuUser?.dbUserId) return;
		removeUserRole(contextMenuUser.dbUserId, 'admin');
		removeUserRole(contextMenuUser.dbUserId, 'mod');
		closeContextMenu();
	}

	$: userMenuItems = contextMenuUser ? buildUserMenuItems() : [];

	function buildUserMenuItems(): ContextMenuItem[] {
		const items: ContextMenuItem[] = [
			{
				id: 'message',
				label: isCurrentUserEntry(contextMenuUser) ? 'Open Notes' : 'Message',
				icon: 'message-circle',
				onSelect: handleContextMessage
			},
		];

		if (!isCurrentUserEntry(contextMenuUser)) {
			items.push(
				{
					id: 'request-payment',
					label: 'Request Payment',
					icon: 'credit-card',
					disabled: !contextMenuUser?.dbUserId,
					onSelect: handleContextRequestPayment
				},
				{
					id: 'record-cash',
					label: 'Record Cash Trade',
					icon: 'banknote',
					disabled: !contextMenuUser?.dbUserId,
					onSelect: handleContextManualCash
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
			);

			items.push({
				id: 'track-status',
				label: isFriendTrackedForNotifications(contextMenuUser)
					? 'Stop Status Alerts'
					: 'Track Status Alerts',
				icon: 'settings',
				disabled: !contextMenuUser?.dbUserId,
					onSelect: toggleTrackContextUserStatus
				});
			}

			if ($displayEnhancementSettingsStore.localNicknamesEnabled) {
				items.push({
					id: 'nickname-set',
					label: 'Set Local Nickname',
					icon: 'settings',
					onSelect: promptSetContextLocalNickname
				});
				if (hasContextLocalNickname()) {
					items.push({
						id: 'nickname-clear',
						label: 'Clear Local Nickname',
						icon: 'settings',
						danger: true,
						onSelect: clearContextLocalNickname
					});
				}
			}

			if (canManageContextUserRoles() && contextMenuUser) {
			const roles = contextMenuUser.roles || [];
			const isAdmin = roles.includes('admin') || contextMenuUser.highestRole === 'admin';
			const isMod = roles.includes('mod') || contextMenuUser.highestRole === 'mod';

			items.push({ id: 'role-divider', type: 'separator' });

			if (!isAdmin) {
				items.push({
					id: 'make-admin',
					label: 'Make Admin',
					icon: 'settings',
					onSelect: () => handleAssignContextRole('admin')
				});
			} else {
				items.push({
					id: 'remove-admin',
					label: 'Remove Admin',
					icon: 'settings',
					danger: true,
					onSelect: () => handleRemoveContextRole('admin')
				});
			}

			if (!isMod) {
				items.push({
					id: 'make-mod',
					label: 'Make Moderator',
					icon: 'settings',
					onSelect: () => handleAssignContextRole('mod')
				});
			} else {
				items.push({
					id: 'remove-mod',
					label: 'Remove Moderator',
					icon: 'settings',
					danger: true,
					onSelect: () => handleRemoveContextRole('mod')
				});
			}

			if (isAdmin || isMod) {
				items.push({
					id: 'reset-member',
					label: 'Reset to Member',
					icon: 'settings',
					danger: true,
					onSelect: handleResetContextUserToMember
				});
			}
		}

		if (canBanContextUser()) {
			items.push({ id: 'moderation-divider', type: 'separator' });
			items.push({
				id: 'ban-user',
				label: 'Ban User',
				icon: 'trash-2',
				danger: true,
				onSelect: handleBanContextUser
			});
		}

		return items;
	}

	function getDisplayColor(user: User): string {
		return resolveUserDisplayColor(user.roleColor, user.color);
	}

	function getUserTopRoleName(user: User): string {
		return user.highestRole || user.roles?.[0] || 'member';
	}

</script>

<div class="user-list-tab">
	{#if $displayEnhancementSettingsStore.betterFriendListEnabled}
		<div class="friend-toolbar">
			<input
				type="text"
				class="friend-search"
				placeholder="Search people..."
				bind:value={friendSearchQuery}
			/>
			<div class="friend-toolbar-row">
				<select class="friend-select" bind:value={friendPresenceFilter}>
					<option value="all">All</option>
					<option value="active">Online</option>
					<option value="away">Away</option>
					<option value="busy">Busy</option>
					<option value="offline">Offline</option>
				</select>
				<select class="friend-select" bind:value={friendSortMode}>
					<option value="role">Role</option>
					<option value="name">Name</option>
					<option value="status">Status</option>
				</select>
			</div>
		</div>
	{/if}

	{#each sortedRoles as role}
		<div class="role-group">
			<div class="role-header">
				{getRoleLabel(role)} - {groupedUsers[role].length}
			</div>
			{#each groupedUsers[role] as user (user.id)}
				<button
					class="user-row"
					on:click={() => handleUserClick(user)}
					on:contextmenu={(e) => handleRightClick(e, user)}
				>
					<div class="user-avatar-wrap">
						{#if user.profilePicture}
							<img src={user.profilePicture} alt={getDisplayName(user)} class="user-avatar" />
						{:else}
							<div class="user-avatar-placeholder" style="background-color: {user.color}">
								{getDisplayName(user).charAt(0).toUpperCase()}
							</div>
						{/if}
						<span class="presence-dot" class:active={user.status === 'active'} class:away={user.status === 'away'} class:busy={user.status === 'busy'}></span>
					</div>
					<div class="user-info">
						<span class="user-display-name" style="color: {getDisplayColor(user)}">
							{getDisplayName(user)}
						</span>
						{#if user.handle}
							<span class="user-handle">@{user.handle}</span>
						{/if}
					</div>
				</button>
			{/each}
		</div>
	{/each}

	{#if offlineUsers.length > 0}
		<div class="role-group">
			<div class="role-header">Offline - {offlineUsers.length}</div>
			{#each offlineUsers as user (user.dbUserId)}
				<button
					class="user-row offline"
					on:click={() => handleUserClick(user)}
					on:contextmenu={(e) => handleRightClick(e, user)}
				>
					<div class="user-avatar-wrap">
						{#if user.profilePicture}
							<img src={user.profilePicture} alt={getDisplayName(user)} class="user-avatar" />
						{:else}
							<div class="user-avatar-placeholder" style="background-color: {user.color}">
								{getDisplayName(user).charAt(0).toUpperCase()}
							</div>
						{/if}
						<span class="presence-dot"></span>
					</div>
					<div class="user-info">
						<span class="user-display-name" style="color: {getDisplayColor(user)}">
							{getDisplayName(user)}
						</span>
						{#if user.handle}
							<span class="user-handle">@{user.handle}</span>
						{/if}
					</div>
				</button>
			{/each}
		</div>
	{/if}

	{#if sortedRoles.length === 0 && offlineUsers.length === 0}
		<div class="empty-state">No people match the current filters.</div>
	{/if}

	<ContextMenu
		open={showContextMenu && !!contextMenuUser}
		x={contextMenuPosition.x}
		y={contextMenuPosition.y}
		items={userMenuItems}
		ariaLabel="User list actions"
		headerLabel={contextMenuUser ? getDisplayName(contextMenuUser) : null}
		on:close={closeContextMenu}
	/>
</div>

<style>
	.user-list-tab {
		flex: 1;
		overflow-y: auto;
		padding: 0.4rem 0.35rem 0.7rem;
		text-align: left;
	}

	.friend-toolbar {
		display: flex;
		flex-direction: column;
		gap: 0.38rem;
		padding: 0.35rem 0.45rem 0.55rem;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
		margin-bottom: 0.3rem;
	}

	.friend-search,
	.friend-select {
		width: 100%;
		height: 30px;
		border-radius: 6px;
		border: 1px solid var(--border);
		background: var(--bg-tertiary);
		color: var(--text-primary);
		padding: 0 0.55rem;
		font-size: 0.76rem;
	}

	.friend-toolbar-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 0.35rem;
	}

	.empty-state {
		padding: 2rem 1rem;
		text-align: center;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}

	.role-group {
		margin-bottom: 0.55rem;
	}

	.role-header {
		padding: 0.45rem 0.3rem 0.3rem;
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		color: var(--text-secondary);
		letter-spacing: 0.04em;
		text-align: left;
	}

	.user-row {
		display: flex;
		align-items: center;
		justify-content: flex-start;
		gap: 0.5rem;
		padding: 0.48rem 0.35rem;
		width: 100%;
		background: transparent;
		border: none;
		color: var(--text-primary);
		cursor: pointer;
		text-align: left;
		border-radius: 10px;
		transition:
			background 0.15s,
			transform 0.15s;
		margin-bottom: 0.08rem;
	}

	.user-row:hover {
		background: color-mix(in srgb, var(--accent) 8%, transparent);
		transform: translateY(-1px);
	}

	.user-row.offline {
		opacity: 0.58;
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
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.user-handle {
		font-size: 0.7rem;
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	@media (max-width: 768px) {
		.friend-search,
		.friend-select {
			font-size: 16px;
		}

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
