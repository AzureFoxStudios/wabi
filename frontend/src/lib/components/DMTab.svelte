<script lang="ts">
	import { createEventDispatcher, onDestroy } from 'svelte';
	import { channels, channelMessages, currentUser, users, serverMembers, createDM, deleteDM, leaveGroup, socket } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import { brandName } from '$lib/branding';
	import { NOTES_DM_ID } from '$lib/layoutStore';
	import { startCall, startGroupCall, type GroupCallRingingTarget } from '$lib/calling';
	import { longpress } from '$lib/actions/longpress';
	import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';
	import type { ContextMenuIcon, ContextMenuItem } from '$lib/context-menu/types';
	import DMMessageView from './DMMessageView.svelte';
	import KeepNotesView from './KeepNotesView.svelte';
	import GroupAvatar from './GroupAvatar.svelte';
	import GroupSettingsPanel from './GroupSettingsPanel.svelte';
	import CreateGroupModal from './CreateGroupModal.svelte';
	import type { User, Channel } from '$lib/socket';
	import { dmPrivacyModes, setDMPrivacyMode, type DMPrivacyMode } from '$lib/dmPrivacyMode';
	import { pinnedDmIdsStore, prunePinnedDms, togglePinnedDm } from '$lib/pinDms';
	import { getUserIdentityKey } from '$lib/localNicknames';
	import { buildDmDirectoryUsers, getDmDirectoryKey } from '$lib/dmUserDirectory';
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
		onlineUsers: $users,
		serverMembers: $serverMembers,
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

	function getLastPreview(channelId: string): string {
		const msgs = $channelMessages[channelId] || [];
		if (msgs.length === 0) return 'No messages';
		const last = msgs[msgs.length - 1];
		if (last.type === 'text') {
			return last.text.length > 35 ? last.text.slice(0, 35) + '...' : last.text;
		}
		return `Sent a ${last.type}`;
	}

	function formatRelativeTime(channelId: string): string {
		const msgs = $channelMessages[channelId] || [];
		if (msgs.length === 0) return '';
		const ts = msgs[msgs.length - 1].timestamp;
		const diff = Date.now() - ts;
		if (diff < 60000) return 'now';
		if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
		if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
		return `${Math.floor(diff / 86400000)}d`;
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

	function openKeepNotes() {
		showGroupSettings = false;
		layoutStore.openNotes();
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
				localDisplayName: $currentUser?.username || `${brandName} User`,
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

<div class="dm-tab">
	{#if selectedDmId && (isKeepNotesSelected || dmOther || activeGroup)}
		<!-- Active conversation -->
		<div class="dm-tab-active">
			<div class="dm-active-header" bind:this={activeHeaderElement}>
				<div class="dm-header-primary">
					<button class="dm-back-btn" on:click={() => { showGroupSettings = false; layoutStore.closeDM(); }} title="Back to all DMs" aria-label="Back to all DMs">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
					</button>
					<div class="dm-header-title-wrap">
						<span class="dm-header-title">{activeHeaderTitle}</span>
						{#if isKeepNotesSelected}
							<span class="dm-header-pill">Private</span>
						{:else if selectedDmPrivacyMode === 'open'}
							<span class="dm-header-pill dm-header-pill-open">
								<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
									<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3l-8.47-14.14a2 2 0 0 0-3.42 0z"></path>
									<line x1="12" y1="9" x2="12" y2="13"></line>
									<circle cx="12" cy="17" r="1"></circle>
								</svg>
								Open
							</span>
						{/if}
					</div>
				</div>
				{#if hasHeaderActions}
					{#if showCompactHeaderActions}
						<button class="dm-header-menu-btn" on:click={openHeaderActionMenu} title="Conversation actions" aria-label="Conversation actions">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
								<circle cx="12" cy="5" r="2"></circle>
								<circle cx="12" cy="12" r="2"></circle>
								<circle cx="12" cy="19" r="2"></circle>
							</svg>
						</button>
					{:else}
						<div class="dm-header-actions-inline">
							{#if headerCallActions.length > 0}
								<div class="dm-call-actions">
									{#each headerCallActions as action (action.id)}
										<button class="dm-call-btn" on:click={action.onSelect} title={action.title}>
											{#if action.id === 'voice'}
												<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
											{:else}
												<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>
											{/if}
											{action.id === 'voice' ? 'Call' : 'Video'}
										</button>
									{/each}
								</div>
							{/if}
							{#if activeGroup}
								<button class="dm-settings-btn" on:click={toggleGroupSettings} title="Group settings">
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/></svg>
								</button>
							{:else if headerRemoveAction}
								<button class="dm-delete-btn" on:click={headerRemoveAction.onSelect} title={headerRemoveAction.title}>
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
								</button>
							{/if}
						</div>
					{/if}
				{/if}
			</div>
			{#if showGroupSettings && activeGroup}
				<div class="dm-tab-messages">
					<GroupSettingsPanel channel={activeGroup} />
				</div>
			{:else}
				<div class="dm-tab-messages">
					{#if isKeepNotesSelected}
						<KeepNotesView />
					{:else if activeGroup}
						<DMMessageView
							channelId={selectedDmId}
							otherUser={activeGroup.memberUsers?.[0] || { id: '', username: activeGroup.name, color: '#888', status: 'offline' }}
							channel={activeGroup}
							on:openSettings={(event) => dispatch('openSettings', event.detail)}
						/>
					{:else if dmOther}
						<DMMessageView
							channelId={selectedDmId}
							otherUser={dmOther}
							channel={selectedDmChannel || undefined}
							on:openSettings={(event) => dispatch('openSettings', event.detail)}
						/>
					{/if}
				</div>
			{/if}
		</div>
	{:else}
		<!-- DM list view -->
		<div class="dm-tab-list">
			<div class="dm-tab-header">
				<span class="dm-tab-title">Messages</span>
				<div class="dm-header-actions">
					<button class="dm-new-btn dm-new-group-btn" on:click={() => { showCreateGroup = true; }} title="Create group">
						<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.98 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" fill="currentColor"/></svg>
					</button>
					<button class="dm-new-btn dm-new-dm-btn" on:click={() => { showNewDM = !showNewDM; }} title="Create DM">
						<span class="plus-glyph" aria-hidden="true">+</span>
					</button>
				</div>
			</div>

			{#if showNewDM}
				<div class="dm-new-panel">
					<input
						type="text"
						class="dm-search"
						placeholder="Search users..."
						bind:value={searchQuery}
					/>
					<div class="dm-new-list">
						{#each filteredUsers as user (getDmDirectoryKey(user))}
							<button class="dm-new-user" on:click={() => startDMWith(user)}>
								{#if user.profilePicture}
									<img src={user.profilePicture} alt={user.username} class="dm-new-avatar" />
								{:else}
									<div class="dm-new-avatar-ph" style="background-color: {user.roleColor || user.color}">
										{user.username.charAt(0).toUpperCase()}
									</div>
								{/if}
								<div class="dm-new-info">
									<span class="dm-new-name">{user.username}</span>
									{#if user.handle}<span class="dm-new-handle">@{user.handle}</span>{/if}
								</div>
							</button>
						{:else}
							<div class="dm-empty-search">No users found</div>
						{/each}
					</div>
				</div>
			{/if}

			<div class="dm-conversations">
				{#each dmChannels as channel (channel.id)}
					{#if channel.type === 'group'}
						<div
							class="dm-conv-item"
							class:selected={selectedDmId === channel.id}
							class:dm-conv-item-pinned={isConversationPinned(channel.id)}
							role="button"
							tabindex="0"
							on:click={() => selectConversation(channel)}
							on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectConversation(channel); } }}
							on:contextmenu={(e) => openContextMenu(e, channel)}
							use:longpress={{ onLongPress: (e) => handleConversationLongPress(e, channel) }}
						>
							<div class="dm-conv-avatar-wrap">
								<GroupAvatar {channel} size={36} />
							</div>
								<div class="dm-conv-info">
									<div class="dm-conv-top">
										<span class="dm-conv-name">{channel.name}</span>
									{#if isConversationPinned(channel.id)}
										<span class="dm-conv-pin" title="Pinned conversation">Pinned</span>
									{/if}
										<span class="dm-conv-time">{formatRelativeTime(channel.id)}</span>
									</div>
									<span class="dm-conv-preview dm-group-conv-preview">
										<svg class="dm-group-row-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
										{channel.members?.length || 0} members - {getLastPreview(channel.id)}
									</span>
								</div>
							<div class="dm-conv-actions">
								{#each getInlineActions(channel, null) as action (action.id)}
									<button
										class:dm-conv-action-btn={action.id !== 'remove'}
										class:dm-conv-close-btn={action.id === 'remove'}
										on:click|stopPropagation={action.onSelect}
										title={action.title}
									>
										<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
											{#if action.id === 'voice'}
												<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
											{:else if action.id === 'video'}
												<path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
											{:else}
												<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>
											{/if}
										</svg>
									</button>
								{/each}
							</div>
						</div>
					{:else}
						{@const other = getOtherUser(channel)}
						{#if other}
							<div
								class="dm-conv-item"
								class:selected={selectedDmId === channel.id}
								class:dm-conv-item-pinned={isConversationPinned(channel.id)}
								role="button"
								tabindex="0"
								on:click={() => selectConversation(channel)}
								on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectConversation(channel); } }}
								on:contextmenu={(e) => openContextMenu(e, channel, other)}
								use:longpress={{ onLongPress: (e) => handleConversationLongPress(e, channel, other) }}
							>
								<div class="dm-conv-avatar-wrap">
									{#if other.profilePicture}
										<img src={other.profilePicture} alt={other.username} class="dm-conv-avatar" />
									{:else}
										<div class="dm-conv-avatar-ph" style="background-color: {other.roleColor || other.color}">
											{other.username.charAt(0).toUpperCase()}
										</div>
									{/if}
									{#if getConversationPrivacyMode(channel.id) === 'open'}
										<span class="dm-open-mode-badge" title="Open mode: plaintext DM">
											<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
												<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3l-8.47-14.14a2 2 0 0 0-3.42 0z"></path>
												<line x1="12" y1="9" x2="12" y2="13"></line>
												<circle cx="12" cy="17" r="1"></circle>
											</svg>
										</span>
									{:else if other.status && other.status !== 'offline'}
										<span class="dm-conv-status-dot" class:active={other.status === 'active'} class:away={other.status === 'away'} class:busy={other.status === 'busy'} title={other.status}></span>
									{/if}
								</div>
								<div class="dm-conv-info">
									<div class="dm-conv-top">
										<span class="dm-conv-name">{other.username}</span>
										{#if isConversationPinned(channel.id)}
											<span class="dm-conv-pin" title="Pinned conversation">Pinned</span>
										{/if}
										<span class="dm-conv-time">{formatRelativeTime(channel.id)}</span>
									</div>
									<span class="dm-conv-preview">{getLastPreview(channel.id)}</span>
								</div>
								<div class="dm-conv-actions">
									{#each getInlineActions(channel, other) as action (action.id)}
										<button
											class:dm-conv-action-btn={action.id !== 'remove'}
											class:dm-conv-close-btn={action.id === 'remove'}
											on:click|stopPropagation={action.onSelect}
											title={action.title}
										>
											<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
												{#if action.id === 'voice'}
													<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
												{:else if action.id === 'video'}
													<path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
												{:else}
													<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>
												{/if}
											</svg>
										</button>
									{/each}
								</div>
							</div>
						{/if}
					{/if}
				{:else}
					<div class="dm-empty-state">
						<p>No conversations yet</p>
						<button class="dm-start-btn" on:click={() => { showNewDM = true; }}>
							Start a conversation
						</button>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<ContextMenu
		open={showContextMenu && !!contextMenuChannel}
		x={contextMenuX}
		y={contextMenuY}
		items={contextMenuItems}
		ariaLabel="DM conversation actions"
		headerLabel={contextMenuChannel?.type === 'group' ? contextMenuChannel?.name || null : contextMenuUser?.username || null}
		on:close={closeContextMenu}
	/>

	<ContextMenu
		open={showHeaderActionMenu && !!selectedDmId && hasHeaderActions}
		x={headerActionMenuX}
		y={headerActionMenuY}
		items={headerActionMenuItems}
		ariaLabel="DM header actions"
		headerLabel={activeHeaderTitle}
		on:close={closeHeaderActionMenu}
	/>
</div>

<CreateGroupModal bind:isOpen={showCreateGroup} />

<style>
	.dm-tab {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	/* Active DM view */
	.dm-tab-active {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	.dm-active-header {
		display: flex;
		align-items: center;
		gap: var(--space-2, 8px);
		padding: var(--space-1, 4px) var(--space-2, 8px);
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}

	.dm-header-primary {
		display: flex;
		align-items: center;
		gap: var(--space-2, 8px);
		min-width: 0;
		flex: 1;
	}

	.dm-header-title-wrap {
		display: flex;
		align-items: center;
		justify-content: flex-start;
		gap: var(--space-2, 8px);
		min-width: 0;
		flex: 1;
		text-align: left;
	}

	.dm-header-title {
		display: block;
		text-align: left;
		font-size: var(--font-size-base, 14px);
		font-weight: 600;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.dm-header-actions-inline {
		display: flex;
		align-items: center;
		gap: var(--space-2, 8px);
		margin-left: auto;
	}

	.dm-header-menu-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		margin-left: auto;
		background: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-md, 8px);
		color: var(--text-secondary);
		cursor: pointer;
	}

	.dm-header-menu-btn:hover {
		color: var(--text-primary);
		background: var(--bg-hover);
	}

	.dm-call-actions {
		display: flex;
		align-items: center;
		gap: var(--space-2, 8px);
	}

	.dm-call-btn {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2, 8px);
		height: 28px;
		padding: 0 0.55rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md, 8px);
		background: var(--bg-secondary);
		color: var(--text-secondary);
		font-size: var(--font-size-xs, 11px);
		font-weight: 600;
		cursor: pointer;
		transition: background var(--duration-fast, 150ms) ease, color var(--duration-fast, 150ms) ease, border-color var(--duration-fast, 150ms) ease;
	}

	.dm-call-btn svg {
		width: 13px;
		height: 13px;
		flex-shrink: 0;
	}

	.dm-call-btn:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
		border-color: var(--accent-primary-color, #6366f1);
	}

	.dm-back-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		background: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-md, 8px);
		color: var(--text-secondary);
		cursor: pointer;
	}

	.dm-back-btn:hover {
		color: var(--text-primary);
		background: var(--bg-hover);
	}

	.dm-delete-btn,
	.dm-settings-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		background: none;
		border: 1px solid var(--border);
		color: var(--text-secondary);
		cursor: pointer;
		border-radius: var(--radius-md, 8px);
	}

	.dm-delete-btn:hover {
		color: var(--color-danger, #ef4444);
		background: var(--color-danger-bg, rgba(var(--color-danger-rgb, 239, 68, 68), 0.15));
	}

	.dm-settings-btn:hover {
		color: var(--text-primary);
		background: var(--bg-hover);
	}

	.dm-header-pill {
		padding: var(--space-1, 4px) var(--space-2, 8px);
		border: 1px solid var(--border);
		border-radius: var(--radius-full, 9999px);
		font-size: var(--font-size-xs, 11px);
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--text-secondary);
		white-space: nowrap;
	}

	.dm-header-pill-open {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1, 4px);
		color: var(--color-danger, #ef4444);
		border-color: color-mix(in srgb, var(--color-danger) 45%, transparent);
		background: var(--color-danger-bg, rgba(var(--color-danger-rgb, 239, 68, 68), 0.15));
	}

	.dm-tab-messages {
		flex: 1;
		min-height: 0;
	}

	/* DM list view */
	.dm-tab-list {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	.dm-tab-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-3, 12px) var(--space-3, 12px) var(--space-2, 8px);
		border-bottom: 1px solid color-mix(in srgb, var(--border) 74%, transparent);
		flex-shrink: 0;
	}

	.dm-tab-title {
		font-size: var(--font-size-sm, 13px);
		font-weight: 600;
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.dm-header-actions {
		display: flex;
		gap: var(--space-2, 8px);
		align-items: center;
	}

	.dm-new-btn {
		width: 26px;
		height: 26px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: none;
		border: none;
		border-radius: var(--radius-md, 8px);
		color: var(--text-secondary);
		cursor: pointer;
		opacity: var(--opacity-70, 0.7);
	}

	.dm-new-btn svg {
		display: block;
		width: 16px;
		height: 16px;
	}

	.dm-new-btn .plus-glyph {
		font-size: var(--font-size-xl, 20px);
		font-weight: 700;
		line-height: 0.95;
		transform: translateY(-0.5px);
	}

	.dm-new-btn:hover {
		color: var(--text-primary);
		background: none;
		opacity: 1;
	}

	/* New DM panel */
	.dm-new-panel {
		padding: var(--space-2, 8px) var(--space-2, 8px) var(--space-2, 8px);
		border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
		flex-shrink: 0;
	}

	.dm-search {
		width: 100%;
		padding: var(--space-2, 8px) var(--space-3, 12px);
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--text-primary);
		border-radius: var(--radius-md, 8px);
		font-size: var(--font-size-base, 14px);
		margin-bottom: var(--space-2, 8px);
	}

	.dm-search::placeholder { color: var(--text-secondary); }

	.dm-new-list {
		max-height: 180px;
		overflow-y: auto;
	}

	.dm-new-user {
		display: flex;
		align-items: center;
		gap: var(--space-2, 8px);
		width: 100%;
		padding: var(--space-2, 8px) var(--space-2, 8px);
		background: none;
		border: none;
		color: var(--text-primary);
		cursor: pointer;
		border-radius: var(--radius-sm, 4px);
		text-align: left;
	}

	.dm-new-user:hover { background: var(--bg-hover); }

	.dm-new-avatar,
	.dm-new-avatar-ph {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		flex-shrink: 0;
		object-fit: cover;
	}

	.dm-new-avatar-ph {
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: var(--font-size-sm, 13px);
		font-weight: 600;
		color: white;
	}

	.dm-new-info {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.dm-new-name {
		font-size: var(--font-size-base, 14px);
		font-weight: 500;
	}

	.dm-new-handle {
		font-size: var(--font-size-xs, 11px);
		color: var(--text-secondary);
	}

	.dm-empty-search {
		padding: var(--space-3, 12px);
		text-align: center;
		color: var(--text-secondary);
		font-size: var(--font-size-sm, 13px);
	}

	/* Conversation list */
	.dm-conversations {
		flex: 1;
		overflow-y: auto;
		padding: var(--space-1, 4px) var(--space-1, 4px) var(--space-2, 8px);
	}

	.dm-conv-item {
		display: flex;
		align-items: center;
		gap: var(--space-2, 8px);
		width: 100%;
		padding: var(--space-2, 8px) var(--space-2, 8px);
		background: transparent;
		border: 1px solid transparent;
		color: var(--text-primary);
		cursor: pointer;
		border-radius: var(--radius-lg, 12px);
		text-align: left;
		position: relative;
		transition: background var(--duration-fast, 150ms) ease, border-color var(--duration-fast, 150ms) ease;
	}

	.dm-conv-item:hover {
		background: color-mix(in srgb, var(--accent-primary-color, #6366f1) 8%, transparent);
		border-color: color-mix(in srgb, var(--accent-primary-color, #6366f1) 20%, transparent);
	}

	.dm-conv-item.selected {
		background: color-mix(in srgb, var(--accent-primary-color, #6366f1) 12%, transparent);
		border-color: color-mix(in srgb, var(--accent-primary-color, #6366f1) 30%, transparent);
	}

	.dm-conv-item-pinned {
		background: color-mix(in srgb, var(--accent-primary-color, #6366f1) 10%, transparent);
		border-color: color-mix(in srgb, var(--accent-primary-color, #6366f1) 24%, transparent);
	}

	.dm-conv-item-pinned:hover {
		background: color-mix(in srgb, var(--accent-primary-color, #6366f1) 14%, transparent);
	}

	.dm-conv-close-btn {
		width: 22px;
		height: 22px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		border-radius: var(--radius-sm, 4px);
		transition: color var(--duration-fast, 150ms), background var(--duration-fast, 150ms);
	}

	.dm-conv-actions {
		display: flex;
		align-items: center;
		gap: var(--space-1, 4px);
		opacity: 0;
		pointer-events: none;
		transition: opacity var(--duration-fast, 150ms) ease;
		margin-left: var(--space-1, 4px);
	}

	.dm-conv-action-btn {
		width: 22px;
		height: 22px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		border-radius: var(--radius-sm, 4px);
		transition: color var(--duration-fast, 150ms), background var(--duration-fast, 150ms);
	}

	.dm-conv-action-btn:hover {
		color: var(--text-primary);
		background: var(--bg-hover);
	}

	.dm-conv-item:hover .dm-conv-actions,
	.dm-conv-item:focus-within .dm-conv-actions {
		opacity: 1;
		pointer-events: auto;
	}

	.dm-conv-close-btn:hover {
		color: var(--color-danger, #ef4444);
		background: var(--color-danger-bg, rgba(var(--color-danger-rgb, 239, 68, 68), 0.15));
	}

	.dm-conv-avatar-wrap {
		flex-shrink: 0;
		width: 36px;
		height: 36px;
		position: relative;
	}

	.dm-conv-avatar,
	.dm-conv-avatar-ph {
		width: 36px;
		height: 36px;
		border-radius: 50%;
		object-fit: cover;
	}

	.dm-conv-avatar-ph {
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: var(--font-size-sm, 13px);
		font-weight: 600;
		color: white;
	}

	.dm-open-mode-badge {
		position: absolute;
		right: -2px;
		bottom: -2px;
		width: 15px;
		height: 15px;
		border-radius: 50%;
		background: var(--color-danger, #ef4444);
		color: #fff;
		border: 1px solid var(--surface-sunken, #0f0c29);
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: var(--shadow-sm, 0 1px 2px 0 rgba(0, 0, 0, 0.05));
	}

	.dm-conv-status-dot {
		position: absolute;
		right: -1px;
		bottom: -1px;
		width: 11px;
		height: 11px;
		border-radius: 50%;
		border: 2px solid var(--bg-primary);
		background: var(--status-offline, #666);
	}

	.dm-conv-status-dot.active { background: var(--status-online, #44b700); }
	.dm-conv-status-dot.away { background: var(--status-away, #ffa500); }
	.dm-conv-status-dot.busy { background: var(--status-busy, #f44336); }

	.dm-conv-info {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
		gap: var(--space-1, 4px);
	}

	.dm-conv-top {
		display: flex;
		align-items: baseline;
		justify-content: flex-start;
		gap: var(--space-1, 4px);
	}

	.dm-conv-pin {
		font-size: var(--font-size-xs, 11px);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--accent-primary-color, #6366f1);
	}

	.dm-conv-name {
		font-size: var(--font-size-base, 14px);
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.dm-conv-time {
		font-size: var(--font-size-xs, 11px);
		color: var(--text-secondary);
		flex-shrink: 0;
		margin-left: auto;
	}

	.dm-conv-preview {
		font-size: var(--font-size-sm, 13px);
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.dm-group-conv-preview {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1, 4px);
	}

	.dm-group-row-icon {
		flex-shrink: 0;
		opacity: var(--opacity-80, 0.8);
	}


	/* Empty state */
	.dm-empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-3, 12px);
		padding: var(--space-8, 32px) var(--space-4, 16px);
		color: var(--text-secondary);
		font-size: var(--font-size-base, 14px);
	}

	.dm-start-btn {
		padding: var(--space-2, 8px) var(--space-4, 16px);
		background: var(--accent);
		color: white;
		border: none;
		border-radius: var(--radius-md, 8px);
		cursor: pointer;
		font-size: var(--font-size-sm, 13px);
		font-weight: 500;
	}

	.dm-start-btn:hover { opacity: var(--opacity-90, 0.9); }

	@media (max-width: 768px) {
		.dm-conv-item {
			padding: var(--space-3, 12px) var(--space-2, 8px);
			min-height: 52px;
		}

		.dm-conv-actions {
		opacity: var(--opacity-100, 1);
			pointer-events: auto;
		}

		.dm-conv-avatar-wrap {
			width: 40px;
			height: 40px;
		}

		.dm-conv-avatar,
		.dm-conv-avatar-ph {
			width: 40px;
			height: 40px;
		}

		.dm-conv-name { 		font-size: var(--font-size-lg, 16px); }
		.dm-conv-preview { font-size: var(--font-size-base, 14px); }

		.dm-new-user {
			padding: var(--space-3, 12px) var(--space-2, 8px);
			min-height: 44px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.dm-conv-item, .dm-conv-close-btn, .dm-conv-action-btn, .dm-conv-actions,
		.dm-call-btn, .dm-new-btn { transition: none; }
	}
</style>
