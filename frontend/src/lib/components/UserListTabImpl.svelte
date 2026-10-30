<script context="module" lang="ts">
	let peopleListCounter = 0;
	/** People lists on screen: a stacked re-render mounts the new list before the old one leaves. */
	let livePeopleLists = 0;
</script>

<script lang="ts">
	import './UserListTabImpl.css';
	import { get, type Readable } from 'svelte/store';
	import { createEventDispatcher, onDestroy, onMount } from 'svelte';
	import { users, serverMembers, currentUser, currentChannel, channels, createDM, joinChannel, socket, roleDefinitions, voiceChannelMembers, typingUsers } from '$lib/socket';
	import { attachUserBanListeners, bannedUserIds } from '$lib/presenceStore';
	import { showToast } from '$lib/toast';
	import { layoutStore } from '$lib/layoutStore';
	import { activeRightTab, activeWorkspace, centerDmChannelId, centerPanelView, rightPanelMode, selectedDmChannelId } from '$lib/layoutStoreStates';
	import type { Channel, User } from '$lib/socket';
	import { resolveDmEntry } from '$lib/dmEntry';
	import ContextMenu, { type MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
	import UserPopout from '$lib/components/UserPopout.svelte';
	import ProfileName from '$lib/components/ProfileName.svelte';
	import ProfileMedia from '$lib/components/ProfileMedia.svelte';
	import ProfileDecoration from '$lib/components/ProfileDecoration.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import type { IconName } from '$lib/components/ui/icons';
	import { profileDecorationsVisible } from '$lib/profileAppearance';
	import { resolveUserDisplayColor } from '$lib/accessibility';
	import { displayEnhancementSettingsStore } from '$lib/displayEnhancements';
	import { rememberPeople } from '$lib/peopleTracker';
	import { getAuthToken } from '$lib/authSession';
	import { canFriendUser, friendshipRelation } from '$lib/friendshipRelation';
	import { acceptFriendship, dismissFriendship, friendships, removeFriendship, requestFriendship, startFriendshipSync } from '$lib/friendships';
	import { roleBadgeLabel } from '$lib/badges';
	import { inkFor } from '$lib/theme/identity';
	import {
		PEOPLE_SHOW_LABELS,
		buildPeopleEntries,
		buildPeopleGroups,
		personAriaLabel,
		personKey,
		personSubline,
		writingChannelFor,
		type PeopleGroup,
		type PeopleGrouping,
		type PeopleShow,
		type PeopleVoiceRoom,
		type PersonEntry,
		type PersonSubline
	} from './userPanelHelpers';
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
		matchesSearch,
		buildUserMenuItems,
		queuePayment,
		requestLiveRoleChange,
		startDMCall,
		type BuildMenuContext
	} from './userListHelpers';
	import { mediaUrl } from '$lib/mediaUrl';
	import { setPanelFrameCount } from '$lib/workspacePanels';

	type PersonRow = {
		key: string;
		user: User;
		name: string;
		initial: string;
		/** Identity color for the name ink and the stamp; '' inherits (away and offline rows). */
		nameColor: string;
		ink: string;
		presence: PersonEntry['presence'];
		speaking: boolean;
		subline: PersonSubline | null;
		roleWord: string | null;
		roleTitle: string | null;
		ariaLabel: string;
	};
	type GroupView = Omit<PeopleGroup, 'entries'> & { headingId: string; rows: PersonRow[] };

	const listId = `people-${++peopleListCounter}`;
	const ROLE_TITLES: Record<string, string> = {
		Owner: 'Community owner',
		Admin: 'Community admin',
		Mod: 'Community moderator',
		Bot: 'Bot account'
	};
	// Chrome labels in sentence case (spec §9.6); role names keep the caller's casing.
	const MENU_LABELS: Record<string, string> = {
		'View My Profile': 'View my profile',
		'View Profile': 'View profile',
		'Remove Friend': 'Remove friend',
		'Accept Friend Request': 'Accept friend request',
		'Cancel Friend Request': 'Cancel friend request',
		'Add Friend': 'Add friend',
		'Request Payment': 'Request payment',
		'Voice Call': 'Voice call',
		'Video Call': 'Video call',
		'Stop Status Alerts': 'Stop status alerts',
		'Track Status Alerts': 'Track status alerts',
		'Set Local Nickname': 'Set local nickname',
		'Clear Local Nickname': 'Clear local nickname',
		'Reset to Member': 'Reset to member'
	};
	const MENU_ICONS: Record<string, IconName> = {
		'track-status': 'bell',
		'nickname-set': 'pencil',
		'nickname-clear': 'pencil',
		'reset-member': 'shield',
		'ban-user': 'shield',
		'unban-user': 'shield'
	};

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
	let peopleShow: PeopleShow = 'all';
	let peopleGrouping: PeopleGrouping = 'place';
	let offlineSectionExpanded = false;

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
		return () => {
			for (const stop of stopNavigation) stop();
			stopFriendshipSync();
		};
	});

	$: rolePriority = buildRolePriority($roleDefinitions);
	$: roleLabelMap = buildRoleLabelMap($roleDefinitions);
	// BetterFriendList add-on: search, show and group controls in row B.
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

	/** The person's identity color (role color when the role-color setting asks for it), never a CSS variable. */
	function getDisplayColor(user: User): string {
		const color = resolveUserDisplayColor(user.roleColor, user.color);
		return color.startsWith('var(') ? '' : color;
	}

	function roleWordFor(user: User): string | null {
		if (user.isBot) return 'Bot';
		return roleBadgeLabel(user);
	}

	function initialOf(name: string): string {
		const first = Array.from(name.trim())[0];
		return first ? first.toLocaleUpperCase() : '?';
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

	$: rememberPeople($users);
	$: rememberPeople($serverMembers);

	// Everyone connected (the viewer always counts as here) and every member of the community.
	$: onlinePeople = $currentUser ? [$currentUser, ...$users] : $users;
	$: voiceRooms = $channels
		.filter((channel) => channel.type === 'voice')
		.map((channel): PeopleVoiceRoom => ({ id: channel.id, name: channel.name, members: $voiceChannelMembers[channel.id] || [] }));
	$: peopleCount = buildPeopleEntries({ online: onlinePeople, members: $serverMembers, self: $currentUser, rooms: [] }).length;
	// The frame's title row shows how many people the community has (row A: "People 8").
	$: setPanelFrameCount('users', peopleCount);
	livePeopleLists += 1;
	onDestroy(() => {
		livePeopleLists -= 1;
		if (livePeopleLists === 0) setPanelFrameCount('users', null);
	});

	// Every input the rows read is named in this statement, so Svelte re-derives the rows when any
	// of them changes (helpers called from the template would not track stores read inside them).
	$: peopleGroups = buildPeopleGroups({
		online: onlinePeople,
		members: $serverMembers,
		self: $currentUser,
		rooms: voiceRooms,
		show: isEnhanced ? peopleShow : 'all',
		grouping: isEnhanced ? peopleGrouping : 'place',
		matches: (user) => matchesSearch(user, friendSearchQuery, isEnhanced, (candidate) => (localNickEnabled ? $localNicknamesStore[getUserIdentityKey(candidate) || ''] || candidate.username : candidate.username)),
		displayName: getDisplayName,
		rolePriority,
		roleLabel: (role) => getRoleLabel(role, roleLabelMap)
	});
	$: groupViews = buildGroupViews(peopleGroups, $inkFor, $typingUsers, $channels, $currentChannel, $localNicknamesStore, localNickEnabled);
	$: offlineOpen = offlineSectionExpanded || peopleShow === 'offline' || friendSearchQuery.trim() !== '';
	$: filterApplied = isEnhanced && peopleShow !== 'all';

	function buildGroupViews(
		groups: PeopleGroup[],
		ink: (color: string | null | undefined) => string,
		typing: Record<string, string[]>,
		channelList: Channel[],
		currentChannelId: string | null,
		_nicknames: unknown,
		_nicknamesOn: boolean
	): GroupView[] {
		return groups.map(({ entries, ...group }) => ({
			...group,
			headingId: `${listId}-${group.id.replace(/[^A-Za-z0-9_-]/g, '_')}`,
			rows: entries.map((entry) => {
				const name = getDisplayName(entry.user);
				const quiet = entry.presence === 'away' || entry.presence === 'offline';
				const color = getDisplayColor(entry.user);
				const writing = entry.isSelf ? null : writingChannelFor(entry.user, typing, channelList, currentChannelId);
				const subline = personSubline(entry, writing);
				const roleWord = roleWordFor(entry.user);
				return {
					key: `${group.id}:${personKey(entry.user)}`,
					user: entry.user,
					name,
					initial: initialOf(name),
					nameColor: quiet ? '' : color,
					ink: ink(color),
					presence: entry.presence,
					speaking: entry.voice === 'speaking',
					subline,
					roleWord,
					roleTitle: roleWord ? ROLE_TITLES[roleWord] ?? roleWord : null,
					ariaLabel: personAriaLabel(name, entry, subline, roleWord)
				};
			})
		}));
	}

	$: filterMenuItems = [
		{ id: 'k-show', type: 'kicker', label: 'Show' },
		...(['all', 'here', 'away', 'offline'] as const).map((value) => ({
			id: `show:${value}`,
			label: PEOPLE_SHOW_LABELS[value],
			role: 'menuitemradio' as const,
			checked: peopleShow === value
		})),
		{ id: 'k-group', type: 'kicker', label: 'Group' },
		{ id: 'group:place', label: 'By place', role: 'menuitemradio', checked: peopleGrouping === 'place' },
		{ id: 'group:role', label: 'By role', role: 'menuitemradio', checked: peopleGrouping === 'role' },
		{ id: 'k-sort', type: 'kicker', label: 'Sort' },
		{ id: 'sort:name', label: 'By name', role: 'menuitemradio', checked: true }
	] satisfies MenuEntry[];

	function handleFilterSelect(id: string): void {
		const [kind, value] = id.split(':');
		if (kind === 'show' && (value === 'all' || value === 'here' || value === 'away' || value === 'offline')) peopleShow = value;
		if (kind === 'group' && (value === 'place' || value === 'role')) peopleGrouping = value;
	}

	function clearSearch(): void {
		friendSearchQuery = '';
	}

	function openProfileFor(user: User, anchor: HTMLElement): void {
		closeContextMenu();
		if (showProfile && profileUser && profileAnchor === anchor && personKey(profileUser) === personKey(user)) {
			closeProfile();
			return;
		}
		profileUser = user;
		profileAnchor = anchor;
		showProfile = true;
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
	$: userMenuItems = rawMenuItems.map((item): MenuEntry => {
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
		const isRoleRow = item.id.startsWith('make-role:') || item.id.startsWith('remove-role:');
		// Moderation rows wear the seal glyph (spec §7.4); role names stay exactly as written.
		const moderation = isRoleRow || item.id === 'reset-member' || item.id === 'ban-user' || item.id === 'unban-user';
		const entry: MenuEntry = {
			...item,
			label: item.label ? MENU_LABELS[item.label] ?? item.label : item.label,
			icon: isRoleRow ? 'shield' : MENU_ICONS[item.id] ?? item.icon,
			seal: moderation || undefined,
			keepCase: isRoleRow || undefined
		};
		if (handlers[item.id]) return { ...entry, onSelect: handlers[item.id] };
		// Live role entries from the role catalog (`make-role:<id>` grants,
		// `remove-role:<id>` reverts to member).
		if (item.id.startsWith('make-role:')) {
			const roleName = item.id.slice('make-role:'.length);
			return { ...entry, onSelect: () => handleAssignContextRole(roleName) };
		}
		if (item.id.startsWith('remove-role:')) {
			return { ...entry, onSelect: () => handleRemoveContextRole() };
		}
		return entry;
	});

	$: profileKey = showProfile && profileUser ? personKey(profileUser) : null;
</script>

<div class="user-list-tab">
	{#if isEnhanced}
		<div class="people-rowb">
			<label class="w-field w-field--chrome people-find">
				<Icon name="search" size={16} />
				<input
					type="search"
					bind:value={friendSearchQuery}
					placeholder="Search people"
					aria-label="Search people"
					autocomplete="off"
					spellcheck="false"
				/>
			</label>
			<Menu
				items={filterMenuItems}
				label="Show and group people"
				triggerLabel={filterApplied ? `Filter people, showing ${PEOPLE_SHOW_LABELS[peopleShow].toLowerCase()}` : 'Filter people'}
				class={filterApplied ? 'w-ibtn w-ibtn--edge w-ibtn--dot people-filter' : 'w-ibtn w-ibtn--edge people-filter'}
				align="end"
				heading="People"
				onselect={handleFilterSelect}
			>
				<Icon name="sliders" />
			</Menu>
		</div>
		{#if filterApplied}
			<div class="people-chips">
				<span class="w-tag people-chip">
					{PEOPLE_SHOW_LABELS[peopleShow]} only
					<button type="button" class="people-chip-clear" aria-label="Show everyone" on:click={() => (peopleShow = 'all')}>
						<Icon name="x" size={12} />
					</button>
				</span>
			</div>
		{/if}
	{/if}

	<div class="people-body">
		{#each groupViews as group (group.id)}
			<div class="people-group" role="group" aria-labelledby={group.headingId}>
				{#if group.kind === 'offline'}
					<h3 class="people-head">
						<button
							type="button"
							class="people-head-toggle"
							aria-expanded={offlineOpen}
							aria-controls={`${group.headingId}-rows`}
							on:click={() => (offlineSectionExpanded = !offlineOpen)}
						>
							<span class="w-kicker" id={group.headingId}>{group.label}</span>
							<span class="people-rule" aria-hidden="true"></span>
							<span class="w-count" aria-label={`${group.rows.length} offline`}>{group.rows.length}</span>
							<Icon name={offlineOpen ? 'chevUp' : 'chevDown'} size={14} />
						</button>
					</h3>
				{:else}
					<h3 class="people-head">
						<span class="w-kicker" id={group.headingId}>{group.label}</span>
						<span class="people-rule" aria-hidden="true"></span>
						<span class="w-count" aria-label={`${group.rows.length} ${group.rows.length === 1 ? 'person' : 'people'}`}>{group.rows.length}</span>
					</h3>
				{/if}
				{#if group.kind !== 'offline' || offlineOpen}
					<div class="people-rows" id={`${group.headingId}-rows`}>
						{#each group.rows as row (row.key)}
							<div
								class="prow-shell"
								class:is-away={row.presence === 'away'}
								class:is-offline={row.presence === 'offline'}
								style={row.ink}
							>
								<button
									type="button"
									class="prow"
									data-member-row
									aria-label={row.ariaLabel}
									aria-haspopup="dialog"
									aria-expanded={profileKey === personKey(row.user) && profileAnchor !== null}
									on:click={(event) => openProfileFor(row.user, event.currentTarget)}
									on:contextmenu={(event) => handleRightClick(event, row.user)}
								>
									<span class="prow-av" class:is-speaking={row.speaking}>
										{#if row.user.profilePicture}
											<ProfileMedia src={mediaUrl(row.user.profilePicture)} decorative class="prow-pic" />
										{:else}
											<span class="prow-stamp" aria-hidden="true">{row.initial}</span>
										{/if}
										{#if row.user.overlayUrl && $profileDecorationsVisible}
											<ProfileDecoration user={row.user} class="avatar-overlay-badge" />
										{/if}
										<span class="prow-presence" data-presence={row.presence} aria-hidden="true"></span>
									</span>
									<span class="prow-text">
										<span class="prow-name"><ProfileName username={row.name} font={row.user.usernameFont} color={row.nameColor} /></span>
										{#if row.subline}
											<span class="prow-sub" class:is-handle={row.subline.tone === 'handle'} class:is-speaking={row.subline.tone === 'speaking'}>
												{#if row.subline.glyph}<Icon name={row.subline.glyph} size={12} />{/if}
												<span class="prow-sub-text">{row.subline.text}</span>
											</span>
										{/if}
									</span>
									{#if row.roleWord}
										<span class="w-role prow-role" title={row.roleTitle}>{row.roleWord}</span>
									{/if}
								</button>
								<button
									type="button"
									class="w-ibtn w-ibtn--sm prow-more"
									aria-label={`Actions for ${row.name}`}
									aria-haspopup="menu"
									on:click={(event) => handleMoreClick(event, row.user)}
									on:contextmenu={(event) => handleRightClick(event, row.user)}
								>
									<Icon name="more" size={16} />
								</button>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/each}

		{#if groupViews.length === 0}
			{#if friendSearchQuery.trim() || filterApplied}
				<EmptyState
					class="people-empty"
					as="p"
					icon="users"
					title="No one matches"
					text={friendSearchQuery.trim() ? 'Try another name or handle.' : `No one is ${PEOPLE_SHOW_LABELS[peopleShow].toLowerCase()} right now.`}
					action={friendSearchQuery.trim() ? 'Clear search' : 'Show everyone'}
					onaction={() => (friendSearchQuery.trim() ? clearSearch() : (peopleShow = 'all'))}
				/>
			{:else}
				<EmptyState
					class="people-empty"
					as="p"
					icon="users"
					title="No one here yet"
					text="People appear here as soon as they join this community."
				/>
			{/if}
		{/if}
	</div>

	<ContextMenu
		open={showContextMenu && !!contextMenuUser}
		x={contextMenuPosition.x}
		y={contextMenuPosition.y}
		items={userMenuItems}
		ariaLabel="Member actions"
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
