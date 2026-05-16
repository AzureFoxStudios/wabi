<script lang="ts">
	import { createEventDispatcher, onDestroy } from 'svelte';
	import { channels, channelMessages, currentUser, users, serverMembers, createDM, deleteDM, leaveGroup, socket } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import { NOTES_DM_ID } from '$lib/layoutStore';
	import { startCall, startGroupCall, type GroupCallRingingTarget } from '$lib/calling';
	import type { ContextMenuIcon, ContextMenuItem } from '$lib/context-menu/types';
	import type { User, Channel } from '$lib/socket';
	import { dmPrivacyModes, setDMPrivacyMode, type DMPrivacyMode } from '$lib/dmPrivacyMode';
	import { pinnedDmIdsStore, prunePinnedDms, togglePinnedDm } from '$lib/pinDms';
	import { getUserIdentityKey } from '$lib/localNicknames';
	import { buildDmDirectoryUsers, getDmDirectoryKey } from '$lib/dmUserDirectory';
	import DMTabFrame from './DMTabFrame.svelte';
	type ConversationAction = {
		id: 'voice' | 'video' | 'remove';
		label: string;
		title: string;
		icon: ContextMenuIcon;
		danger?: boolean;
		showInline?: boolean;
		onSelect: () => void | Promise<void>;
	};

	const dispatch = createEventDispatcher<{
		openSettings: { paymentSurface: 'connections' };
	}>();

	let searchQuery = '';
	let showNewDM = false;
	let showCreateGroup = false;
	let showGroupSettings = false;
	let showContextMenu = false;
	let contextMenuX = 0;
	let contextMenuY = 0;
	let contextMenuChannel: Channel | null = null;
	let contextMenuUser: User | null = null;
	let showHeaderActionMenu = false;
	let headerActionMenuX = 0;
	let headerActionMenuY = 0;
	let activeHeaderElement: HTMLElement | null = null;
	let headerResizeObserver: ResizeObserver | null = null;
	let showCompactHeaderActions = false;
	const HEADER_INLINE_ACTION_BREAKPOINT = 370;

	$: selectedDmId = $layoutStore.selectedDmChannelId;
	$: dmOther = $layoutStore.dmOtherUser;
	$: selectedGroup = $layoutStore.selectedGroupChannel;
	$: isKeepNotesSelected = selectedDmId === NOTES_DM_ID;
	$: selectedDmChannel = selectedDmId ? $channels.find(ch => ch.id === selectedDmId) || null : null;
	$: selectedDmPrivacyMode = selectedDmChannel?.type === 'dm'
		? getConversationPrivacyMode(selectedDmChannel.id)
		: null;

	// Keep selectedGroup in sync with channels store (so avatar/member changes reflect)
	$: activeGroup = selectedGroup ? $channels.find(ch => ch.id === selectedGroup.id) || selectedGroup : null;

	$: dmConversationChannels = $channels.filter((ch) => ch.type === 'dm' || ch.type === 'group');
	$: pinnedDmSet = new Set($pinnedDmIdsStore);
	$: prunePinnedDms(dmConversationChannels.map((ch) => ch.id));
	$: dmChannels = [...dmConversationChannels].sort((a, b) => {
		const aPinned = pinnedDmSet.has(a.id);
		const bPinned = pinnedDmSet.has(b.id);
		if (aPinned !== bPinned) return aPinned ? -1 : 1;
		const aMsgs = $channelMessages[a.id] || [];
		const bMsgs = $channelMessages[b.id] || [];
		const aLast = aMsgs.length > 0 ? aMsgs[aMsgs.length - 1].timestamp : 0;
		const bLast = bMsgs.length > 0 ? bMsgs[bMsgs.length - 1].timestamp : 0;
		return bLast - aLast;
	});

	$: filteredUsers = buildDmDirectoryUsers({
		onlineUsers: $users as unknown as User[],
		serverMembers: $serverMembers as unknown as User[],
		currentUser: $currentUser,
		searchQuery
	});

	function getOtherUser(channel: Channel): User | null {
		if (channel.otherUser) return channel.otherUser;
		const myStableId = $currentUser?.dbUserId ? `user-${$currentUser.dbUserId}` : $currentUser?.id;
		const otherStableId = (channel.members || []).find((id: string) => id !== myStableId);
		if (!otherStableId) return null;
		if (otherStableId.startsWith('user-')) {
			const dbId = parseInt(otherStableId.substring(5), 10);
			return $users.find(u => u.dbUserId === dbId) || null;
		}
		return $users.find(u => u.id === otherStableId) || null;
	}


	function getConversationPrivacyMode(channelId: string): DMPrivacyMode {
		return $dmPrivacyModes[channelId] ?? 'sealed';
	}

	function getPrivacyModeLabel(mode: DMPrivacyMode): string {
		if (mode === 'open') return 'Open';
		if (mode === 'private') return 'Private';
		return 'Sealed';
	}

	function changeDMPrivacyMode(channel: Channel, mode: DMPrivacyMode): void {
		if (channel.type !== 'dm') return;
		if (mode === 'open') {
			const confirmed = window.confirm(
				'Open mode sends this DM without end-to-end encryption and stores plaintext on the server. Continue?'
			);
			if (!confirmed) return;
		}
		setDMPrivacyMode(channel.id, mode);
	}

	function selectConversation(channel: Channel) {
		showGroupSettings = false;
		if (channel.type === 'group') {
			layoutStore.openGroupDM(channel.id, channel);
		} else {
			const other = getOtherUser(channel);
			if (other) {
				layoutStore.openDM(channel.id, other);
			}
		}
	}

	function startDMWith(user: User) {
		createDM(getDmDirectoryKey(user));
		showNewDM = false;
		searchQuery = '';
	}

	function handleDeleteOrLeave(channel: Channel) {
		if (channel.type === 'group') {
			leaveGroup(channel.id);
		} else {
			deleteDM(channel.id);
		}
		if (selectedDmId === channel.id) layoutStore.closeDM();
	}

	async function startDMQuickCall(user: User, withVideo: boolean) {
		if (!$socket || !user) return;
		try {
			await startCall($socket, getUserIdentityKey(user), withVideo, { scope: 'dm', displayName: user.username });
		} catch (error) {
			console.warn(`[Call] DM quick ${withVideo ? 'video' : 'voice'} call failed to start:`, error);
		}
	}

	async function startGroupQuickCall(channel: Channel, withVideo: boolean) {
		if (!$socket || channel.type !== 'group') return;
		try {
			const myStableId = $currentUser?.dbUserId ? `user-${$currentUser.dbUserId}` : $currentUser?.id;
			const invitees = new Map<string, GroupCallRingingTarget>();
			for (const memberId of channel.members || []) {
				if (!memberId || memberId === myStableId) continue;
				if (memberId.startsWith('user-')) {
					const dbUserId = Number.parseInt(memberId.substring(5), 10);
					const onlineUser = $users.find((u) => u.dbUserId === dbUserId);
					if (onlineUser) {
						invitees.set(memberId, { stableUserId: memberId, username: onlineUser.username });
					}
					continue;
				}
				const onlineUser = $users.find((u) => u.id === memberId);
				if (onlineUser) {
					const stableUserId = typeof onlineUser.dbUserId === 'number' ? `user-${onlineUser.dbUserId}` : onlineUser.id;
					invitees.set(stableUserId, { stableUserId, username: onlineUser.username });
				}
			}

			await startGroupCall($socket, channel.id, channel.name || 'Group', withVideo, {
				localDisplayName: $currentUser?.username || 'Wabi User',
				invitees: Array.from(invitees.values())
			});
		} catch (error) {
			alert(withVideo
				? 'Failed to start group video call. Please check camera and microphone permissions.'
				: 'Failed to start group voice call. Please check microphone permissions.');
		}
	}

	function buildConversationActions(channel: Channel, other: User | null): ConversationAction[] {
		const actions: ConversationAction[] = [];

		if (channel.type === 'dm' && other) {
			actions.push(
				{
					id: 'voice',
					label: 'Voice Call',
					title: `Voice call ${other.username}`,
					icon: 'phone',
					showInline: true,
					onSelect: () => startDMQuickCall(other, false)
				},
				{
					id: 'video',
					label: 'Video Call',
					title: `Video call ${other.username}`,
					icon: 'video',
					showInline: true,
					onSelect: () => startDMQuickCall(other, true)
				}
			);
		} else if (channel.type === 'group') {
			actions.push(
				{
					id: 'voice',
					label: 'Voice Call',
					title: `Call ${channel.name || 'group'}`,
					icon: 'phone',
					showInline: true,
					onSelect: () => startGroupQuickCall(channel, false)
				},
				{
					id: 'video',
					label: 'Video Call',
					title: `Video call ${channel.name || 'group'}`,
					icon: 'video',
					showInline: true,
					onSelect: () => startGroupQuickCall(channel, true)
				}
			);
		}

		actions.push({
			id: 'remove',
			label: channel.type === 'group' ? 'Leave Group' : 'Delete Conversation',
			title: channel.type === 'group' ? 'Leave group' : 'Delete conversation',
			icon: channel.type === 'group' ? 'log-out' : 'trash-2',
			danger: true,
			showInline: true,
			onSelect: () => handleDeleteOrLeave(channel)
		});

		return actions;
	}

	function getInlineActions(channel: Channel, other: User | null): ConversationAction[] {
		return buildConversationActions(channel, other).filter((action) => action.showInline);
	}

	function isConversationPinned(channelId: string): boolean {
		return pinnedDmSet.has(channelId);
	}

	function toggleConversationPin(channelId: string): void {
		togglePinnedDm(channelId);
	}

	$: headerActions = selectedDmChannel ? getInlineActions(selectedDmChannel, dmOther) : [];
	$: headerCallActions = headerActions.filter((action) => action.id === 'voice' || action.id === 'video');
	$: headerRemoveAction = headerActions.find((action) => action.id === 'remove');
	$: activeHeaderTitle = activeGroup?.name || (isKeepNotesSelected ? 'Notes' : dmOther?.username || 'Direct Message');
	$: hasHeaderActions = headerCallActions.length > 0 || !!activeGroup || !!headerRemoveAction;
	$: if (!showCompactHeaderActions && showHeaderActionMenu) {
		showHeaderActionMenu = false;
	}
	$: if (activeHeaderElement) {
		startHeaderResizeObserver();
		updateHeaderActionLayout();
	}

	function openContextMenu(event: MouseEvent, channel: Channel, other: User | null = null) {
		event.preventDefault();
		event.stopPropagation();
		showHeaderActionMenu = false;
		contextMenuChannel = channel;
		contextMenuUser = other;
		contextMenuX = event.clientX;
		contextMenuY = event.clientY;
		showContextMenu = true;
	}

	function handleConversationLongPress(event: TouchEvent, channel: Channel, other: User | null = null) {
		const touch = event.touches?.[0] || event.changedTouches?.[0];
		if (!touch) return;
		const syntheticEvent = new MouseEvent('contextmenu', {
			clientX: touch.clientX,
			clientY: touch.clientY,
			bubbles: true
		});
		openContextMenu(syntheticEvent, channel, other);
	}

	function closeContextMenu() {
		showContextMenu = false;
		contextMenuChannel = null;
		contextMenuUser = null;
	}

	function updateHeaderActionLayout() {
		if (!activeHeaderElement) return;
		showCompactHeaderActions = activeHeaderElement.clientWidth < HEADER_INLINE_ACTION_BREAKPOINT;
	}

	function startHeaderResizeObserver() {
		if (!activeHeaderElement || typeof ResizeObserver === 'undefined') return;
		if (!headerResizeObserver) {
			headerResizeObserver = new ResizeObserver(() => updateHeaderActionLayout());
		}
		headerResizeObserver.disconnect();
		headerResizeObserver.observe(activeHeaderElement);
	}

	onDestroy(() => {
		if (headerResizeObserver) {
			headerResizeObserver.disconnect();
			headerResizeObserver = null;
		}
	});

	function openHeaderActionMenu(event: MouseEvent) {
		event.preventDefault();
		event.stopPropagation();
		closeContextMenu();
		const target = event.currentTarget as HTMLElement | null;
		if (!target) return;
		const rect = target.getBoundingClientRect();
		headerActionMenuX = rect.right;
		headerActionMenuY = rect.bottom + 6;
		showHeaderActionMenu = true;
	}

	function closeHeaderActionMenu() {
		showHeaderActionMenu = false;
	}

	function toggleGroupSettings() {
		showGroupSettings = !showGroupSettings;
	}

	$: contextMenuItems = buildContextMenuItems();
	$: headerActionMenuItems = buildHeaderActionMenuItems();

	function buildContextMenuItems(): ContextMenuItem[] {
		if (!contextMenuChannel) return [];
		const actions = buildConversationActions(contextMenuChannel, contextMenuUser);

		const items: ContextMenuItem[] = [
			{
				id: 'open',
				label: 'Open Conversation',
				icon: 'message-circle',
				onSelect: () => selectConversation(contextMenuChannel as Channel)
			},
			{
				id: 'pin-toggle',
				label: isConversationPinned(contextMenuChannel.id) ? 'Unpin Conversation' : 'Pin Conversation',
				icon: 'pin',
				onSelect: () => toggleConversationPin(contextMenuChannel.id)
			}
		];
		if (contextMenuChannel.type === 'dm') {
			const currentMode = getConversationPrivacyMode(contextMenuChannel.id);
			items.push({ id: 'privacy-divider', type: 'separator' });
			items.push({
				id: 'privacy-current',
				label: `Privacy Mode: ${getPrivacyModeLabel(currentMode)}`,
				icon: 'settings',
				disabled: true
			});
			items.push({
				id: 'privacy-sealed',
				label: 'Set Mode: Sealed',
				icon: 'settings',
				disabled: currentMode === 'sealed',
				onSelect: () => changeDMPrivacyMode(contextMenuChannel as Channel, 'sealed')
			});
			items.push({
				id: 'privacy-private',
				label: 'Set Mode: Private',
				icon: 'settings',
				disabled: currentMode === 'private',
				onSelect: () => changeDMPrivacyMode(contextMenuChannel as Channel, 'private')
			});
			items.push({
				id: 'privacy-open',
				label: 'Set Mode: Open (Public)',
				icon: 'settings',
				danger: true,
				disabled: currentMode === 'open',
				onSelect: () => changeDMPrivacyMode(contextMenuChannel as Channel, 'open')
			});
		}
		for (const action of actions) {
			if (action.danger) {
				items.push({ id: 'danger-divider', type: 'separator' });
			}
			items.push({
				id: action.id,
				label: action.label,
				icon: action.icon,
				danger: action.danger,
				onSelect: action.onSelect
			});
		}

		return items;
	}

	function buildHeaderActionMenuItems(): ContextMenuItem[] {
		if (!hasHeaderActions) return [];
		const items: ContextMenuItem[] = [];

		for (const action of headerCallActions) {
			items.push({
				id: `header-${action.id}`,
				label: action.label,
				icon: action.icon,
				onSelect: action.onSelect
			});
		}

		if (activeGroup) {
			if (items.length > 0) items.push({ id: 'header-divider-1', type: 'separator' });
			items.push({
				id: 'header-group-settings',
				label: showGroupSettings ? 'Back to Messages' : 'Group Settings',
				icon: 'settings',
				onSelect: toggleGroupSettings
			});
		}

		if (headerRemoveAction) {
			items.push({ id: 'header-danger-divider', type: 'separator' });
			items.push({
				id: 'header-remove',
				label: headerRemoveAction.label,
				icon: headerRemoveAction.icon,
				danger: true,
				onSelect: headerRemoveAction.onSelect
			});
		}

		return items;
	}
</script>


<DMTabFrame
	bind:searchQuery
	bind:showNewDM
	bind:showCreateGroup
	bind:showGroupSettings
	bind:showContextMenu
	bind:showHeaderActionMenu
	bind:activeHeaderElement
	{selectedDmId}
	{isKeepNotesSelected}
	{dmOther}
	{activeGroup}
	{selectedDmPrivacyMode}
	{selectedDmChannel}
	{showCompactHeaderActions}
	{hasHeaderActions}
	{headerCallActions}
	{headerRemoveAction}
	{activeHeaderTitle}
	{filteredUsers}
	{dmChannels}
	{contextMenuChannel}
	{contextMenuUser}
	{contextMenuX}
	{contextMenuY}
	{contextMenuItems}
	{headerActionMenuX}
	{headerActionMenuY}
	{headerActionMenuItems}
	{getDmDirectoryKey}
	{getOtherUser}
	{getInlineActions}
	{getConversationPrivacyMode}
	{isConversationPinned}
	{selectConversation}
	{handleConversationLongPress}
	{openContextMenu}
	{openHeaderActionMenu}
	{toggleGroupSettings}
	{closeContextMenu}
	{closeHeaderActionMenu}
	{startDMWith}
	{layoutStore}
	onOpenSettings={(detail) => dispatch('openSettings', detail)}
/>
