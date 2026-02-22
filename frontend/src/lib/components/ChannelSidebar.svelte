<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { fly } from 'svelte/transition';
	import {
		channels,
		currentChannel,
		joinChannel,
		createChannel,
		createThread,
		deleteChannel,
		markMessagesAsRead,
		currentUser,
		updateChannelSettings,
		channelUnreadCounts,
		updateProfile,
		activeVoiceChannel as activeVoiceChannelId,
		voiceChannelMembers,
		joinVoiceChannel,
		leaveVoiceChannel,
		subscribeVoiceChannel,
		unsubscribeVoiceChannel,
		setVoiceTransmitMode,
		createBreakoutRooms,
		closeBreakoutRooms,
		getSocket,
		roleDefinitions
	} from '$lib/socket';
	import {
		activeCalls,
		isLocalSpeaking,
		openChannelCallPanel,
		callMode,
		connectionState as callConnectionState,
		callConnectionDiagnostics,
		callTransportState,
		channelCallPanelOpen,
		listeningVoiceChannels,
		voiceTransmitMode,
		isMuted as callMuted,
		isDeafened as callDeafened,
		isVideoOff,
		toggleMute,
		toggleDeafen,
		toggleVideo
	} from '$lib/calling';
	import Settings from './Settings.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import PinnedMessagesModal from './PinnedMessagesModal.svelte';
	import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';
	import type { ContextMenuItem } from '$lib/context-menu/types';
	import type { Channel } from '$lib/socket';
	import { longpress } from '$lib/actions/longpress';
	import { layoutStore } from '$lib/layoutStore';

	const dispatch = createEventDispatcher();

	// Helper function to format badge display
	function formatBadge(count: number): string {
		if (count === 0) return '';
		if (count <= 10) return `+${count}`;
		return '•';
	}

	export let activeView: 'chat' | 'screen' = 'chat';

	let newChannelName = '';
	let newChannelDescription = '';
	let newChannelType: 'text' | 'voice' = 'text';
	let showCreateInput = false;
	let showSettings = false;
	let showVoiceDebugDetails = false;
	let showDeleteConfirm = false;
	let channelToDelete = '';
	let showPinnedModal = false;
	let selectedChannelForPinned = '';
	let showStatusPopup = false;
	let showChannelSettingsModal = false;
	let selectedChannelForSettings: Channel | null = null;
	let isTextSectionExpanded = true;
	let isVoiceSectionExpanded = true;
	const VOICE_MEMBER_RENDER_LIMIT = 12;
	const fallbackRoleLabels: Record<string, string> = {
		owner: 'Owner',
		admin: 'Admin',
		mod: 'Moderator',
		member: 'Member',
		guest: 'Guest'
	};

	$: currentUserRoleLabel = (() => {
		if (!$currentUser) return '';
		const roleName = $currentUser.highestRole || ($currentUser.dbUserId ? 'member' : 'guest');
		const roleDefinition = $roleDefinitions.find(role => role.roleName === roleName);
		return roleDefinition?.displayName || fallbackRoleLabels[roleName] || roleName;
	})();

	// Sidebar width from layout store - 3 modes: normal (280px), compact (60px), hidden (0px)
	$: sidebarWidth = $layoutStore.channelSidebarWidth;
	$: isCompactSidebar = sidebarWidth === 60;

	// Context menu state
	let contextMenuChannel: Channel | null = null;
	let contextMenuPosition = { x: 0, y: 0 };
	let showContextMenu = false;

	function toggleSidebar() {
		const current = $layoutStore.channelSidebarWidth;
		layoutStore.channelSidebarWidth.set(current === 0 ? 280 : 0);
	}

	function handleLogout() {
		dispatch('logout');
	}

	// Separate channels by type
	// Note: DMs are excluded from sidebar - only accessible via UserPanel
	$: textChannels = $channels
		.filter(ch => !ch.type || ch.type === 'public' || ch.type === 'text')
		.sort((a, b) => {
			if (a.id === 'general') return -1;
			if (b.id === 'general') return 1;
			return a.name.localeCompare(b.name);
		});
	$: groupChannels = $channels.filter(ch => ch.type === 'group');
	$: threadChannels = $channels
		.filter(ch => ch.type === 'thread_public' || ch.type === 'thread_private')
		.sort((a, b) => (b.threadLastActivityAt || b.createdAt || 0) - (a.threadLastActivityAt || a.createdAt || 0));
	$: threadChannelsByParent = threadChannels.reduce((acc: Record<string, Channel[]>, thread) => {
		const parentId = thread.parentChannelId;
		if (!parentId) return acc;
		if (!acc[parentId]) acc[parentId] = [];
		acc[parentId].push(thread);
		return acc;
	}, {});
	$: allVoiceChannels = $channels
		.filter(ch => ch.type === 'voice')
		.sort((a, b) => {
			if (a.id === 'voice') return -1;
			if (b.id === 'voice') return 1;
			return a.name.localeCompare(b.name);
		});
	$: breakoutChannelsByParent = allVoiceChannels
		.filter(ch => ch.isBreakout && ch.parentChannelId)
		.reduce((acc: Record<string, Channel[]>, channel) => {
			const parentId = channel.parentChannelId!;
			if (!acc[parentId]) acc[parentId] = [];
			acc[parentId].push(channel);
			return acc;
		}, {});
	$: Object.values(breakoutChannelsByParent).forEach((rooms) =>
		rooms.sort((a, b) => (a.breakoutIndex || 0) - (b.breakoutIndex || 0))
	);
	$: voiceChannels = allVoiceChannels.filter(ch => !ch.isBreakout);

	// Clear unread count when switching to chat view
	$: if (activeView === 'chat') {
		markMessagesAsRead();
	}

	function handleChannelClick(channelId: string) {
		joinChannel(channelId);
		dispatch('close'); // Close sidebar on mobile after channel selection
	}

	function handleCreateThread(parentChannel: Channel) {
		const rawName = window.prompt(`Create a thread in #${parentChannel.name}`, `${parentChannel.name} thread`);
		if (!rawName) return;
		const name = rawName.trim();
		if (!name) return;
		createThread(parentChannel.id, name);
	}


	function getVoiceMembers(channelId: string) {
		const members = [...($voiceChannelMembers[channelId] || [])];
		if (!isConnectedToVoice(channelId) || !$currentUser) return members;

		const currentStableId = $currentUser.dbUserId ? `user-${$currentUser.dbUserId}` : null;
		const hasSelf = members.some(
			(member) =>
				member.socketId === $currentUser.id ||
				member.userId === $currentUser.id ||
				(currentStableId ? member.userId === currentStableId : false)
		);
		if (!hasSelf) {
			members.push({
				userId: currentStableId || $currentUser.id,
				socketId: $currentUser.id,
				username: $currentUser.username,
				profilePicture: $currentUser.profilePicture
			});
		}

		return members;
	}

	function getVisibleVoiceMembers<T>(members: T[]): T[] {
		return members.slice(0, VOICE_MEMBER_RENDER_LIMIT);
	}

	function isConnectedToVoice(channelId: string): boolean {
		return $activeVoiceChannelId === channelId;
	}

	function isCurrentVoiceMember(member: { userId: string; socketId?: string }): boolean {
		if (!$currentUser) return false;
		const stableId = $currentUser.dbUserId ? `user-${$currentUser.dbUserId}` : null;
		return (
			member.userId === $currentUser.id ||
			member.socketId === $currentUser.id ||
			(stableId ? member.userId === stableId : false)
		);
	}

	function getMemberLabel(member: { userId: string; socketId?: string; username?: string }): string {
		if (isCurrentVoiceMember(member)) return 'You';
		return member.username || 'Unknown user';
	}

	async function handleVoiceChannelClick(channelId: string) {
		if (isConnectedToVoice(channelId)) {
			openChannelCallPanel();
			dispatch('close'); // Close sidebar on mobile after opening call view
			return;
		}
		try {
			await joinVoiceChannel(channelId);
			dispatch('close');
		} catch (error) {
			console.error('Failed to join voice channel:', error);
		}
	}

	function hasBreakoutRooms(parentChannelId: string): boolean {
		return (breakoutChannelsByParent[parentChannelId] || []).length > 0;
	}

	function handleCreateBreakoutRooms(channel: Channel) {
		const suggestedRooms = Math.max(2, Math.ceil(getVoiceMembers(channel.id).length / 2));
		const raw = window.prompt(`Create breakout rooms for ${channel.name} (2-20):`, String(suggestedRooms));
		if (raw === null) return;
		const parsed = Number.parseInt(raw, 10);
		if (!Number.isFinite(parsed)) return;
		createBreakoutRooms(channel.id, parsed, true);
	}

	function handleCloseBreakoutRooms(channel: Channel) {
		closeBreakoutRooms(channel.id);
	}

	function avatarTitle(username?: string): string {
		return username || 'Voice participant';
	}

	function isMemberSpeaking(member: { userId: string; socketId?: string }): boolean {
		if (isCurrentVoiceMember(member)) return $isLocalSpeaking && !$callMuted && !$callDeafened;
		const remoteCall = $activeCalls.find(
			(call) => call.userId === (member.socketId || member.userId) || call.userId === member.userId
		);
		return Boolean(remoteCall?.isSpeaking && remoteCall?.isAudioEnabled);
	}

	function formatDiag(value: number | null, unit = ''): string {
		if (value == null || Number.isNaN(value)) return '--';
		return `${value}${unit}`;
	}

	function getCurrentVoiceChannelName(): string {
		if (!$activeVoiceChannelId) return '';
		const match = allVoiceChannels.find((channel) => channel.id === $activeVoiceChannelId);
		return match?.name || $activeVoiceChannelId;
	}

	function handleLeaveActiveVoiceChannel() {
		if (!$activeVoiceChannelId) return;
		void leaveVoiceChannel($activeVoiceChannelId);
	}

	function isListeningToChannel(channelId: string): boolean {
		return $listeningVoiceChannels.includes(channelId);
	}

	function handleToggleListenChannel(channelId: string) {
		if (channelId === $activeVoiceChannelId) return;
		if (isListeningToChannel(channelId)) {
			unsubscribeVoiceChannel(channelId);
			return;
		}
		subscribeVoiceChannel(channelId);
	}

	function handleTransmitModeChange(event: Event) {
		const value = (event.currentTarget as HTMLSelectElement).value as 'primary' | 'all-listening';
		setVoiceTransmitMode(value);
	}

	async function handleToggleVideoInSidebar() {
		await toggleVideo(getSocket() || undefined);
	}

	function toggleSection(section: 'text' | 'voice') {
		if (section === 'text') {
			isTextSectionExpanded = !isTextSectionExpanded;
			return;
		}
		isVoiceSectionExpanded = !isVoiceSectionExpanded;
	}

	function handleCreateChannel() {
		if (newChannelName.trim()) {
			createChannel(newChannelName.trim(), newChannelDescription.trim(), newChannelType);
			newChannelName = '';
			newChannelDescription = '';
			newChannelType = 'text';
			showCreateInput = false;
		}
	}

	function handleDeleteChannel(channelId: string) {
		channelToDelete = channelId;
		showDeleteConfirm = true;
	}

	function confirmDeleteChannel() {
		deleteChannel(channelToDelete);
		showDeleteConfirm = false;
	}

	function handleShowPinnedMessages(channelId: string) {
		selectedChannelForPinned = channelId;
		showPinnedModal = true;
	}

	let tempPersistMessages = false;
	let tempDescription = '';

	function handleOpenChannelSettings(channel: Channel) {
		selectedChannelForSettings = channel;
		tempPersistMessages = channel.persistMessages || false;
		tempDescription = channel.description || '';
		showChannelSettingsModal = true;
	}

	function handleUpdateAutoDelete(autoDeleteAfter: '5s' | '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d' | null) {
		if (selectedChannelForSettings) {
			updateChannelSettings(selectedChannelForSettings.id, {
				autoDeleteAfter,
				persistMessages: tempPersistMessages,
				description: tempDescription
			});
			showChannelSettingsModal = false;
		}
	}

	function handleSaveChannelSettings() {
		if (selectedChannelForSettings) {
			updateChannelSettings(selectedChannelForSettings.id, {
				autoDeleteAfter: selectedChannelForSettings.autoDeleteAfter || null,
				persistMessages: tempPersistMessages,
				description: tempDescription
			});
			showChannelSettingsModal = false;
		}
	}

	function handleTogglePersistence() {
		tempPersistMessages = !tempPersistMessages;
	}

	function toggleStatusPopup() {
		showStatusPopup = !showStatusPopup;
	}

	function changeStatus(newStatus: 'active' | 'away' | 'busy') {
		updateProfile(newStatus, undefined, undefined);
		showStatusPopup = false;
	}

	function handleChannelLongPress(event: TouchEvent, channel: Channel) {
		const touch = event.touches?.[0] || event.changedTouches?.[0];
		if (!touch) return;
		const syntheticEvent = new MouseEvent('contextmenu', {
			clientX: touch.clientX,
			clientY: touch.clientY,
			bubbles: true
		});
		handleChannelRightClick(syntheticEvent, channel);
	}

	function handleChannelRightClick(event: MouseEvent, channel: Channel) {
		event.preventDefault();
		contextMenuChannel = channel;
		contextMenuPosition = { x: event.clientX, y: event.clientY };
		showContextMenu = true;
	}

	function isEditableTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		const tag = target.tagName;
		return (
			target.isContentEditable ||
			tag === 'INPUT' ||
			tag === 'TEXTAREA' ||
			tag === 'SELECT'
		);
	}

	function closeContextMenu() {
		showContextMenu = false;
		contextMenuChannel = null;
	}

	$: channelMenuItems = contextMenuChannel ? buildChannelMenuItems(contextMenuChannel) : [];

	function buildChannelMenuItems(channel: Channel): ContextMenuItem[] {
		const items: ContextMenuItem[] = [
			// TODO(mod/admin-perms): Re-enable pin/unpin channel action once role-based
			// permissions are wired into channel context menu visibility.
			// {
			// 	id: 'pin-channel',
			// 	label: isChannelPinned(channel) ? 'Unpin Channel' : 'Pin Channel',
			// 	icon: 'pin',
			// 	onSelect: togglePinChannel
			// },
			{
				id: 'pinned-messages',
				label: 'Pinned Messages',
				icon: 'pin',
				onSelect: () => handleShowPinnedMessages(channel.id)
			},
			{
				id: 'channel-settings',
				label: 'Channel Settings',
				icon: 'settings',
				onSelect: () => handleOpenChannelSettings(channel)
			}
		];

		if (channel.type === 'text' || channel.type === 'public' || !channel.type) {
			items.splice(1, 0, {
				id: 'create-thread',
				label: 'Create Thread',
				icon: 'message-circle',
				onSelect: () => handleCreateThread(channel)
			});
		}

		if (channel.type === 'voice' && !channel.isBreakout) {
			items.push({ id: 'voice-divider', type: 'separator' });
			if (hasBreakoutRooms(channel.id)) {
				items.push({
					id: 'close-breakout-rooms',
					label: 'Close Breakout Rooms',
					icon: 'archive-restore',
					onSelect: () => handleCloseBreakoutRooms(channel)
				});
			} else {
				items.push({
					id: 'create-breakout-rooms',
					label: 'Create Breakout Rooms',
					icon: 'archive',
					onSelect: () => handleCreateBreakoutRooms(channel)
				});
			}
		}

		if (channel.id !== 'general' && channel.id !== 'voice' && !channel.isBreakout) {
			items.push({ id: 'danger-divider', type: 'separator' });
			items.push({
				id: 'delete-channel',
				label: 'Delete Channel',
				icon: 'trash-2',
				danger: true,
				onSelect: () => handleDeleteChannel(channel.id)
			});
		}

		return items;
	}

</script>

{#if sidebarWidth === 0}
	<button class="expand-btn" on:click={toggleSidebar} title="Expand sidebar">›</button>
{/if}

<div class="channel-sidebar" class:compact={isCompactSidebar} style="width: {$layoutStore.channelSidebarWidth}px">
	<div class="top-section">
		<button class="mobile-close-btn" on:click={() => dispatch('close')}>&times;</button>
		<div class="logo">
			<img src="/wabi-logo-small.webp" alt="Wabi" class="logo-img" />
		</div>
		<div class="header-buttons">
			{#if sidebarWidth < 170}
				<button
					class="control-btn compact-settings-btn"
					on:click={() => showSettings = true}
					title="User Settings"
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
				</button>
			{/if}
		</div>
	</div>

	{#if showCreateInput}
		<div class="create-channel">
			<input
				type="text"
				bind:value={newChannelName}
				placeholder="channel-name"
				on:keydown={(e) => e.key === 'Enter' && handleCreateChannel()}
				autofocus
			/>
			<input
				type="text"
				bind:value={newChannelDescription}
				placeholder="Description (optional)"
				on:keydown={(e) => e.key === 'Enter' && handleCreateChannel()}
			/>
			<select bind:value={newChannelType}>
				<option value="text">Text Channel</option>
				<option value="voice">Voice Channel</option>
				<option value="forum" disabled>Forum Channel (coming soon)</option>
			</select>
			<p class="create-channel-hint">Forum channels are planned but not supported yet.</p>
			<button on:click={handleCreateChannel}>Create</button>
		</div>
	{/if}

	<div class="channel-list">
		<div class="section-heading-row">
			<button
				class="section-toggle"
				type="button"
				aria-expanded={isTextSectionExpanded}
				on:click={() => toggleSection('text')}
			>
				<span class="section-chevron">&gt;</span>
				<span class="section-toggle-label">Text Channels</span>
				<span class="section-count">{textChannels.length + groupChannels.length}</span>
			</button>
			<button
				class="section-add-btn"
				class:active={showCreateInput}
				on:click={() => showCreateInput = !showCreateInput}
				title="Create channel"
				aria-label="Create channel"
			>
				+
			</button>
		</div>
		{#if isTextSectionExpanded}
		<!-- Public text channels -->
		{#each textChannels as channel (channel.id)}
			<div class="channel-item" class:active={$currentChannel === channel.id} class:has-timer={channel.autoDeleteAfter} on:contextmenu={(e) => handleChannelRightClick(e, channel)} use:longpress={{ onLongPress: (e) => handleChannelLongPress(e, channel) }}>
				<button class="channel-btn" data-abbrev={channel.name.charAt(0).toUpperCase()} on:click={() => handleChannelClick(channel.id)} title={channel.autoDeleteAfter ? `Auto-delete: ${channel.autoDeleteAfter}` : ''}>
					<span class="hash">#</span>
					{channel.name}
					<!-- TODO(mod/admin-perms): Restore channel-pin indicator when channel pinning is role-gated. -->
					{#if $channelUnreadCounts[channel.id] && $currentChannel !== channel.id}
						<span class="unread-badge">{formatBadge($channelUnreadCounts[channel.id])}</span>
					{/if}
				</button>
				<div class="channel-actions text-channel-actions">
					<button class="settings-btn" on:click|stopPropagation={() => handleOpenChannelSettings(channel)} title="Channel settings">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
				</button>
					<button class="pin-btn" on:click|stopPropagation={() => handleShowPinnedMessages(channel.id)} title="View pinned messages">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="2"></circle><path d="M9 3h6l-1 6 3 3H7l3-3-1-6z"></path><line x1="12" y1="15" x2="12" y2="21"></line></svg>
				</button>
				</div>
			</div>
			{#if (threadChannelsByParent[channel.id] || []).length > 0}
				<div class="thread-list">
					{#each threadChannelsByParent[channel.id] as thread (thread.id)}
						<button
							class="thread-btn"
							class:active={$currentChannel === thread.id}
							on:click={() => handleChannelClick(thread.id)}
							title={thread.type === 'thread_private' ? 'Private thread' : 'Thread'}
						>
							<span class="thread-prefix">&gt;</span>
							<span class="thread-name">{thread.name}</span>
							{#if thread.type === 'thread_private'}
								<span class="thread-privacy">Private</span>
							{/if}
							{#if $channelUnreadCounts[thread.id] && $currentChannel !== thread.id}
								<span class="unread-badge">{formatBadge($channelUnreadCounts[thread.id])}</span>
							{/if}
						</button>
					{/each}
				</div>
			{/if}
		{/each}

		<!-- DMs removed from sidebar - now accessible via UserPanel -->

		<!-- Group text channels -->
		{#if groupChannels.length > 0}
			<div class="section-header section-subheader">Group Chats</div>
			{#each groupChannels as channel (channel.id)}
				<div class="channel-item" class:active={$currentChannel === channel.id} class:has-timer={channel.autoDeleteAfter} on:contextmenu={(e) => handleChannelRightClick(e, channel)} use:longpress={{ onLongPress: (e) => handleChannelLongPress(e, channel) }}>
					<button class="channel-btn" data-abbrev={channel.name.charAt(0).toUpperCase()} on:click={() => handleChannelClick(channel.id)} title={channel.autoDeleteAfter ? `Auto-delete: ${channel.autoDeleteAfter}` : ''}>
						<svg class="group-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
						{channel.name}
						<!-- TODO(mod/admin-perms): Restore channel-pin indicator when channel pinning is role-gated. -->
						{#if $channelUnreadCounts[channel.id] && $currentChannel !== channel.id}
							<span class="unread-badge">{formatBadge($channelUnreadCounts[channel.id])}</span>
						{/if}
					</button>
					<div class="channel-actions text-channel-actions">
						<button class="settings-btn" on:click|stopPropagation={() => handleOpenChannelSettings(channel)} title="Channel settings">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
				</button>
						<button class="pin-btn" on:click|stopPropagation={() => handleShowPinnedMessages(channel.id)} title="View pinned messages">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="2"></circle><path d="M9 3h6l-1 6 3 3H7l3-3-1-6z"></path><line x1="12" y1="15" x2="12" y2="21"></line></svg>
				</button>
					</div>
				</div>
			{/each}
		{/if}

		{/if}

		<div class="section-heading-row">
			<button
				class="section-toggle"
				type="button"
				aria-expanded={isVoiceSectionExpanded}
				on:click={() => toggleSection('voice')}
			>
				<span class="section-chevron">&gt;</span>
				<span class="section-toggle-label">Voice Channels</span>
				<span class="section-count">{allVoiceChannels.length}</span>
			</button>
			<button
				class="section-add-btn"
				class:active={showCreateInput}
				on:click={() => showCreateInput = !showCreateInput}
				title="Create channel"
				aria-label="Create channel"
			>
				+
			</button>
		</div>
		{#if isVoiceSectionExpanded}
		{#each voiceChannels as channel (channel.id)}
			{@const members = getVoiceMembers(channel.id)}
			<div
				class="channel-item voice-channel-item"
				class:active={isConnectedToVoice(channel.id)}
				on:click={() => handleVoiceChannelClick(channel.id)}
				on:contextmenu={(e) => handleChannelRightClick(e, channel)}
				use:longpress={{ onLongPress: (e) => handleChannelLongPress(e, channel) }}
			>
				<button class="channel-btn" data-abbrev={channel.name.charAt(0).toUpperCase()}>
					<span class="hash voice-icon" aria-hidden="true">
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
					</span>
					<span class="voice-channel-name">{channel.name}</span>
					<span class="voice-inline-count">{members.length}</span>
				</button>
				<div class="channel-actions">
					<div class="voice-occupancy" title={`${members.length} in voice`}>
						<span class="voice-count">
							<svg class="voice-count-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
							{members.length}
						</span>
						<div class="voice-avatars">
							{#each members.slice(0, 3) as member}
								{#if member.profilePicture}
									<img class="voice-avatar" class:speaking={isMemberSpeaking(member)} src={member.profilePicture} alt={avatarTitle(member.username)} title={avatarTitle(member.username)} />
								{:else}
									<span class="voice-avatar voice-avatar-fallback" class:speaking={isMemberSpeaking(member)} title={avatarTitle(member.username)}>{(member.username || '?').charAt(0).toUpperCase()}</span>
								{/if}
							{/each}
						</div>
					</div>
				</div>
			</div>
			{#if members.length > 0}
				<div class="voice-member-list">
					{#each getVisibleVoiceMembers(members) as member (member.userId)}
						<div
							class="voice-member-item"
							class:speaking={isMemberSpeaking(member)}
							in:fly={{ y: -6, duration: 160, opacity: 0.2 }}
							out:fly={{ y: -4, duration: 130, opacity: 0.2 }}
						>
							{#if member.profilePicture}
								<img class="voice-member-avatar" class:speaking={isMemberSpeaking(member)} src={member.profilePicture} alt={avatarTitle(member.username)} />
							{:else}
								<span class="voice-member-avatar voice-avatar-fallback" class:speaking={isMemberSpeaking(member)}>{(member.username || '?').charAt(0).toUpperCase()}</span>
							{/if}
							<span class="voice-member-name">{getMemberLabel(member)}</span>
							{#if isMemberSpeaking(member)}
								<span class="voice-speaking-pill">Speaking</span>
							{/if}
						</div>
					{/each}
					{#if members.length > VOICE_MEMBER_RENDER_LIMIT}
						<div class="voice-member-overflow">+{members.length - VOICE_MEMBER_RENDER_LIMIT} more</div>
					{/if}
				</div>
			{/if}
			{#each breakoutChannelsByParent[channel.id] || [] as breakout (breakout.id)}
				{@const breakoutMembers = getVoiceMembers(breakout.id)}
				<div
					class="channel-item voice-channel-item breakout-channel-item"
					class:active={isConnectedToVoice(breakout.id)}
					on:click={() => handleVoiceChannelClick(breakout.id)}
					on:contextmenu={(e) => handleChannelRightClick(e, breakout)}
					use:longpress={{ onLongPress: (e) => handleChannelLongPress(e, breakout) }}
				>
					<button class="channel-btn" data-abbrev={breakout.name.charAt(0).toUpperCase()}>
						<span class="breakout-prefix" aria-hidden="true">&gt;</span>
						<span class="voice-channel-name">{breakout.name}</span>
						<span class="voice-inline-count">{breakoutMembers.length}</span>
					</button>
					<div class="channel-actions">
						<div class="voice-occupancy" title={`${breakoutMembers.length} in voice`}>
							<span class="voice-count">
								<svg class="voice-count-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
								{breakoutMembers.length}
							</span>
							<div class="voice-avatars">
								{#each breakoutMembers.slice(0, 3) as member}
									{#if member.profilePicture}
										<img class="voice-avatar" class:speaking={isMemberSpeaking(member)} src={member.profilePicture} alt={avatarTitle(member.username)} title={avatarTitle(member.username)} />
									{:else}
										<span class="voice-avatar voice-avatar-fallback" class:speaking={isMemberSpeaking(member)} title={avatarTitle(member.username)}>{(member.username || '?').charAt(0).toUpperCase()}</span>
									{/if}
								{/each}
							</div>
						</div>
					</div>
				</div>
				{#if breakoutMembers.length > 0}
					<div class="voice-member-list breakout-member-list">
						{#each getVisibleVoiceMembers(breakoutMembers) as member (member.userId)}
							<div
								class="voice-member-item"
								class:speaking={isMemberSpeaking(member)}
								in:fly={{ y: -6, duration: 160, opacity: 0.2 }}
								out:fly={{ y: -4, duration: 130, opacity: 0.2 }}
							>
								{#if member.profilePicture}
									<img class="voice-member-avatar" class:speaking={isMemberSpeaking(member)} src={member.profilePicture} alt={avatarTitle(member.username)} />
								{:else}
									<span class="voice-member-avatar voice-avatar-fallback" class:speaking={isMemberSpeaking(member)}>{(member.username || '?').charAt(0).toUpperCase()}</span>
								{/if}
								<span class="voice-member-name">{getMemberLabel(member)}</span>
								{#if isMemberSpeaking(member)}
									<span class="voice-speaking-pill">Speaking</span>
								{/if}
							</div>
						{/each}
						{#if breakoutMembers.length > VOICE_MEMBER_RENDER_LIMIT}
							<div class="voice-member-overflow">+{breakoutMembers.length - VOICE_MEMBER_RENDER_LIMIT} more</div>
						{/if}
					</div>
				{/if}
			{/each}
		{/each}
		{/if}
	</div>

	<ContextMenu
		open={showContextMenu && !!contextMenuChannel}
		x={contextMenuPosition.x}
		y={contextMenuPosition.y}
		items={channelMenuItems}
		ariaLabel="Channel actions"
		headerLabel={contextMenuChannel ? `#${contextMenuChannel.name}` : null}
		on:close={closeContextMenu}
	/>

	{#if $callMode === 'channel' && $activeVoiceChannelId && !isCompactSidebar}
		<div class="voice-usercard">
			<button
				type="button"
				class="voice-usercard-header"
				on:click={() => (showVoiceDebugDetails = !showVoiceDebugDetails)}
				aria-expanded={showVoiceDebugDetails}
			>
				<div class="voice-usercard-title">
					<span class="voice-online-dot"></span>
					<div>
						<strong>Voice Connected</strong>
						<small>{getCurrentVoiceChannelName()} / {$callConnectionState}</small>
					</div>
				</div>
				<span class="voice-chevron">{showVoiceDebugDetails ? 'v' : '>'}</span>
			</button>

			{#if showVoiceDebugDetails}
				<div class="voice-usercard-debug">
					<div><span>Ping</span><strong>{formatDiag($callConnectionDiagnostics.pingMs, 'ms')}</strong></div>
					<div><span>Jitter</span><strong>{formatDiag($callConnectionDiagnostics.jitterMs, 'ms')}</strong></div>
					<div><span>In Loss</span><strong>{formatDiag($callConnectionDiagnostics.inboundPacketLossPct, '%')}</strong></div>
					<div><span>Out Loss</span><strong>{formatDiag($callConnectionDiagnostics.outboundPacketLossPct, '%')}</strong></div>
					<div><span>In Rate</span><strong>{formatDiag($callConnectionDiagnostics.inboundKbps, 'kbps')}</strong></div>
					<div><span>Out Rate</span><strong>{formatDiag($callConnectionDiagnostics.outboundKbps, 'kbps')}</strong></div>
					<div><span>Transport</span><strong>{$callTransportState.activeTransport.toUpperCase()}</strong></div>
					<div><span>Participants</span><strong>{1 + $activeCalls.length}</strong></div>
				</div>
			{/if}

			<div class="voice-usercard-actions">
				<button class:active={$callMuted} on:click={toggleMute} title={$callMuted ? 'Unmute' : 'Mute'}>Mic</button>
				<button class:active={$callDeafened} on:click={toggleDeafen} title={$callDeafened ? 'Undeafen' : 'Deafen'}>Headset</button>
				<button class:active={!$isVideoOff} on:click={handleToggleVideoInSidebar} title={$isVideoOff ? 'Turn on camera' : 'Turn off camera'}>Camera</button>
				<button class="leave-btn" on:click={handleLeaveActiveVoiceChannel}>Leave</button>
			</div>

			<div class="voice-route-controls">
				<label for="voice-transmit-mode">Transmit</label>
				<select id="voice-transmit-mode" on:change={handleTransmitModeChange} value={$voiceTransmitMode}>
					<option value="primary">Primary channel</option>
					<option value="all-listening">All listening channels</option>
				</select>
			</div>

			<div class="voice-listen-controls">
				<div class="voice-listen-title">Listen In</div>
				<div class="voice-listen-list">
					{#each voiceChannels as voiceChannel (voiceChannel.id)}
						<button
							type="button"
							class="voice-listen-chip"
							class:active={isListeningToChannel(voiceChannel.id)}
							class:locked={voiceChannel.id === $activeVoiceChannelId}
							on:click={() => handleToggleListenChannel(voiceChannel.id)}
							title={voiceChannel.id === $activeVoiceChannelId ? 'Primary voice channel' : isListeningToChannel(voiceChannel.id) ? 'Stop listening' : 'Start listening'}
						>
							{voiceChannel.name}
						</button>
					{/each}
				</div>
			</div>
		</div>
	{/if}

	{#if $currentUser}
		<div class="profile-card">
			<div class="profile-info">
				<button class="avatar-container" on:click={() => showSettings = true}>
					{#if $currentUser.profilePicture}
						<img src={$currentUser.profilePicture} alt={$currentUser.username} class="avatar" />
					{:else}
						<div class="avatar-placeholder" style="background-color: {$currentUser.color}">
							{$currentUser.username.charAt(0).toUpperCase()}
						</div>
					{/if}
					<div class="status-indicator" class:online={$currentUser.status === 'active'} class:away={$currentUser.status === 'away'} class:busy={$currentUser.status === 'busy'}></div>
				</button>
				<div class="user-details">
					<!-- svelte-ignore a11y-click-events-have-key-events -->
					<!-- svelte-ignore a11y-no-static-element-interactions -->
					<div
						class="username"
						role="button"
						tabindex="0"
						on:click={toggleStatusPopup}
						on:keydown={(event) => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault();
								toggleStatusPopup();
							}
						}}
					>
						<span class="username-text">{$currentUser.username}</span>
						<span class="self-role-badge">{currentUserRoleLabel}</span>
					</div>
					<div class="user-tag">{$currentUser.handle ? `@${$currentUser.handle}` : `#${$currentUser.id.slice(-4)}`}</div>
				</div>
			</div>

			{#if showStatusPopup}
				<div class="status-popup">
					<button class="status-option active" on:click={() => changeStatus('active')}>
						<span class="status-dot" style="background-color: var(--status-online)"></span>
						Active
					</button>
					<button class="status-option away" on:click={() => changeStatus('away')}>
						<span class="status-dot" style="background-color: var(--status-away)"></span>
						Away
					</button>
					<button class="status-option busy" on:click={() => changeStatus('busy')}>
						<span class="status-dot" style="background-color: var(--status-busy)"></span>
						Busy
					</button>
				</div>
			{/if}
			<div class="profile-controls">
				<button
					class="control-btn"
					class:active={$callMuted}
					on:click={toggleMute}
					title={$callMuted ? 'Unmute' : 'Mute'}
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						{#if $callMuted}
							<line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12m14 0a7 7 0 0 1-13.46 3.4"></path><path d="M12 19c3.314 0 6-2.686 6-6v-3m0-6h.01M6 9a6 6 0 0 0 11.13 3.13"></path>
						{:else}
							<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line>
						{/if}
					</svg>
				</button>
				<button
					class="control-btn"
					class:active={$callDeafened}
					on:click={toggleDeafen}
					title={$callDeafened ? 'Undeafen' : 'Deafen'}
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						{#if $callDeafened}
							<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line>
						{:else}
							<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
						{/if}
					</svg>
				</button>
				{#if sidebarWidth >= 170}
					<button
						class="control-btn"
						on:click={() => showSettings = true}
						title="User Settings"
					>
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
					</button>
				{/if}
			</div>
		</div>
	{/if}
</div>

{#if showSettings}
	<Settings bind:isOpen={showSettings} on:logout={handleLogout} />
{/if}

<ConfirmDialog
	isOpen={showDeleteConfirm}
	title="Delete Channel"
	message="Delete channel #{channelToDelete}? This action cannot be undone."
	confirmText="Delete"
	variant="danger"
	onConfirm={confirmDeleteChannel}
	onCancel={() => showDeleteConfirm = false}
/>

<PinnedMessagesModal bind:isOpen={showPinnedModal} channelId={selectedChannelForPinned} />

<!-- Channel Settings Modal -->
{#if showChannelSettingsModal && selectedChannelForSettings}
<div
	class="modal-overlay"
	role="button"
	tabindex="0"
	on:click={() => showChannelSettingsModal = false}
	on:keydown={(event) => {
		if (isEditableTarget(event.target)) return;
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			showChannelSettingsModal = false;
		}
	}}
>
	<div
		class="modal-content"
		role="button"
		tabindex="0"
		on:click|stopPropagation
		on:keydown|stopPropagation={(event) => {
			if (isEditableTarget(event.target)) return;
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
			}
		}}
	>
			<div class="modal-header">
				<h2><svg class="modal-title-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg> Channel Settings</h2>
				<button class="close-btn" on:click={() => showChannelSettingsModal = false}>&times;</button>
			</div>
			<div class="modal-body">
				<div class="setting-section">
					<h3>Channel: #{selectedChannelForSettings.name}</h3>

					<div class="setting-group">
						<label>Description</label>
						<input
							type="text"
							bind:value={tempDescription}
							placeholder="Add a channel description..."
							class="description-input"
							maxlength="200"
						/>
						<button class="save-description-btn" on:click={handleSaveChannelSettings}>
							Save Settings
						</button>
					</div>

					<div class="setting-group">
						<label>Auto-Delete Messages</label>
						<p class="setting-description">Automatically delete messages after a set period of time</p>

						<div class="auto-delete-options">
							<button
								class="auto-delete-btn"
								class:active={!selectedChannelForSettings.autoDeleteAfter}
								on:click={() => handleUpdateAutoDelete(null)}
							>
								Disabled
							</button>
							<button
								class="auto-delete-btn"
								class:active={selectedChannelForSettings.autoDeleteAfter === '5s'}
								on:click={() => handleUpdateAutoDelete('5s')}
							>
								5 Seconds
							</button>
							<button
								class="auto-delete-btn"
								class:active={selectedChannelForSettings.autoDeleteAfter === '1h'}
								on:click={() => handleUpdateAutoDelete('1h')}
							>
								1 Hour
							</button>
							<button
								class="auto-delete-btn"
								class:active={selectedChannelForSettings.autoDeleteAfter === '6h'}
								on:click={() => handleUpdateAutoDelete('6h')}
							>
								6 Hours
							</button>
							<button
								class="auto-delete-btn"
								class:active={selectedChannelForSettings.autoDeleteAfter === '12h'}
								on:click={() => handleUpdateAutoDelete('12h')}
							>
								12 Hours
							</button>
							<button
								class="auto-delete-btn"
								class:active={selectedChannelForSettings.autoDeleteAfter === '24h'}
								on:click={() => handleUpdateAutoDelete('24h')}
							>
								1 Day
							</button>
							<button
								class="auto-delete-btn"
								class:active={selectedChannelForSettings.autoDeleteAfter === '3d'}
								on:click={() => handleUpdateAutoDelete('3d')}
							>
								3 Days
							</button>
							<button
								class="auto-delete-btn"
								class:active={selectedChannelForSettings.autoDeleteAfter === '7d'}
								on:click={() => handleUpdateAutoDelete('7d')}
							>
								7 Days
							</button>
							<button
								class="auto-delete-btn"
								class:active={selectedChannelForSettings.autoDeleteAfter === '14d'}
								on:click={() => handleUpdateAutoDelete('14d')}
							>
								14 Days
							</button>
							<button
								class="auto-delete-btn"
								class:active={selectedChannelForSettings.autoDeleteAfter === '30d'}
								on:click={() => handleUpdateAutoDelete('30d')}
							>
								30 Days
							</button>
						</div>
					</div>

					<!-- Only show persistence option for non-DM channels (privacy protection) -->
					{#if selectedChannelForSettings.type !== 'dm'}
						<div class="setting-group">
							<label class="setting-label">
								<input
									type="checkbox"
									bind:checked={tempPersistMessages}
									class="setting-checkbox"
								/>
								Persist Messages Locally
							</label>
							<p class="setting-description">
								Save messages to your browser's local storage so you can see them after the server restarts.
								Each client controls their own message history.
							</p>
						</div>
					{/if}
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	.expand-btn {
		position: fixed;
		left: 0;
		top: 50%;
		transform: translateY(-50%);
		width: 30px;
		height: 30px;
		background: var(--bg-tertiary);
		border: 1px solid var(--border);
		border-right: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 1.5rem;
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
		transition: all 0.2s;
		padding: 0;
		opacity: 0;
		pointer-events: auto;
	}

	.expand-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
		opacity: 1;
	}

	.channel-sidebar {
		background: var(--bg-tertiary);
		display: flex;
		flex-direction: column;
		height: 100dvh;
		overflow: hidden;
		transition: width 0.2s ease;
		position: relative;
		z-index: 50;
	}

	/* Compact mode: show only letters */
	.channel-sidebar.compact .logo-img {
		height: 24px;
		width: auto;
	}

	.channel-sidebar.compact .sidebar-header,
	.channel-sidebar.compact .profile-card .user-details,
	.channel-sidebar.compact .profile-controls,
	.channel-sidebar.compact .status-popup,
	.channel-sidebar.compact .create-channel {
		display: none;
	}

	.channel-sidebar.compact .channel-btn {
		font-size: 0;
		justify-content: center;
		position: relative;
		width: 100%;
		height: 100%;
	}

	.channel-sidebar.compact .channel-btn::after {
		content: attr(data-abbrev);
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-secondary);
	}

	.channel-sidebar.compact .channel-item.active .channel-btn::after {
		color: var(--text-primary);
	}

	.channel-sidebar.compact .channel-btn .hash,
	.channel-sidebar.compact .channel-btn .group-icon {
		font-size: 1rem;
		margin: 0;
	}

	.channel-sidebar.compact .channel-item {
		justify-content: center;
		padding: 0.25rem;
	}

	.channel-sidebar.compact .section-toggle {
		justify-content: center;
		padding: 0.45rem 0.25rem;
	}

	.channel-sidebar.compact .section-toggle-label,
	.channel-sidebar.compact .section-count {
		display: none;
	}

	.channel-sidebar.compact .channel-actions {
		display: none;
	}

	.channel-sidebar.compact .voice-occupancy,
	.channel-sidebar.compact .voice-inline-count,
	.channel-sidebar.compact .voice-member-list,
	.channel-sidebar.compact .thread-list {
		display: none;
	}

	.top-section {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--border);
		height: 52px;
		gap: 0.5rem;
		box-sizing: border-box;
	}

	.logo {
		flex: 1;
		display: flex;
		align-items: center;
	}

	.logo-img {
		height: 32px;
		width: auto;
		filter: drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.3));
		transition: filter 0.3s ease;
	}

	/* Invert logo for dark themes only */
	:root[data-theme="dark"] .logo-img,
	:root[data-theme="midnight-blue"] .logo-img,
	:root[data-theme="vscode-high-contrast"] .logo-img {
		filter: invert(1) drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.3));
	}

	.collapse-btn {
		background: transparent;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 1.5rem;
		padding: 0.5rem;
		transition: all 0.2s;
		min-width: 36px;
		min-height: 36px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.collapse-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.settings-btn {
		background: transparent;
		border: none;
		font-size: 1.5rem;
		cursor: pointer;
		color: var(--text-secondary);
		padding: 0.5rem;
		transition: all 0.2s;
		border-radius: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.settings-btn svg {
		width: 18px;
		height: 18px;
		stroke: currentColor;
		stroke-width: 2;
	}

	.settings-btn:hover {
		color: var(--text-primary);
		background: var(--bg-secondary);
		box-shadow: inset 0 0 6px rgba(255, 255, 255, 0.1);
	}

	.sidebar-header {
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--border);
		display: flex;
		justify-content: space-between;
		align-items: center;
		height: 58px;
		position: relative;
	}

	.sidebar-header h3 {
		font-size: var(--text-base);
		font-weight: 600;
		text-transform: uppercase;
		color: var(--text-secondary);
		margin: 0;
		flex: 1;
	}

	.header-buttons {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}

	.compact-settings-btn {
		width: 32px;
		height: 32px;
		border-radius: 4px;
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
		opacity: 0.7;
		padding: 0;
	}

	.compact-settings-btn svg {
		width: 18px;
		height: 18px;
		stroke: currentColor;
		stroke-width: 2;
	}

	.compact-settings-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
		opacity: 1;
		box-shadow: inset 0 0 6px rgba(255, 255, 255, 0.1);
	}

	.create-channel {
		padding: 0.5rem 0.5rem;
		border-bottom: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.create-channel input {
		width: 100%;
		padding: 0.5rem;
		font-size: var(--text-base);
		border: none;
		border-radius: 0;
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.create-channel select {
		width: 100%;
		padding: 0.5rem;
		font-size: var(--text-base);
		border: none;
		border-radius: 0;
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.create-channel button {
		padding: 0.5rem;
		font-size: var(--text-base);
		background: var(--accent);
		color: var(--text-primary);
		border: none;
		border-radius: 0;
		cursor: pointer;
		width: 100%;
	}

	.create-channel-hint {
		margin: 0;
		font-size: 0.72rem;
		color: var(--text-secondary);
	}

	.channel-list {
		display: flex;
		flex-direction: column;
		flex: 1;
		overflow-y: auto;
		padding: 0;
	}

	.channel-item {
		display: flex;
		align-items: center;
		padding: 0 0.375rem;
		position: relative;
	}

	.channel-item.active {
		background: var(--bg-secondary);
	}

	.channel-btn {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4rem 0.5rem;
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		text-align: left;
		font-size: var(--channel-btn-font-size);
		border-radius: 0;
		transition: all 0.2s;
		min-width: 0; /* Allows text to shrink and ellipsis */
		height: fit-content;
		justify-content: flex-start;
	}

	.channel-item.active .channel-btn {
		color: var(--text-primary);
	}

	.channel-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.hash {
		color: var(--text-secondary);
		font-weight: 600;
	}

	.voice-icon svg {
		width: 16px;
		height: 16px;
		display: block;
	}

	.group-icon {
		color: var(--text-secondary);
		font-weight: 600;
		width: 18px;
		height: 18px;
		stroke: currentColor;
		stroke-width: 2;
	}

	.section-toggle {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		width: 100%;
		background: transparent;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 0.75rem 1rem 0.35rem;
		text-transform: uppercase;
		font-size: 0.75rem;
		font-weight: 700;
		letter-spacing: 0.04em;
	}

	.section-heading-row {
		display: flex;
		align-items: center;
		padding-right: 0.5rem;
	}

	.section-add-btn {
		width: 24px;
		height: 24px;
		border-radius: 6px;
		border: 1px solid transparent;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 0.95rem;
		font-weight: 700;
		opacity: 0.45;
		transition: all 0.18s ease;
	}

	.section-heading-row:hover .section-add-btn,
	.section-add-btn.active {
		opacity: 1;
		color: var(--text-primary);
		background: rgba(var(--border-rgb), 0.18);
		border-color: rgba(var(--border-rgb), 0.32);
	}

	.section-toggle:hover {
		color: var(--text-primary);
	}

	.section-chevron {
		display: inline-block;
		font-size: 0.72rem;
		transform-origin: center;
		transition: transform 0.18s ease;
	}

	.section-toggle[aria-expanded='true'] .section-chevron {
		transform: rotate(90deg);
	}

	.section-toggle-label {
		flex: 1;
		text-align: left;
	}

	.section-count {
		font-size: 0.68rem;
		opacity: 0.75;
	}

	.section-header {
		padding: 1rem 1rem 0.5rem 1rem;
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		color: var(--text-secondary);
		margin-top: 0.5rem;
	}

	.section-subheader {
		padding-top: 0.5rem;
		margin-top: 0.15rem;
	}

	.channel-actions {
		display: flex;
		align-items: center;
		gap: 0.2rem;
		height: fit-content;
	}

	.voice-occupancy {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.7rem;
		color: var(--text-secondary);
	}

	.voice-count {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		font-weight: 600;
	}

	.voice-count-icon {
		width: 13px;
		height: 13px;
	}

	.voice-channel-name {
		min-width: 0;
		flex: 1;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.voice-inline-count {
		margin-left: auto;
		font-size: 0.68rem;
		color: var(--text-secondary);
		background: rgba(var(--border-rgb), var(--opacity-light));
		padding: 0.05rem 0.35rem;
		border-radius: 999px;
	}

	.thread-list {
		margin: -0.05rem 0 0.2rem 1.35rem;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}

	.thread-btn {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		background: transparent;
		border: none;
		color: var(--text-secondary);
		font-size: 0.72rem;
		padding: 0.14rem 0.2rem;
		border-radius: 6px;
		cursor: pointer;
		min-width: 0;
		text-align: left;
	}

	.thread-btn:hover,
	.thread-btn.active {
		background: rgba(var(--border-rgb), var(--opacity-light));
		color: var(--text-primary);
	}

	.thread-prefix {
		font-size: 0.72rem;
		color: var(--text-muted);
	}

	.thread-name {
		min-width: 0;
		flex: 1;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.thread-privacy {
		font-size: 0.62rem;
		color: var(--text-secondary);
		border: 1px solid rgba(var(--border-rgb), var(--opacity-medium));
		border-radius: 999px;
		padding: 0.02rem 0.35rem;
	}

	.voice-avatars {
		display: flex;
		align-items: center;
		margin-left: 0.1rem;
	}

	.voice-avatar {
		width: 16px;
		height: 16px;
		border-radius: 999px;
		margin-left: -4px;
		border: 1px solid var(--bg-tertiary);
		object-fit: cover;
		background: var(--bg-secondary);
	}

	.voice-avatar-fallback {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 0.6rem;
		font-weight: 700;
		color: var(--text-primary);
	}

	.text-channel-actions .settings-btn {
		opacity: 0;
		pointer-events: none;
	}

	.channel-item:hover .text-channel-actions .settings-btn,
	.channel-item.active .text-channel-actions .settings-btn {
		opacity: 1;
		pointer-events: auto;
	}

	.voice-channel-item .channel-btn {
		padding-top: 0.3rem;
		padding-bottom: 0.3rem;
	}

	.breakout-channel-item {
		margin-left: 1rem;
	}

	.breakout-prefix {
		color: var(--text-muted);
		font-size: 0.72rem;
	}

	.voice-member-list {
		margin: -0.1rem 0 0.25rem 1.9rem;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.breakout-member-list {
		margin-left: 2.7rem;
	}

	.voice-member-item {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		color: var(--text-secondary);
		font-size: 0.72rem;
	}

	.voice-member-overflow {
		color: var(--text-muted);
		font-size: 0.68rem;
		padding-left: 0.3rem;
	}

	.voice-member-avatar {
		width: 18px;
		height: 18px;
		border-radius: 999px;
		object-fit: cover;
		border: 1px solid var(--bg-tertiary);
		background: var(--bg-secondary);
	}

	.voice-avatar.speaking,
	.voice-member-avatar.speaking {
		border-color: #22c55e;
		box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.35);
		animation: voice-ring-pulse 1.1s ease-in-out infinite;
	}

	.voice-member-name {
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.voice-member-item.speaking .voice-member-name {
		color: var(--text-primary);
	}

	.voice-speaking-pill {
		margin-left: auto;
		font-size: 0.62rem;
		font-weight: 700;
		color: #16a34a;
		background: rgba(22, 163, 74, 0.14);
		border: 1px solid rgba(22, 163, 74, 0.3);
		border-radius: 999px;
		padding: 0.05rem 0.35rem;
	}

	@keyframes voice-ring-pulse {
		0% {
			box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.55);
		}
		100% {
			box-shadow: 0 0 0 5px rgba(34, 197, 94, 0);
		}
	}

	.voice-channel-item .voice-occupancy {
		opacity: 0.7;
	}

	.voice-channel-item .voice-avatars {
		max-width: 0;
		opacity: 0;
		overflow: hidden;
		margin-left: 0;
		transition: max-width 0.16s ease, opacity 0.16s ease, margin-left 0.16s ease;
	}

	.voice-channel-item:hover .voice-avatars,
	.voice-channel-item.active .voice-avatars {
		max-width: 72px;
		opacity: 1;
		margin-left: 0.15rem;
	}

	.voice-usercard {
		margin: 0.6rem;
		padding: 0.55rem;
		border-radius: 10px;
		background: var(--bg-secondary);
		border: 1px solid rgba(var(--border-rgb), var(--opacity-light));
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.voice-usercard-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		background: transparent;
		border: none;
		color: var(--text-primary);
		padding: 0;
		cursor: pointer;
	}

	.voice-usercard-title {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		text-align: left;
	}

	.voice-usercard-title small {
		display: block;
		color: var(--text-secondary);
		font-size: 0.72rem;
	}

	.voice-online-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #22c55e;
		box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.22);
	}

	.voice-chevron {
		color: var(--text-secondary);
		font-size: 0.78rem;
	}

	.voice-usercard-debug {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.3rem 0.6rem;
		background: rgba(var(--border-rgb), 0.12);
		border-radius: 8px;
		padding: 0.5rem;
		font-size: 0.7rem;
	}

	.voice-usercard-debug div {
		display: flex;
		justify-content: space-between;
		gap: 0.4rem;
	}

	.voice-usercard-debug span {
		color: var(--text-secondary);
	}

	.voice-usercard-debug strong {
		color: var(--text-primary);
	}

	.voice-usercard-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}

	.voice-usercard-actions button {
		background: rgba(var(--border-rgb), 0.2);
		border: 1px solid rgba(var(--border-rgb), 0.4);
		color: var(--text-primary);
		border-radius: 999px;
		padding: 0.25rem 0.55rem;
		font-size: 0.72rem;
		cursor: pointer;
	}

	.voice-usercard-actions button.active {
		background: color-mix(in srgb, var(--accent) 26%, transparent);
		border-color: color-mix(in srgb, var(--accent) 58%, transparent);
	}

	.voice-usercard-actions .leave-btn {
		background: rgba(239, 68, 68, 0.15);
		border-color: rgba(239, 68, 68, 0.45);
		color: #fda4af;
	}

	.voice-route-controls {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.45rem;
		font-size: 0.72rem;
	}

	.voice-route-controls label {
		color: var(--text-secondary);
	}

	.voice-route-controls select {
		flex: 1;
		min-width: 0;
		background: rgba(var(--border-rgb), 0.16);
		border: 1px solid rgba(var(--border-rgb), 0.35);
		color: var(--text-primary);
		border-radius: 8px;
		padding: 0.2rem 0.35rem;
		font-size: 0.72rem;
	}

	.voice-listen-controls {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.voice-listen-title {
		font-size: 0.68rem;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-secondary);
	}

	.voice-listen-list {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}

	.voice-listen-chip {
		background: rgba(var(--border-rgb), 0.15);
		border: 1px solid rgba(var(--border-rgb), 0.35);
		color: var(--text-secondary);
		border-radius: 999px;
		padding: 0.18rem 0.48rem;
		font-size: 0.68rem;
		line-height: 1.2;
		cursor: pointer;
	}

	.voice-listen-chip.active {
		color: var(--text-primary);
		background: color-mix(in srgb, var(--accent) 24%, transparent);
		border-color: color-mix(in srgb, var(--accent) 52%, transparent);
	}

	.voice-listen-chip.locked {
		opacity: 0.92;
		cursor: default;
	}

	.pin-btn {
		opacity: 0;
		width: 24px;
		height: 24px;
		border-radius: 4px;
		background: none;
		border: none;
		color: var(--text-secondary);
		font-size: 1rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
		padding: 0;
	}

	.pin-btn svg,
	.settings-btn svg {
		width: 16px;
		height: 16px;
		stroke: currentColor;
		stroke-width: 2;
	}

	.channel-item:hover .pin-btn {
		opacity: 1;
	}

	.pin-btn:hover {
		background: var(--pinned-border);
		color: var(--text-primary);
	}

	.profile-card {
		background: var(--bg-tertiary);
		border-top: 1px solid var(--border);
		padding: 0.625rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		height: 52px;
		position: relative;
	}

	.profile-info {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 80px;
		overflow: hidden;
	}

	.avatar-container {
		position: relative;
		flex-shrink: 0;
		cursor: pointer;
		background: transparent;
		border: none;
		padding: 0;
		border-radius: 50%;
		transition: opacity 0.2s;
	}

	.avatar-container:hover {
		opacity: 0.8;
	}

	.avatar,
	.avatar-placeholder {
		width: 32px;
	}

	.avatar-placeholder {
		color: var(--text-primary);
		font-weight: 600;
		font-size: var(--text-base);
	}

	.status-indicator {
		position: absolute;
		bottom: 0;
		right: 0;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		border: none;
		background: var(--status-offline);
	}

	.status-indicator.online {
		background: var(--status-online);
	}

	.status-indicator.away {
		background: var(--status-away);
	}

	.status-indicator.busy {
		background: var(--status-busy);
	}

	.user-details {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.username {
		font-size: var(--text-base);
		font-weight: 600;
		color: var(--text-primary);
		display: flex;
		align-items: center;
		gap: 0.35rem;
		cursor: pointer;
		transition: color 0.2s;
		min-width: 0;
	}

	.username-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.self-role-badge {
		font-size: 10px;
		line-height: 1;
		padding: 0.15rem 0.35rem;
		border-radius: 999px;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		color: var(--text-secondary);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.02em;
		flex-shrink: 0;
	}

	.username:hover {
		color: var(--accent);
	}

	.status-popup {
		position: absolute;
		bottom: 100%;
		left: 0.625rem;
		margin-bottom: 8px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		background: var(--bg-secondary);
		border-radius: 8px;
		padding: 6px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
		z-index: 100;
		min-width: 140px;
	}

	.status-option {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 12px;
		background: transparent;
		border: none;
		border-radius: 6px;
		color: var(--text-primary);
		cursor: pointer;
		transition: background 0.2s;
		text-align: left;
		font-size: var(--text-base);
	}

	.status-option:hover {
		background: var(--bg-hover);
	}

	.status-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.user-tag {
		font-size: var(--text-xs);
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.profile-controls {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex-shrink: 1;
	}

	.control-btn {
		width: 28px;
		height: 28px;
		border-radius: 4px;
		background: transparent;
		border: none;
		color: var(--text-secondary);
		font-size: 1rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
		flex-shrink: 0;
		padding: 0;
	}

	.control-btn svg {
		width: 18px;
		height: 18px;
		stroke: currentColor;
		stroke-width: 2;
	}

	.control-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
		box-shadow: inset 0 0 6px rgba(255, 255, 255, 0.1);
	}

	.control-btn.active {
		background: var(--color-danger);
		color: var(--text-primary);
	}

	.control-btn.active:hover {
		box-shadow: inset 0 0 6px rgba(0, 0, 0, 0.2);
	}

	/* Auto-delete/Timer indicator - redder highlight */
	.channel-item.has-timer {
		background: rgba(255, 77, 77, var(--opacity-subtle));
		border-left: 3px solid var(--color-danger);
	}

	.channel-item.has-timer:hover {
		background: rgba(255, 77, 77, var(--opacity-light));
	}

	.channel-item.has-timer.active {
		background: rgba(255, 77, 77, var(--opacity-medium));
	}

	/* Compact mode: maintain red indicator */
	.channel-sidebar.compact .channel-item.has-timer {
		border-radius: 0;
	}

	/* Channel Settings Modal */
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background-color: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}

	.modal-content {
		background: var(--modal-bg);
		border-radius: 8px;
		max-width: 600px;
		width: 90%;
		max-height: 80vh;
		overflow-y: auto;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1.5rem;
		border-bottom: 1px solid var(--border);
	}

	.modal-header h2 {
		margin: 0;
		font-size: var(--text-xl);
		color: var(--text-primary);
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}

	.modal-title-icon {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
	}

	.close-btn {
		background: none;
		border: none;
		font-size: 1.5rem;
		color: var(--text-secondary);
		cursor: pointer;
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		transition: all 0.2s;
	}

	.close-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.modal-body {
		padding: 1.5rem;
	}

	.setting-section h3 {
		margin: 0 0 1rem 0;
		color: var(--text-primary);
		font-size: var(--text-lg);
	}

	.setting-group {
		margin-top: 1.5rem;
	}

	.setting-group label {
		display: block;
		font-weight: 600;
		color: var(--text-primary);
		margin-bottom: 0.5rem;
	}

	.setting-description {
		color: var(--text-secondary);
		font-size: var(--text-base);
		margin-bottom: 1rem;
	}

	.auto-delete-options {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
		gap: 0.5rem;
	}

	.auto-delete-btn {
		padding: 0.75rem 1rem;
		background: var(--bg-secondary);
		border: 2px solid transparent;
		border-radius: 6px;
		color: var(--text-primary);
		font-size: var(--text-base);
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
	}

	.auto-delete-btn:hover {
		background: var(--bg-tertiary);
		border-color: var(--accent);
	}

	.auto-delete-btn.active {
		background: var(--accent);
		color: var(--text-primary);
		border-color: var(--accent);
	}

	.description-input {
		width: 100%;
		padding: 0.75rem;
		border-radius: 6px;
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: var(--text-base);
		box-sizing: border-box;
	}

	.save-description-btn {
		padding: 0.625rem 1.25rem;
		background: var(--accent);
		border: none;
		border-radius: 6px;
		color: white;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s;
		margin-top: 0.5rem;
	}

	.save-description-btn:hover {
		opacity: 0.9;
	}

	.settings-btn {
		background: transparent;
		border: none;
		color: var(--text-muted);
		font-size: var(--text-base);
		cursor: pointer;
		padding: 0.25rem 0.5rem;
		border-radius: 4px;
		transition: all 0.2s;
		opacity: 0;
	}

	.channel-item:hover .settings-btn {
		opacity: 1;
	}

	.settings-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	/* Unread badge styling */
	.unread-badge {
		background: var(--color-danger);
		color: var(--text-primary);
		font-size: 0.75rem;
		font-weight: bold;
		padding: 2px 6px;
		border-radius: 10px;
		margin-left: auto;
		min-width: 20px;
		text-align: center;
		animation: pulse 2s infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.7; }
	}

	/* Mobile close button - hidden by default */
	.mobile-close-btn {
		display: none;
		background: none;
		border: none;
		font-size: 2rem;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 0;
		line-height: 1;
		min-width: 44px;
		min-height: 44px;
	}

	/* ========== MOBILE STYLES ========== */
	@media (max-width: 768px) {
		.channel-sidebar {
			height: calc(100dvh - 56px);
			max-width: 100%;
			overflow: hidden;
		}

		.mobile-close-btn {
			display: flex;
			align-items: center;
			justify-content: center;
			width: 44px;
			height: 44px;
			min-width: 44px;
			min-height: 44px;
			font-size: 1.5rem;
		}

		.top-section {
			padding: 0.75rem 1rem;
			height: 56px;
		}

		.resize-handle {
			display: none;
		}

		.sidebar-header {
			padding: 0.5rem 0.75rem;
			height: auto;
			min-height: 44px;
		}

		.sidebar-header h3 {
			font-size: 0.8rem;
			letter-spacing: 0.05em;
		}

		/* Touch-friendly section add button */
		.section-add-btn {
			width: 44px;
			height: 44px;
			font-size: 1.2rem;
		}

		/* Spacious channel items */
		.channel-item {
			padding: 0.25rem 0.75rem;
		}

		.channel-btn {
			padding: 0.75rem 0.75rem;
			min-height: 52px;
			font-size: 1rem;
			border-radius: 8px;
		}

		/* Hide action buttons by default on mobile — show only on active channel */
		.channel-actions {
			display: none;
		}

		.channel-item.active .channel-actions {
			display: flex;
		}

		.pin-btn,
		.settings-btn {
			min-width: 44px;
			min-height: 44px;
			width: 44px;
			height: 44px;
			padding: 10px;
		}

		.create-channel {
			padding: 0.75rem;
		}

		.create-channel input {
			padding: 0.75rem;
			font-size: 16px;
			min-height: 44px;
			border-radius: 8px;
		}

		.create-channel select {
			padding: 0.75rem;
			font-size: 16px;
			min-height: 44px;
			border-radius: 8px;
		}

		.create-channel button {
			padding: 0.75rem;
			min-height: 44px;
			font-size: 0.9rem;
			border-radius: 8px;
		}

		/* Spacious profile card */
		.profile-card {
			padding: 0.75rem;
			height: auto;
			min-height: 64px;
		}

		.profile-info {
			padding: 0.25rem;
		}

		.avatar-container {
			width: 40px;
			height: 40px;
		}

		.control-btn {
			width: 44px;
			height: 44px;
			font-size: 1.1rem;
		}

		/* Section headers */
		.section-toggle,
		.section-header {
			padding: 0.75rem 0.75rem 0.375rem;
			font-size: 0.8rem;
		}

		.section-count {
			font-size: 0.72rem;
		}

		/* Modal adjustments */
		.modal-content {
			width: 95%;
			max-height: 90vh;
			max-height: 90dvh;
		}

		.modal-header {
			padding: 0.75rem;
		}

		.modal-body {
			padding: 0.75rem;
		}

		.auto-delete-options {
			grid-template-columns: repeat(2, 1fr);
			gap: 0.375rem;
		}

		.auto-delete-btn {
			padding: 0.75rem;
			font-size: 0.875rem;
			min-height: 44px;
		}

	}

	/* Extra small screens */
	@media (max-width: 400px) {
		.channel-item {
			padding: 0.25rem 0.5rem;
		}

		.channel-btn {
			padding: 0.625rem 0.5rem;
			min-height: 48px;
			font-size: 0.9375rem;
		}

		.auto-delete-options {
			grid-template-columns: 1fr 1fr;
			gap: 0.25rem;
		}

		.auto-delete-btn {
			padding: 0.5rem;
			font-size: 0.8rem;
			min-height: 40px;
		}

		.profile-controls {
			gap: 0.25rem;
		}

		.control-btn {
			width: 40px;
			height: 40px;
		}
	}

</style>
