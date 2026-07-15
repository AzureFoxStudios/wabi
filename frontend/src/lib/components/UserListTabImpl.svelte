<script lang="ts">
	import './UserListTabImpl.css';
	import { get } from 'svelte/store';
	import { users, serverMembers, currentUser, channels, createDM, getDMChannelIdForUser, socket, assignRole, removeUserRole, banUser, roleDefinitions } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import type { User } from '$lib/socket';
	import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';
	import type { ContextMenuItem } from '$lib/context-menu/types';
	import { resolveUserDisplayColor } from '$lib/accessibility';
	import { displayEnhancementSettingsStore } from '$lib/displayEnhancements';
	import { rememberPeople } from '$lib/peopleTracker';
	import { getStatusColor } from './userPanelHelpers';
	import {
		MAX_LOCAL_NICKNAME_LENGTH,
		clearLocalNicknameForUser,
		getLocalNicknameForUser,
		getUserIdentityKey,
		localNicknamesStore,
		setLocalNicknameForUser
	} from '$lib/localNicknames';
	import {
		buildRolePriority,
		buildRoleLabelMap,
		getRoleLabel,
		isCurrentUserEntry,
		sortUsersList,
		matchesSearch,
		matchesPresenceFilter,
		buildUserMenuItems,
		queuePayment,
		startDMCall,
		type BuildMenuContext
	} from './userListHelpers';

	let contextMenuUser: User | null = null;
	let contextMenuPosition = { x: 0, y: 0 };
	let showContextMenu = false;
	let friendSearchQuery = '';
	let friendPresenceFilter: 'all' | 'active' | 'away' | 'busy' | 'offline' = 'all';
	let friendSortMode: 'role' | 'name' | 'status' = 'role';
	let offlineSectionExpanded = false;

	$: rolePriority = buildRolePriority($roleDefinitions);
	$: roleLabelMap = buildRoleLabelMap($roleDefinitions);
	$: isEnhanced = $displayEnhancementSettingsStore.betterFriendListEnabled;
	$: localNickEnabled = $displayEnhancementSettingsStore.localNicknamesEnabled;

	function getLocalNickname(user: User): string {
		if (!localNickEnabled) return '';
		const key = getUserIdentityKey(user);
		return key ? $localNicknamesStore[key] || '' : '';
	}

	function getDisplayName(user: User): string {
		return getLocalNickname(user) || user.username;
	}

	function hasContextLocalNickname(): boolean {
		if (!contextMenuUser) return false;
		return Boolean(getLocalNickname(contextMenuUser));
	}

	function promptSetContextLocalNickname(): void {
		if (!contextMenuUser) return;
		const currentNickname = getLocalNicknameForUser(contextMenuUser);
		const draft = window.prompt(`Set local nickname (max ${MAX_LOCAL_NICKNAME_LENGTH} characters)`, currentNickname || contextMenuUser.username);
		if (draft === null) return;
		setLocalNicknameForUser(contextMenuUser, draft);
		closeContextMenu();
	}

	function clearContextLocalNickname(): void {
		if (!contextMenuUser) return;
		clearLocalNicknameForUser(contextMenuUser);
		closeContextMenu();
	}

	$: onlineOtherUsers = sortUsersList(
		$users.filter((user) => {
			if (!matchesSearch(user, friendSearchQuery, isEnhanced, getDisplayName)) return false;
			return matchesPresenceFilter(user, friendPresenceFilter, false, isEnhanced);
		}),
		friendSortMode,
		rolePriority,
		isEnhanced
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
			groups[role] = sortUsersList(groups[role], friendSortMode, rolePriority, isEnhanced);
		}
		return groups;
	})();

	$: sortedRoles = Object.keys(groupedUsers).sort((a, b) => (rolePriority[b] || 0) - (rolePriority[a] || 0));

	$: offlineUsers = (() => {
		const onlineDbIds = new Set($users.map(u => u.dbUserId).filter(Boolean));
		return $serverMembers
			.filter(m => !onlineDbIds.has(m.dbUserId))
			.filter((user) => matchesSearch(user, friendSearchQuery, isEnhanced, getDisplayName))
			.filter((user) => matchesPresenceFilter(user, friendPresenceFilter, true, isEnhanced))
			.sort((a, b) => a.username.localeCompare(b.username));
	})();

	function handleUserClick(user: User) {
		if (isCurrentUserEntry(user, $currentUser)) {
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
		if (isCurrentUserEntry(contextMenuUser, $currentUser)) {
			layoutStore.openNotes();
			closeContextMenu();
			return;
		}
		openDirectConversationWithUser(contextMenuUser);
		closeContextMenu();
	}

	function openDirectConversationWithUser(user: User): void {
		const self = get(currentUser);
		if (!self || isCurrentUserEntry(user, $currentUser)) return;
		const dmId = "";
		const existingDM = get(channels).find((channel) => channel.id === dmId);
		if (existingDM) {
			layoutStore.openDM(dmId, user);
			return;
		}
		undefined;
		layoutStore.showDMsTab();
		const unsubscribe = channels.subscribe((allChannels) => {
			const newDM = allChannels.find((channel) => channel.id === dmId || (channel.type === 'dm' && channel.otherUser?.id === user.id));
			if (!newDM) return;
			layoutStore.openDM(newDM.id, user);
			unsubscribe();
		});
	}

	function handleContextRequestPayment(): void {
		if (!contextMenuUser || isCurrentUserEntry(contextMenuUser, $currentUser) || !contextMenuUser.dbUserId) return;
		queuePayment('payment_request', contextMenuUser);
		openDirectConversationWithUser(contextMenuUser);
		closeContextMenu();
	}

	function handleContextManualCash(): void {
		if (!contextMenuUser || isCurrentUserEntry(contextMenuUser, $currentUser) || !contextMenuUser.dbUserId) return;
		queuePayment('manual_cash', contextMenuUser);
		openDirectConversationWithUser(contextMenuUser);
		closeContextMenu();
	}

	async function handleContextVoiceCall() {
		if (!contextMenuUser || !$socket || isCurrentUserEntry(contextMenuUser, $currentUser)) return;
		closeContextMenu();
		await startDMCall($socket, contextMenuUser, false);
	}

	async function handleContextVideoCall() {
		if (!contextMenuUser || !$socket || isCurrentUserEntry(contextMenuUser, $currentUser)) return;
		closeContextMenu();
		await startDMCall($socket, contextMenuUser, true);
	}

	function handleBanContextUser(): void {
		if (!contextMenuUser?.dbUserId) return;
		const confirmBan = window.confirm(`Ban ${contextMenuUser.username}? They will lose access until manually re-enabled.`);
		if (!confirmBan) return;
		const reasonInput = window.prompt('Ban reason (optional):', '') || '';
		banUser(contextMenuUser.dbUserId, reasonInput);
		closeContextMenu();
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

	function buildMenuCtx(): BuildMenuContext {
		return {
			contextMenuUser,
			currentUser: $currentUser,
			rolePriority,
			localNicknamesEnabled: localNickEnabled,
			hasLocalNickname: hasContextLocalNickname(),
			socket: $socket
		};
	}

	$: rawMenuItems = buildUserMenuItems(buildMenuCtx());
	$: userMenuItems = rawMenuItems.map((item: ContextMenuItem) => {
		const handlers: Record<string, () => void> = {
			message: handleContextMessage,
			'request-payment': handleContextRequestPayment,
			'record-cash': handleContextManualCash,
			voice: handleContextVoiceCall,
			video: handleContextVideoCall,
			'nickname-set': promptSetContextLocalNickname,
			'nickname-clear': clearContextLocalNickname,
			'make-admin': () => handleAssignContextRole('admin'),
			'remove-admin': () => handleRemoveContextRole('admin'),
			'make-mod': () => handleAssignContextRole('mod'),
			'remove-mod': () => handleRemoveContextRole('mod'),
			'reset-member': handleResetContextUserToMember,
			'ban-user': handleBanContextUser
		};
		if (handlers[item.id]) return { ...item, onSelect: handlers[item.id] };
		return item;
	});

	function getDisplayColor(user: User): string {
		return resolveUserDisplayColor(user.roleColor, user.color);
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
				{getRoleLabel(role, roleLabelMap)} - {groupedUsers[role].length}
			</div>
			{#each groupedUsers[role] as user, i (user.id ?? "u" + i)}
				<button
					class="user-row"
					on:click={() => handleUserClick(user)}
					on:contextmenu={(e) => handleRightClick(e, user)}
				>
					<div class="user-avatar-wrap">
						{#if user.profilePicture}
							<img src={user.profilePicture} alt={getDisplayName(user)} class="user-avatar" />
						{:else}
							<div class="user-avatar-placeholder" style="--avatar-color: {user.color}">
								{getDisplayName(user).charAt(0).toUpperCase()}
							</div>
						{/if}
						<span class="presence-dot" class:active={user.status === 'active'} class:away={user.status === 'away'} class:busy={user.status === 'busy'} style="--status-color: {getStatusColor(user.status)}"></span>
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
			<button class="role-header offline-toggle" on:click={() => (offlineSectionExpanded = !offlineSectionExpanded)}>
				<span class="offline-chevron" class:expanded={offlineSectionExpanded}>›</span>
				Offline — {offlineUsers.length}
			</button>
			{#if offlineSectionExpanded}
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
								<div class="user-avatar-placeholder" style="--avatar-color: {user.color}">
									{getDisplayName(user).charAt(0).toUpperCase()}
								</div>
							{/if}
							<span class="presence-dot" style="--status-color: {getStatusColor('offline')}"></span>
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
			{/if}
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
