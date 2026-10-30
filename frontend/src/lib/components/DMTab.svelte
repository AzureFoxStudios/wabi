<script lang="ts">
	import { openGames } from '$lib/games/navigation';
	import { createEventDispatcher } from 'svelte';
	import { channels, channelMessages, channelUnreadCounts, currentUser, users, serverMembers, connected, createDM, deleteDM, leaveGroup, socket, joinChannel } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import { brandName } from '$lib/branding';
	import { showToast } from '$lib/toast';
	import { confirmAction } from '$lib/confirm';
	import { NOTES_DM_ID } from '$lib/layoutStore';
	import { startCall, startGroupCall, type GroupCallRingingTarget } from '$lib/calling';
	import { longpress } from '$lib/actions/longpress';
	import ContextMenu, { type MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
	import type { ContextMenuIcon } from '$lib/context-menu/types';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import type { IconName } from '$lib/components/ui/icons';
	import DMMessageView from './DMMessageView.svelte';
	import KeepNotesView from './KeepNotesView.svelte';
	import GroupAvatar from './GroupAvatar.svelte';
	import GroupSettingsPanel from './GroupSettingsPanel.svelte';
	import CreateGroupModal from './CreateGroupModal.svelte';
	import type { User, Channel, Message } from '$lib/socket';
	import { pinnedDmIdsStore, prunePinnedDms, togglePinnedDm } from '$lib/pinDms';
	import { getUserIdentityKey } from '$lib/localNicknames';
	import { buildDmDirectoryUsers, getDmDirectoryKey } from '$lib/dmUserDirectory';
	import { buildDmPlaceholderChannel, findExistingDmChannel, getDmStableUserId, resolveDmOtherUser } from '$lib/dmConversations';
	import { mediaUrl } from '$lib/mediaUrl';
	import { inkFor } from '$lib/theme/identity';
	import ProfileName from './ProfileName.svelte';
	import ProfileMedia from './ProfileMedia.svelte';
	import { livePresenceForUser } from '$lib/dmPresentation';
	type ConversationAction = {
		id: 'voice' | 'video' | 'remove';
		label: string;
		title: string;
		icon: ContextMenuIcon;
		glyph: IconName;
		danger?: boolean;
		showInline?: boolean;
		onSelect: () => void | Promise<void>;
	};
	type ConversationFilter = 'all' | 'unread' | 'groups';
	type ConversationRow = {
		id: string;
		channel: Channel;
		other: User | null;
		isGroup: boolean;
		name: string;
		initial: string;
		color: string;
		ink: string;
		presence: 'active' | 'away' | 'busy' | 'offline' | 'unavailable';
		preview: string;
		time: string;
		unread: number;
		pinned: boolean;
		selected: boolean;
		actions: ConversationAction[];
		ariaLabel: string;
	};

	const FILTER_LABELS: Record<ConversationFilter, string> = { all: 'All', unread: 'Unread', groups: 'Groups' };

	const dispatch = createEventDispatcher<{
		openSettings: { paymentSurface: 'connections' };
	}>();

	let searchQuery = '';
	let conversationQuery = '';
	let conversationFilter: ConversationFilter = 'all';
	let showNewDM = false;
	let creatingDmKey: string | null = null;
	let createDmError = '';
	let showCreateGroup = false;
	let showGroupSettings = false;
	let showContextMenu = false;
	let contextMenuX = 0;
	let contextMenuY = 0;
	let contextMenuChannel: Channel | null = null;
	let contextMenuUser: User | null = null;

	$: selectedDmId = $layoutStore.selectedDmChannelId;
	$: selectedGroup = $layoutStore.selectedGroupChannel;
	$: isKeepNotesSelected = selectedDmId === NOTES_DM_ID;
	$: selectedDmChannel = selectedDmId ? $channels.find(ch => ch.id === selectedDmId) || null : null;
	$: dmOther = selectedDmChannel?.type === 'dm'
		? resolveDmOtherUser(selectedDmChannel, $currentUser, $users, $serverMembers)
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

	// Rows are built here, not in the template: every store they read is named in this statement,
	// so Svelte re-derives them when messages, unread counts, presence or the theme change.
	$: conversationRows = buildConversationRows(
		dmChannels,
		$channelMessages,
		$channelUnreadCounts,
		$users,
		$serverMembers,
		$currentUser,
		$connected,
		$inkFor,
		pinnedDmSet,
		selectedDmId,
		conversationQuery,
		conversationFilter
	);
	$: filterApplied = conversationFilter !== 'all';
	$: listFiltered = filterApplied || conversationQuery.trim() !== '';

	function getOtherUser(channel: Channel): User | null {
		return resolveDmOtherUser(channel, $currentUser, $users, $serverMembers);
	}

	function initialOf(name: string): string {
		const first = Array.from(name.trim())[0];
		return first ? first.toLocaleUpperCase() : '?';
	}

	function lastPreview(messages: Record<string, Message[]>, channelId: string, self: User | null): string {
		const msgs = messages[channelId] || [];
		if (msgs.length === 0) return 'No messages yet';
		const last = msgs[msgs.length - 1];
		const mine = Boolean(self && (last.userId === self.id || last.user === self.username));
		const body = last.type === 'text' || !last.type ? (last.text || '').replace(/\s+/g, ' ').trim() : `Sent a ${last.type}`;
		return mine ? `You: ${body}` : body;
	}

	function relativeTime(messages: Record<string, Message[]>, channelId: string): string {
		const msgs = messages[channelId] || [];
		if (msgs.length === 0) return '';
		const ts = msgs[msgs.length - 1].timestamp ?? 0;
		if (!ts) return '';
		const diff = Date.now() - ts;
		if (diff < 60000) return 'now';
		if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
		if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
		return `${Math.floor(diff / 86400000)}d`;
	}

	function buildConversationRows(
		list: Channel[],
		messages: Record<string, Message[]>,
		unreadCounts: Record<string, number>,
		liveUsers: User[],
		members: User[],
		self: User | null,
		isConnected: boolean,
		ink: (color: string | null | undefined) => string,
		pinned: Set<string>,
		selectedId: string | null,
		query: string,
		filter: ConversationFilter
	): ConversationRow[] {
		const needle = query.trim().toLowerCase();
		const rows: ConversationRow[] = [];
		for (const channel of list) {
			const isGroup = channel.type === 'group';
			const other = isGroup ? null : resolveDmOtherUser(channel, self, liveUsers, members);
			if (!isGroup && !other) continue;
			const unread = unreadCounts[channel.id] || 0;
			if (filter === 'groups' && !isGroup) continue;
			if (filter === 'unread' && unread === 0) continue;
			const name = isGroup ? channel.name || 'Group' : other!.username;
			if (needle) {
				const haystack = [name, other?.handle || '', ...(isGroup ? (channel.memberUsers || []).map((member) => member.username) : [])].join(' ').toLowerCase();
				if (!haystack.includes(needle)) continue;
			}
			const color = isGroup ? '' : other!.roleColor || other!.color || '';
			const presence = isGroup ? 'unavailable' : livePresenceForUser(other, liveUsers, isConnected);
			const preview = lastPreview(messages, channel.id, self);
			const isPinned = pinned.has(channel.id);
			const time = relativeTime(messages, channel.id);
			const memberCount = channel.members?.length || 0;
			rows.push({
				id: channel.id,
				channel,
				other,
				isGroup,
				name,
				initial: initialOf(name),
				color,
				ink: ink(color),
				presence,
				preview: isGroup && memberCount ? `${memberCount} members · ${preview}` : preview,
				time,
				unread,
				pinned: isPinned,
				selected: selectedId === channel.id,
				actions: getInlineActions(channel, other),
				ariaLabel: [
					isGroup ? `${name}, group` : name,
					unread ? `${unread} unread` : null,
					isPinned ? 'pinned' : null,
					preview
				].filter(Boolean).join(', ')
			});
		}
		return rows;
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
		joinChannel(channel.id);
	}

	function upsertLocalDmPlaceholder(channel: Channel): Channel {
		channels.update((allChannels) => {
			const existing = allChannels.find((candidate) => candidate.id === channel.id);
			if (existing) return allChannels.map((candidate) => (candidate.id === channel.id ? { ...candidate, ...channel } : candidate));
			return [...allChannels, channel];
		});
		return channel;
	}

	function isSelfUser(user: User): boolean {
		const selfStableId = getDmStableUserId($currentUser);
		const targetStableId = getDmStableUserId(user);
		return Boolean(selfStableId && targetStableId && selfStableId === targetStableId);
	}

	async function startDMWith(user: User) {
		createDmError = '';
		if (isSelfUser(user)) return;
		const targetKey = getDmDirectoryKey(user);
		const existing = findExistingDmChannel($channels || [], user);
		showNewDM = false;
		searchQuery = '';
		if (existing) {
			selectConversation(existing);
			return;
		}

		creatingDmKey = targetKey;
		const result = await createDM(targetKey);
		if (creatingDmKey !== targetKey) return;
		creatingDmKey = null;

		const created =
			(result.ok ? result.channel : undefined) ||
			(result.channelId ? ($channels || []).find((channel) => channel.id === result.channelId) : null) ||
			findExistingDmChannel($channels || [], user) ||
			(result.channelId ? upsertLocalDmPlaceholder(buildDmPlaceholderChannel(result.channelId, user, $currentUser)) : null);

		if (created) {
			selectConversation(created);
			return;
		}

		createDmError = result.ok
			? 'The conversation was created, but the server did not send it back yet. Try opening it again in a moment.'
			: (result as { ok: false; error: string }).error;
		showNewDM = true;
	}

	async function handleDeleteOrLeave(channel: Channel) {
		if (channel.type === 'group') {
			const leave = await confirmAction({
				title: 'Leave this group?',
				body: `You stop receiving messages from ${channel.name || 'this group'}. Someone in it can add you again.`,
				confirm: 'Leave group',
				danger: true
			});
			if (!leave) return;
			try { await leaveGroup(channel.id); }
			catch (error) {
				console.error('[DMs] leaving the group failed', error);
				showToast('Could not leave the group. You are still a member.', 'error');
			}
			// group-removed owns the targeted surface cleanup, never this click.
			return;
		}
		const remove = await confirmAction({
			title: 'Delete this conversation?',
			body: 'It is deleted for both of you, with its shared notes. This cannot be undone.',
			confirm: 'Delete conversation',
			danger: true
		});
		if (!remove) return;
		deleteDM(channel.id);
		if (selectedDmId === channel.id) layoutStore.closeRightDm();
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
					const member = [...$users, ...$serverMembers].find((u) => u.dbUserId === dbUserId);
					invitees.set(memberId, { stableUserId: memberId, username: member?.username || 'Member' });
					continue;
				}
				const member = [...$users, ...$serverMembers].find((u) => u.id === memberId);
				if (member) {
					const stableUserId = typeof member.dbUserId === 'number' ? `user-${member.dbUserId}` : member.id;
					invitees.set(stableUserId, { stableUserId, username: member.username });
				}
			}

			await startGroupCall($socket, channel.id, channel.name || 'Group', withVideo, {
				localDisplayName: $currentUser?.username || `${brandName} User`,
				invitees: Array.from(invitees.values())
			});
		} catch (error) {
			console.warn(`[Call] group ${withVideo ? 'video' : 'voice'} call failed to start:`, error);
			showToast(withVideo
				? 'Could not start the video call. Check camera and microphone permissions.'
				: 'Could not start the call. Check microphone permissions.', 'error');
		}
	}

	function buildConversationActions(channel: Channel, other: User | null): ConversationAction[] {
		const actions: ConversationAction[] = [];

		if (channel.type === 'dm' && other) {
			actions.push(
				{
					id: 'voice',
					label: 'Voice call',
					title: `Call ${other.username}`,
					icon: 'phone',
					glyph: 'phone',
					showInline: true,
					onSelect: () => startDMQuickCall(other, false)
				},
				{
					id: 'video',
					label: 'Video call',
					title: `Video call ${other.username}`,
					icon: 'video',
					glyph: 'video',
					showInline: true,
					onSelect: () => startDMQuickCall(other, true)
				}
			);
		} else if (channel.type === 'group') {
			actions.push(
				{
					id: 'voice',
					label: 'Voice call',
					title: `Call ${channel.name || 'group'}`,
					icon: 'phone',
					glyph: 'phone',
					showInline: true,
					onSelect: () => startGroupQuickCall(channel, false)
				},
				{
					id: 'video',
					label: 'Video call',
					title: `Video call ${channel.name || 'group'}`,
					icon: 'video',
					glyph: 'video',
					showInline: true,
					onSelect: () => startGroupQuickCall(channel, true)
				}
			);
		}

		actions.push({
			id: 'remove',
			label: channel.type === 'group' ? 'Leave group' : 'Delete conversation',
			title: channel.type === 'group' ? `Leave ${channel.name || 'group'}` : `Delete conversation with ${other?.username || 'this person'}`,
			icon: channel.type === 'group' ? 'log-out' : 'trash-2',
			glyph: channel.type === 'group' ? 'logout' : 'trash',
			danger: true,
			showInline: true,
			onSelect: () => handleDeleteOrLeave(channel)
		});

		return actions;
	}

	function getInlineActions(channel: Channel, other: User | null): ConversationAction[] {
		return buildConversationActions(channel, other).filter((action) => action.showInline);
	}

	function toggleConversationPin(channelId: string): void {
		togglePinnedDm(channelId);
	}

	$: headerActions = selectedDmChannel ? getInlineActions(selectedDmChannel, dmOther) : [];
	$: headerCallActions = headerActions.filter((action) => action.id === 'voice' || action.id === 'video');
	$: headerRemoveAction = headerActions.find((action) => action.id === 'remove');
	$: activeHeaderTitle = activeGroup?.name || (isKeepNotesSelected ? 'Notes' : dmOther?.username || 'Direct message');

	function openContextMenu(event: MouseEvent, channel: Channel, other: User | null = null) {
		event.preventDefault();
		event.stopPropagation();
		contextMenuChannel = channel;
		contextMenuUser = other;
		contextMenuX = event.clientX;
		contextMenuY = event.clientY;
		showContextMenu = true;
	}

	function openRowMenu(event: MouseEvent, channel: Channel, other: User | null = null) {
		event.stopPropagation();
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		contextMenuChannel = channel;
		contextMenuUser = other;
		contextMenuX = rect.right;
		contextMenuY = rect.bottom;
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

	function toggleGroupSettings() {
		showGroupSettings = !showGroupSettings;
	}

	function backToList() {
		showGroupSettings = false;
		layoutStore.closeRightDm();
	}

	$: contextMenuItems = buildContextMenuItems(contextMenuChannel, contextMenuUser, pinnedDmSet);
	$: headerActionMenuItems = buildHeaderActionMenuItems({ headerRemoveAction, activeGroup, selectedDmId, isKeepNotesSelected, showGroupSettings });
	$: filterMenuItems = [
		{ id: 'k-show', type: 'kicker', label: 'Show' },
		...(['all', 'unread', 'groups'] as const).map((value) => ({
			id: `filter:${value}`,
			label: FILTER_LABELS[value],
			role: 'menuitemradio' as const,
			checked: conversationFilter === value
		}))
	] satisfies MenuEntry[];
	const newConversationItems: MenuEntry[] = [
		{ id: 'new-dm', label: 'New message', icon: 'chat', onSelect: () => { createDmError = ''; showNewDM = true; } },
		{ id: 'new-group', label: 'New group', icon: 'users', onSelect: () => { showCreateGroup = true; } }
	];

	function handleFilterSelect(id: string): void {
		const value = id.slice('filter:'.length);
		if (value === 'all' || value === 'unread' || value === 'groups') conversationFilter = value;
	}

	function clearListFilters(): void {
		conversationQuery = '';
		conversationFilter = 'all';
	}

	function buildContextMenuItems(contextMenuChannel: Channel | null, contextMenuUser: User | null, pinned: Set<string>): MenuEntry[] {
		if (!contextMenuChannel) return [];
		const channel = contextMenuChannel;
		const actions = buildConversationActions(channel, contextMenuUser);

		const items: MenuEntry[] = [
			{
				id: 'open',
				label: 'Open conversation',
				icon: 'chat',
				onSelect: () => selectConversation(channel)
			},
			{
				id: 'pin-toggle',
				label: pinned.has(channel.id) ? 'Unpin conversation' : 'Pin conversation',
				icon: 'pin',
				onSelect: () => toggleConversationPin(channel.id)
			}
		];
		for (const action of actions) {
			items.push({
				id: action.id,
				label: action.label,
				icon: action.glyph,
				danger: action.danger,
				onSelect: action.onSelect
			});
		}

		return items;
	}

	function buildHeaderActionMenuItems({ headerRemoveAction, activeGroup, selectedDmId, isKeepNotesSelected, showGroupSettings }: {
		headerRemoveAction: ConversationAction | undefined; activeGroup: Channel | null;
		selectedDmId: string | null; isKeepNotesSelected: boolean; showGroupSettings: boolean;
	}): MenuEntry[] {
		const items: MenuEntry[] = [];
		if (selectedDmId && !isKeepNotesSelected) items.push({
			id: 'header-find-game', label: 'What can we play?', icon: 'gamepad',
			onSelect: () => openGames({ channelId: selectedDmId, tab: 'match' })
		});
		if (activeGroup) {
			items.push({
				id: 'header-group-settings',
				label: showGroupSettings ? 'Back to messages' : 'Group settings',
				icon: 'gear',
				onSelect: toggleGroupSettings
			});
		}
		if (headerRemoveAction) {
			items.push({
				id: 'header-remove',
				label: headerRemoveAction.label,
				icon: headerRemoveAction.glyph,
				danger: true,
				onSelect: headerRemoveAction.onSelect
			});
		}
		return items;
	}
</script>

<div class="dm-tab">
	{#if selectedDmId && (isKeepNotesSelected || dmOther || activeGroup)}
		<!-- Active conversation: its row B (40px) names it and holds its actions. -->
		<div class="dm-tab-active">
			<div class="dm-rowb dm-active-head">
				<button type="button" class="w-ibtn w-ibtn--sm" on:click={backToList} title="All DMs" aria-label="Back to all DMs">
					<Icon name="chevLeft" size={16} />
				</button>
				<span class="dm-head-title" title={activeHeaderTitle}>
					{#if !activeGroup && !isKeepNotesSelected && dmOther}
						<ProfileName username={activeHeaderTitle} font={dmOther.usernameFont} color={dmOther.roleColor || dmOther.color} />
					{:else}
						{activeHeaderTitle}
					{/if}
				</span>
				{#if isKeepNotesSelected}
					<span class="w-tag dm-head-tag">Only you · this device</span>
				{/if}
				{#each headerCallActions as action (action.id)}
					<button type="button" class="w-ibtn w-ibtn--sm" on:click={action.onSelect} title={action.title} aria-label={action.title}>
						<Icon name={action.glyph} size={16} />
					</button>
				{/each}
				{#if headerActionMenuItems.length > 0}
					<Menu
						items={headerActionMenuItems}
						label="Conversation actions"
						triggerLabel="Conversation actions"
						class="w-ibtn w-ibtn--sm"
						align="end"
						heading={activeHeaderTitle}
					>
						<Icon name="more" size={16} />
					</Menu>
				{/if}
			</div>
			<div class="dm-tab-messages">
				{#if showGroupSettings && activeGroup}
					<GroupSettingsPanel channel={activeGroup} />
				{:else if isKeepNotesSelected}
					<KeepNotesView />
				{:else if activeGroup}
					<DMMessageView
						channelId={selectedDmId}
						otherUser={activeGroup.memberUsers?.[0] || { id: '', username: activeGroup.name, color: '', status: 'offline' }}
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
		</div>
	{:else}
		<!-- DM list: row B is search + filter + new conversation. -->
		<div class="dm-tab-list">
			<div class="dm-rowb">
				<label class="w-field w-field--chrome dm-find">
					<Icon name="search" size={16} />
					<input type="search" bind:value={conversationQuery} placeholder="Search DMs" aria-label="Search DMs" autocomplete="off" spellcheck="false" />
				</label>
				<Menu
					items={filterMenuItems}
					label="Show conversations"
					triggerLabel={filterApplied ? `Filter DMs, showing ${FILTER_LABELS[conversationFilter].toLowerCase()}` : 'Filter DMs'}
					class={filterApplied ? 'w-ibtn w-ibtn--edge w-ibtn--dot dm-ibtn' : 'w-ibtn w-ibtn--edge dm-ibtn'}
					align="end"
					heading="DMs"
					onselect={handleFilterSelect}
				>
					<Icon name="sliders" />
				</Menu>
				<Menu items={newConversationItems} label="New conversation" triggerLabel="New conversation" class="w-ibtn w-ibtn--edge dm-ibtn" align="end" heading="New conversation">
					<Icon name="plus" />
				</Menu>
			</div>
			{#if filterApplied}
				<div class="dm-chips">
					<span class="w-tag dm-chip">
						{FILTER_LABELS[conversationFilter]} only
						<button type="button" class="dm-chip-clear" aria-label="Show all conversations" on:click={() => (conversationFilter = 'all')}>
							<Icon name="x" size={12} />
						</button>
					</span>
				</div>
			{/if}

			{#if showNewDM}
				<div class="dm-new-panel">
					<div class="dm-new-head">
						<span class="w-kicker">New message</span>
						<button type="button" class="w-ibtn w-ibtn--sm" aria-label="Close new message" on:click={() => { showNewDM = false; searchQuery = ''; createDmError = ''; }}>
							<Icon name="x" size={16} />
						</button>
					</div>
					<label class="w-field w-field--chrome dm-find">
						<Icon name="user" size={16} />
						<input type="search" bind:value={searchQuery} placeholder="Find a person" aria-label="Find a person to message" autocomplete="off" spellcheck="false" />
					</label>
					{#if createDmError}
						<p class="dm-new-error" role="alert"><Icon name="alert" size={14} />{createDmError}</p>
					{/if}
					<div class="dm-new-list">
						{#each filteredUsers as user (getDmDirectoryKey(user))}
							<button type="button" class="dm-new-user" style={$inkFor(user.roleColor || user.color)} disabled={creatingDmKey === getDmDirectoryKey(user)} aria-busy={creatingDmKey === getDmDirectoryKey(user)} on:click={() => startDMWith(user)}>
								{#if user.profilePicture}
									<ProfileMedia src={mediaUrl(user.profilePicture)} decorative class="dm-stamp dm-stamp--sm" />
								{:else}
									<span class="dm-stamp dm-stamp--sm" aria-hidden="true">{user.username.charAt(0).toUpperCase()}</span>
								{/if}
								<span class="dm-new-name"><ProfileName username={user.username} font={user.usernameFont} color={user.roleColor || user.color} /></span>
								{#if user.handle}<span class="dm-new-handle">@{user.handle}</span>{/if}
							</button>
						{:else}
							<p class="dm-empty-search">No one matches “{searchQuery.trim()}”.</p>
						{/each}
					</div>
				</div>
			{/if}

			<div class="dm-conversations">
				{#each conversationRows as row (row.id)}
					<div
						class="dm-row-shell"
						class:is-selected={row.selected}
						style={row.ink}
						use:longpress={{ onLongPress: (e) => handleConversationLongPress(e, row.channel, row.other) }}
					>
						<button
							type="button"
							class="dm-row"
							aria-label={row.ariaLabel}
							aria-current={row.selected ? 'true' : undefined}
							on:click={() => selectConversation(row.channel)}
							on:contextmenu={(e) => openContextMenu(e, row.channel, row.other)}
						>
							<span class="dm-row-av">
								{#if row.isGroup}
									<GroupAvatar channel={row.channel} size={32} />
								{:else if row.other?.profilePicture}
									<ProfileMedia src={mediaUrl(row.other.profilePicture)} decorative class="dm-stamp" />
								{:else}
									<span class="dm-stamp" aria-hidden="true">{row.initial}</span>
								{/if}
								{#if row.presence === 'active' || row.presence === 'away' || row.presence === 'busy'}
									<span class="dm-presence" data-presence={row.presence} aria-hidden="true"></span>
								{/if}
							</span>
							<span class="dm-row-text">
								<span class="dm-row-top">
									<span class="dm-row-name">
										{#if row.isGroup}{row.name}{:else if row.other}<ProfileName username={row.name} font={row.other.usernameFont} color={row.color} />{/if}
									</span>
									{#if row.pinned}<span class="dm-row-pin" title="Pinned conversation"><Icon name="pin" size={12} /></span>{/if}
									{#if row.time}<span class="dm-row-time">{row.time}</span>{/if}
								</span>
								<span class="dm-row-bottom">
									<span class="dm-row-preview">{row.preview}</span>
									{#if row.unread > 0}<span class="w-badge w-badge--sm dm-row-badge" aria-hidden="true">{row.unread > 99 ? '99+' : row.unread}</span>{/if}
								</span>
							</span>
						</button>
						<span class="dm-row-tray">
							{#each row.actions.filter((action) => !action.danger) as action (action.id)}
								<button type="button" class="w-ibtn w-ibtn--sm" title={action.title} aria-label={action.title} on:click|stopPropagation={action.onSelect}>
									<Icon name={action.glyph} size={16} />
								</button>
							{/each}
							<button type="button" class="w-ibtn w-ibtn--sm" aria-label={`More for ${row.name}`} aria-haspopup="menu" on:click={(e) => openRowMenu(e, row.channel, row.other)}>
								<Icon name="more" size={16} />
							</button>
						</span>
					</div>
				{:else}
					{#if listFiltered}
						<EmptyState
							class="dm-empty"
							as="p"
							icon="dm"
							title="No conversations match"
							text={conversationQuery.trim() ? 'Try another name.' : `No ${FILTER_LABELS[conversationFilter].toLowerCase()} conversations right now.`}
							action="Show all"
							onaction={clearListFilters}
						/>
					{:else}
						<EmptyState
							class="dm-empty"
							as="p"
							icon="dm"
							title="No conversations yet"
							text="Start one with anyone in this community. It appears here."
							action="New message"
							onaction={() => { showNewDM = true; }}
						/>
					{/if}
				{/each}
			</div>
		</div>
	{/if}

	<ContextMenu
		open={showContextMenu && !!contextMenuChannel}
		x={contextMenuX}
		y={contextMenuY}
		items={contextMenuItems}
		ariaLabel="Conversation actions"
		headerLabel={contextMenuChannel?.type === 'group' ? contextMenuChannel?.name || null : contextMenuUser?.username || null}
		on:close={closeContextMenu}
	/>
</div>

<CreateGroupModal bind:isOpen={showCreateGroup} />

<style>
	/* DMs companion (design contract §7.21 frame, §8.4 DMs, §7.11 rows). Roles and kit only. */
	.dm-tab,
	.dm-tab-active,
	.dm-tab-list {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		color: var(--w-text);
		font: var(--w-t-ui);
	}

	/* Row B: the masthead rule at y = 96 under the frame's 56px title row. */
	.dm-rowb {
		display: flex;
		flex: none;
		align-items: center;
		gap: 8px;
		box-sizing: border-box;
		height: var(--w-head-b);
		padding: 0 12px 8px 20px;
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	.dm-active-head {
		gap: 4px;
		padding-left: 12px;
	}
	.dm-find {
		flex: 1 1 auto;
		cursor: text;
	}
	:global(:root) .dm-find > input[type='search'] {
		min-height: 0;
		height: 100%;
		padding: 0;
		border: 0;
		border-radius: 0;
		background: transparent;
		box-shadow: none;
		color: var(--w-text);
		font: inherit;
		outline: none;
		appearance: none;
	}
	.dm-tab :global(.dm-ibtn) {
		--w-ibtn-ring: var(--w-bg2);
	}
	.dm-tab :global(.w-ibtn:focus-visible),
	.dm-chip-clear:focus-visible {
		outline: 2px solid var(--w-accent);
		outline-offset: 2px;
	}
	.dm-head-title {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		margin-left: 4px;
		color: var(--w-text);
		font: var(--w-t-label);
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.dm-head-tag {
		flex: none;
	}

	.dm-chips {
		display: flex;
		flex: none;
		padding: 8px 16px 0 20px;
	}
	.dm-chip {
		gap: 4px;
		padding-inline-end: 3px;
		color: var(--w-text);
	}
	.dm-chip-clear {
		display: inline-grid;
		place-items: center;
		width: 18px;
		height: 18px;
		margin: 0;
		padding: 0;
		border: 0;
		border-radius: var(--w-pill);
		background: transparent;
		color: var(--w-mute);
		cursor: pointer;
	}
	.dm-chip-clear:hover {
		background: var(--w-raise);
		color: var(--w-text);
	}

	.dm-tab-messages {
		flex: 1;
		min-height: 0;
	}

	/* ---------- new message ---------- */
	.dm-new-panel {
		display: flex;
		flex: none;
		flex-direction: column;
		gap: 8px;
		padding: 12px 12px 12px 20px;
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	.dm-new-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 28px;
	}
	.dm-new-error {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin: 0;
		color: var(--w-danger);
		font: var(--w-t-small);
	}
	.dm-new-error :global(svg) {
		flex: none;
		margin-top: 2px;
	}
	.dm-new-list {
		max-height: 200px;
		margin: 0 -8px;
		overflow-y: auto;
	}
	.dm-new-user {
		display: grid;
		grid-template-columns: 24px minmax(0, auto) minmax(0, 1fr);
		align-items: center;
		column-gap: 10px;
		box-sizing: border-box;
		width: 100%;
		min-height: 40px;
		margin: 0;
		padding: 0 8px;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--w-text);
		font: inherit;
		text-align: start;
		cursor: pointer;
		transition: background-color var(--w-dur-1) var(--w-ease);
	}
	.dm-new-user:hover:not(:disabled) {
		background: color-mix(in srgb, var(--w-raise) 70%, transparent);
	}
	.dm-new-user:focus-visible {
		outline: 2px solid var(--w-accent);
		outline-offset: -2px;
	}
	.dm-new-user:disabled {
		opacity: 0.6;
		cursor: progress;
	}
	.dm-new-name {
		min-width: 0;
		overflow: hidden;
		font: var(--w-t-label);
		white-space: nowrap;
	}
	.dm-new-handle {
		min-width: 0;
		overflow: hidden;
		color: var(--w-faint);
		font: var(--w-t-mono);
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.dm-empty-search {
		margin: 0;
		padding: 8px;
		color: var(--w-mute);
		font: var(--w-t-small);
	}

	/* ---------- conversation rows: 52px, stamp 32 ---------- */
	.dm-conversations {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 8px 0 16px;
	}
	.dm-row-shell {
		--dm-surface: var(--w-bg2);
		position: relative;
		margin: 0 8px;
	}
	.dm-row {
		display: grid;
		grid-template-columns: 32px minmax(0, 1fr);
		align-items: center;
		column-gap: 12px;
		box-sizing: border-box;
		width: 100%;
		min-height: 52px;
		margin: 0;
		padding: 6px 12px;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--w-text);
		font: inherit;
		text-align: start;
		cursor: pointer;
		transition: background-color var(--w-dur-1) var(--w-ease), box-shadow var(--w-dur-1) var(--w-ease);
	}
	.dm-row-shell:hover {
		--dm-surface: color-mix(in srgb, var(--w-raise) 70%, var(--w-bg2));
	}
	.dm-row-shell:hover .dm-row {
		background: color-mix(in srgb, var(--w-raise) 70%, transparent);
	}
	.dm-row-shell.is-selected {
		--dm-surface: var(--w-raise);
	}
	.dm-row-shell.is-selected .dm-row {
		background: var(--w-raise);
	}
	.dm-row:focus-visible {
		outline: 2px solid var(--w-accent);
		outline-offset: -2px;
	}
	:global(:root[data-char='contrast']) .dm-row-shell:hover .dm-row {
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--w-line-strong);
	}
	:global(:root[data-char='contrast']) .dm-row-shell.is-selected .dm-row {
		box-shadow: inset 0 0 0 1px var(--w-line-strong);
	}
	:global(:root[data-char='contrast']) .dm-row-shell:hover {
		--dm-surface: var(--w-bg2);
	}

	.dm-row-av {
		position: relative;
		display: block;
		width: 32px;
		height: 32px;
	}
	.dm-tab :global(.dm-stamp) {
		display: grid;
		place-items: center;
		box-sizing: border-box;
		width: 32px;
		height: 32px;
		border-radius: var(--w-avr);
		background: var(--disc, var(--w-raise));
		color: var(--on, var(--w-text));
		font: 600 calc(14px * var(--w-fs)) / 1 var(--w-serif);
		object-fit: cover;
		user-select: none;
	}
	.dm-tab :global(.dm-stamp--sm) {
		width: 24px;
		height: 24px;
		font: 500 calc(11px * var(--w-fs)) / 1 var(--w-sans);
	}
	.dm-presence {
		position: absolute;
		right: -2px;
		bottom: -2px;
		box-sizing: border-box;
		width: 10px;
		height: 10px;
		border-radius: var(--w-avr);
		background: var(--w-online);
		box-shadow: 0 0 0 2px var(--dm-surface);
	}
	.dm-presence[data-presence='away'] {
		background: var(--w-warn);
	}
	.dm-presence[data-presence='busy'] {
		background: var(--w-danger);
	}

	.dm-row-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.dm-row-top,
	.dm-row-bottom {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	.dm-row-name {
		display: flex;
		flex: 0 1 auto;
		align-items: center;
		min-width: 0;
		height: calc(20px * var(--w-fs));
		overflow: hidden;
		font: var(--w-t-label);
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.dm-row-pin {
		display: inline-grid;
		flex: none;
		place-items: center;
		color: var(--w-faint);
	}
	.dm-row-time {
		flex: none;
		margin-left: auto;
		color: var(--w-faint);
		font: var(--w-t-micro);
		font-variant-numeric: tabular-nums;
	}
	.dm-row-preview {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		color: var(--w-faint);
		font: var(--w-t-small);
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.dm-row-badge {
		flex: none;
	}

	/* Hover tray over the trailing slot: call, video, more. It takes no width and hides the time. */
	.dm-row-tray {
		position: absolute;
		top: 50%;
		right: 8px;
		display: flex;
		gap: 2px;
		padding-left: 8px;
		border-radius: var(--radius-md);
		background: var(--dm-surface);
		translate: 0 -50%;
		opacity: 0;
		pointer-events: none;
		transition: opacity var(--w-dur-1) var(--w-ease);
	}
	.dm-row-shell:hover .dm-row-tray,
	.dm-row-shell:focus-within .dm-row-tray {
		opacity: 1;
		pointer-events: auto;
	}

	.dm-tab :global(.dm-empty) {
		padding: 32px 20px;
	}

	@media (pointer: coarse) {
		.dm-row {
			min-height: 56px;
		}
		/* Touch: a long press opens the conversation menu, so the hover tray stays away. */
		.dm-row-tray {
			display: none;
		}
		.dm-tab :global(.w-ibtn) {
			width: 44px;
			height: 44px;
		}
		.dm-new-user {
			min-height: 44px;
		}
	}

	@media (max-width: 768px) {
		:global(:root) .dm-find > input[type='search'] {
			font-size: max(16px, calc(14px * var(--w-fs)));
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.dm-row,
		.dm-row-tray,
		.dm-new-user {
			transition: none;
		}
	}
</style>
