<script lang="ts">
	import './UserListTabImpl.css';
	import { get, type Readable } from 'svelte/store';
	import { createEventDispatcher, onMount } from 'svelte';
	import { users, serverMembers, currentUser, currentChannel, channels, createDM, joinChannel, socket, roleDefinitions } from '$lib/socket';
	import { attachUserBanListeners, bannedUserIds } from '$lib/presenceStore';
	import { showToast } from '$lib/toast';
	import { layoutStore } from '$lib/layoutStore';
	import { activeRightTab, activeWorkspace, centerDmChannelId, centerPanelView, rightPanelMode, selectedDmChannelId } from '$lib/layoutStoreStates';
	import type { User } from '$lib/socket';
	import { resolveDmEntry } from '$lib/dmEntry';
	import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';
	import UserPopout from '$lib/components/UserPopout.svelte';
	import RoleBadge from '$lib/components/RoleBadge.svelte';
	import type { ContextMenuItem } from '$lib/context-menu/types';
	import { resolveUserDisplayColor } from '$lib/accessibility';
	import { displayEnhancementSettingsStore } from '$lib/displayEnhancements';
	import { rememberPeople } from '$lib/peopleTracker';
	import { getAuthToken } from '$lib/authSession';
	import { canFriendUser, friendshipRelation } from '$lib/friendshipRelation';
	import { acceptFriendship, dismissFriendship, friendships, removeFriendship, requestFriendship, startFriendshipSync } from '$lib/friendships';
	import { getStatusColor } from './userPanelHelpers';
	import { overlayStyle } from '$lib/overlayStyle';
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
		requestLiveRoleChange,
		startDMCall,
		type BuildMenuContext
	} from './userListHelpers';

	let contextMenuUser: User | null = null;
	let contextMenuAnchor: HTMLElement | null = null;
	let contextMenuPosition = { x: 0, y: 0 };
	let showContextMenu = false;
	let profileUser: User | null = null;
	let profileAnchor: HTMLElement | null = null;
	let showProfile = false;
	let friendActionBusy = false;
	const dispatch = createEventDispatcher<{ openSettings: void }>();
	let friendSearchQuery = '';
	let friendPresenceFilter: 'all' | 'active' | 'away' | 'busy' | 'offline' = 'all';
	let friendSortMode: 'role' | 'name' | 'status' = 'role';
	let offlineSectionExpanded = false;

	// Mirrors the popout/ProfileCard `disableAllBanners` profile-visibility kill
	// switch (localStorage `wabi:profile:visibility` -> disableAll): suppresses
	// avatar overlays when the user hides all banners/decorations.
	let disableAllBanners = false;

	const BANNER_VISIBILITY_KEY = 'wabi:profile:visibility';

	function dismissOnNavigationChange<T>(store: Readable<T>): () => void {
		let seenInitial = false;
		let previous: T;
		return store.subscribe((next) => {
			if (seenInitial && next !== previous) closePeopleOverlays();
			previous = next;
			seenInitial = true;
		});
	}

	onMount(() => {
		const stopFriendshipSync = startFriendshipSync();
		const stopNavigation = [
			dismissOnNavigationChange(centerDmChannelId),
			dismissOnNavigationChange(selectedDmChannelId),
			dismissOnNavigationChange(currentChannel),
			dismissOnNavigationChange(centerPanelView),
			dismissOnNavigationChange(activeRightTab),
			dismissOnNavigationChange(rightPanelMode),
			dismissOnNavigationChange(activeWorkspace)
		];
		try {
			const raw = localStorage.getItem(BANNER_VISIBILITY_KEY);
			if (raw) {
				const v = JSON.parse(raw);
				if (typeof v.disableAll === 'boolean') disableAllBanners = v.disableAll;
			}
		} catch {
			// ignore malformed local state
		}
		return () => {
			for (const stop of stopNavigation) stop();
			stopFriendshipSync();
		};
	});

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

	function getUserRowKey(user: User, group: string, index: number): string {
		return getUserIdentityKey(user) || `${group}:${user.username || 'guest'}:${index}`;
	}

	function uniqueUsers(usersToNormalize: User[]): User[] {
		const seen = new Set<string>();
		return usersToNormalize.filter((user, index) => {
			const key = getUserIdentityKey(user) || `guest:${user.username || 'unknown'}:${index}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
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
		uniqueUsers($users).filter((user) => {
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
		return uniqueUsers($serverMembers)
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

	function openContextMenu(user: User, anchor: HTMLElement, x: number, y: number) {
		closeProfile();
		contextMenuUser = user;
		contextMenuAnchor = anchor;
		contextMenuPosition = { x, y };
		showContextMenu = true;
	}

	function handleRightClick(event: MouseEvent, user: User) {
		event.preventDefault();
		event.stopPropagation();
		openContextMenu(user, event.currentTarget as HTMLElement, event.clientX, event.clientY);
	}

	function handleMoreClick(event: MouseEvent, user: User) {
		event.stopPropagation();
		const anchor = event.currentTarget as HTMLElement;
		const rect = anchor.getBoundingClientRect();
		openContextMenu(user, anchor, rect.right, rect.bottom);
	}

	function closeContextMenu() {
		showContextMenu = false;
		contextMenuUser = null;
		contextMenuAnchor = null;
	}

	function closeProfile() {
		showProfile = false;
		profileUser = null;
		profileAnchor = null;
	}

	function closePeopleOverlays() {
		closeContextMenu();
		closeProfile();
	}

	function handleContextProfile() {
		const target = contextMenuUser;
		const anchor = contextMenuAnchor;
		closeContextMenu();
		if (!target || !anchor) return;
		// The selected menu item is outside the profile card. Open after its
		// click has bubbled, or the card's outside-click listener closes it.
		setTimeout(() => {
			if (!anchor.isConnected) return;
			profileUser = target;
			profileAnchor = anchor;
			showProfile = true;
		}, 0);
	}

	async function handleContextFriendAction() {
		const target = contextMenuUser;
		const relation = friendshipRelation($friendships, target?.dbUserId);
		closeContextMenu();
		if (!target || !canFriendUser(target) || !$currentUser?.dbUserId || !$friendships.ready || friendActionBusy) return;
		friendActionBusy = true;
		try {
			if (relation.kind === 'friend') {
				if (!window.confirm(`Remove ${target.username} from your friends?`)) return;
				await removeFriendship(target.dbUserId!);
				showToast(`Removed ${target.username} from friends.`, 'info');
			} else if (relation.kind === 'incoming') {
				await acceptFriendship(relation.request.id);
				showToast(`You and ${target.username} are friends.`, 'info');
			} else if (relation.kind === 'outgoing') {
				await dismissFriendship(relation.request.id);
				showToast(`Request to ${target.username} cancelled.`, 'info');
			} else {
				await requestFriendship(target.dbUserId!);
				showToast(`Friend request sent to ${target.username}.`, 'info');
			}
		} catch (error) {
			showToast(error instanceof Error ? error.message : 'Could not update friendship.', 'error');
		} finally {
			friendActionBusy = false;
		}
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

	async function openDirectConversationWithUser(user: User): Promise<void> {
		const self = get(currentUser);
		if (!self || isCurrentUserEntry(user, $currentUser)) return;

		const result = await resolveDmEntry({
			channels: get(channels),
			target: user,
			createDm: createDM
		});
		if (result.ok === false) {
			showToast(result.error, 'error');
			return;
		}

		layoutStore.openCenterDm(result.channelId, user);
		if ($layoutStore.isMobile) layoutStore.closeRightPanel();
		joinChannel(result.channelId);
	}

	function handleContextRequestPayment(): void {
		if (!contextMenuUser || isCurrentUserEntry(contextMenuUser, $currentUser) || !contextMenuUser.dbUserId) return;
		queuePayment(contextMenuUser);
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

	async function handleAssignContextRole(roleName: string) {
		const target = contextMenuUser;
		if (!target?.dbUserId) return;
		closeContextMenu();
		try {
			await requestLiveRoleChange($socket, target.dbUserId, roleName);
			showToast(`Role updated for ${target.username}.`, 'info');
		} catch (error) {
			showToast(error instanceof Error ? error.message : 'Could not change this member’s role.', 'error');
		}
	}

	function handleRemoveContextRole() {
		void handleAssignContextRole('member');
	}

	function handleResetContextUserToMember() {
		void handleAssignContextRole('member');
	}

	// Keep the client-side ban mirror fed by `user-banned`/`user-unbanned`
	// broadcasts while this list is alive (idempotent per socket).
	$: if ($socket) {
		try { attachUserBanListeners($socket); } catch { /* best-effort */ }
	}

	async function handleBanContextUser() {
		const target = contextMenuUser;
		if (!target?.dbUserId) return;
		if (!window.confirm(`Ban @${target.username} from this server? They will be logged out and blocked from signing in.`)) return;
		closeContextMenu();
		try {
			const { banUser } = await import('$lib/presenceStore');
			await banUser(target.dbUserId);
			showToast(`Banned @${target.username}.`, 'info');
		} catch (error) {
			showToast(error instanceof Error ? error.message : 'Could not ban this member.', 'error');
		}
	}

	async function handleUnbanContextUser() {
		const target = contextMenuUser;
		if (!target?.dbUserId) return;
		closeContextMenu();
		try {
			const { unbanUser } = await import('$lib/presenceStore');
			await unbanUser(target.dbUserId);
			showToast(`Unbanned @${target.username}.`, 'info');
		} catch (error) {
			showToast(error instanceof Error ? error.message : 'Could not unban this member.', 'error');
		}
	}

	// Keep every menu input visible to Svelte's dependency tracking. Building
	// this through a zero-argument helper left the menu empty after right-click.
	$: rawMenuItems = buildUserMenuItems({
		contextMenuUser,
		currentUser: $currentUser,
		friendRelation: friendshipRelation($friendships, contextMenuUser?.dbUserId),
		friendsAvailable: Boolean($currentUser?.dbUserId && getAuthToken()),
		friendsReady: $friendships.ready,
		friendActionBusy,
		rolePriority,
		localNicknamesEnabled: localNickEnabled,
		hasLocalNickname: Boolean(contextMenuUser && getLocalNickname(contextMenuUser)),
		socket: $socket,
		bannedUserIds: $bannedUserIds,
		roleDefinitions: $roleDefinitions
	} satisfies BuildMenuContext);
	$: userMenuItems = rawMenuItems.map((item: ContextMenuItem) => {
		const handlers: Record<string, () => void> = {
			profile: handleContextProfile,
			message: handleContextMessage,
			'friend-action': handleContextFriendAction,
			'request-payment': handleContextRequestPayment,
			voice: handleContextVoiceCall,
			video: handleContextVideoCall,
			'nickname-set': promptSetContextLocalNickname,
			'nickname-clear': clearContextLocalNickname,
			'reset-member': handleResetContextUserToMember,
			'ban-user': handleBanContextUser,
			'unban-user': handleUnbanContextUser
		};
		if (handlers[item.id]) return { ...item, onSelect: handlers[item.id] };
		// Live role entries from the role catalog (`make-role:<id>` grants,
		// `remove-role:<id>` reverts to member).
		if (item.id.startsWith('make-role:')) {
			const roleName = item.id.slice('make-role:'.length);
			return { ...item, onSelect: () => handleAssignContextRole(roleName) };
		}
		if (item.id.startsWith('remove-role:')) {
			return { ...item, onSelect: () => handleRemoveContextRole() };
		}
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
			{#each groupedUsers[role] as user, i (getUserRowKey(user, role, i))}
				<div class="user-row-shell">
					<button
						class="user-row"
						aria-label={isCurrentUserEntry(user, $currentUser) ? 'Open Notes' : `Message ${getDisplayName(user)}`}
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
						{#if user.overlayUrl && !disableAllBanners}
							<span class="avatar-overlay-badge" style={overlayStyle(user)} aria-hidden="true"></span>
						{/if}
						<span class="presence-dot" class:active={user.status === 'active'} class:away={user.status === 'away'} class:busy={user.status === 'busy'} style="--status-color: {getStatusColor(user.status)}"></span>
					</div>
					<div class="user-info">
						<span class="user-name-row">
							<span class="user-display-name" style="color: {getDisplayColor(user)}">
								{getDisplayName(user)}
							</span>
							<RoleBadge {user} size="sm" />
						</span>
						{#if user.handle}
							<span class="user-handle">@{user.handle}</span>
						{/if}
					</div>
					</button>
					<button type="button" class="user-row-actions" aria-label={`Actions for ${getDisplayName(user)}`} title={`Actions for ${getDisplayName(user)}`} on:click={(e) => handleMoreClick(e, user)} on:contextmenu={(e) => handleRightClick(e, user)}>⋯</button>
				</div>
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
				{#each offlineUsers as user, i (getUserRowKey(user, 'offline', i))}
					<div class="user-row-shell">
						<button
							class="user-row offline"
							aria-label={isCurrentUserEntry(user, $currentUser) ? 'Open Notes' : `Message ${getDisplayName(user)}`}
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
						{#if user.overlayUrl && !disableAllBanners}
							<span class="avatar-overlay-badge" style={overlayStyle(user)} aria-hidden="true"></span>
						{/if}
						<span class="presence-dot" style="--status-color: {getStatusColor('offline')}"></span>
						</div>
						<div class="user-info">
							<span class="user-name-row">
								<span class="user-display-name" style="color: {getDisplayColor(user)}">
									{getDisplayName(user)}
								</span>
								<RoleBadge {user} size="sm" />
							</span>
							{#if user.handle}
								<span class="user-handle">@{user.handle}</span>
							{/if}
						</div>
						</button>
						<button type="button" class="user-row-actions" aria-label={`Actions for ${getDisplayName(user)}`} title={`Actions for ${getDisplayName(user)}`} on:click={(e) => handleMoreClick(e, user)} on:contextmenu={(e) => handleRightClick(e, user)}>⋯</button>
					</div>
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
	<UserPopout
		user={profileUser}
		bind:isOpen={showProfile}
		anchorElement={profileAnchor}
		isOwnProfile={Boolean(profileUser && isCurrentUserEntry(profileUser, $currentUser))}
		on:close={closeProfile}
		on:openFullProfile={() => dispatch('openSettings')}
	/>
</div>
