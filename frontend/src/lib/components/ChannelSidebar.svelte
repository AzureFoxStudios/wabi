<script lang="ts">
	import { createEventDispatcher, onDestroy, onMount } from 'svelte';
	import { fly, slide } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import {
		channels,
		currentChannel,
		channelMessages,
		joinChannel,
		createChannel,
		createThread,
		deleteChannel,
		markMessagesAsRead,
		markChannelAsRead,
		currentUser,
		updateChannelSettings,
		channelUnreadCounts,
		updateProfile,
		activeVoiceChannel as socketActiveVoiceChannel,
		voiceChannelMembers,
		joinVoiceChannel,
		leaveVoiceChannel,
		subscribeVoiceChannel,
		unsubscribeVoiceChannel,
		setVoiceTransmitMode,
		createBreakoutRooms,
		closeBreakoutRooms,
		moveUserToVoiceChannel,
		roleDefinitions,
		pinChannel,
		unpinChannel,
		getSocket
	} from '$lib/socket';
	import {
		activeVoiceChannel as callActiveVoiceChannel,
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
		isSharing,
		toggleMute,
		toggleDeafen,
		toggleVideo,
		startScreenShare,
		stopScreenShare,
		speakingUsers
	} from '$lib/calling';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import PinnedMessagesModal from './PinnedMessagesModal.svelte';
	import UserPopout from './UserPopout.svelte';
	import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';
	import type { ContextMenuItem } from '$lib/context-menu/types';
	import type { Channel, Message, VoiceChannelSettings } from '$lib/socket';
	import { longpress } from '$lib/actions/longpress';
	import { layoutStore } from '$lib/layoutStore';
	import { currentSavedServer } from '$lib/savedServers';
	import { resolveServerUrl } from '$lib/serverUrl';
	import {
		FOLLOW_ALERT_LEVEL_LABELS,
		currentServerFollowedChannels,
		cycleChannelFollowAlertLevel,
		toggleChannelFollow
	} from '$lib/following';
	import {
		displayEnhancementSettingsStore,
		isLikelyNsfwChannel,
		toggleMutedChannelId
	} from '$lib/displayEnhancements';
	import {
		clearActiveCustomStatusPreset
	} from '$lib/customStatusPresets';
	import { voiceCallRecordingParticipants } from '$lib/callRecordingPresence';

	const dispatch = createEventDispatcher();

	// Helper function to format badge display
	function formatBadge(count: number): string {
		if (count === 0) return '';
		if (count <= 10) return `+${count}`;
		return '*';
	}

	export let activeView: 'chat' | 'screen' | 'following' = 'chat';

	let newChannelName = '';
	let newChannelDescription = '';
	let newChannelType: 'text' | 'voice' = 'text';
	let showCreateInput = false;
	let showVoiceDebugDetails = false;
	let showDeleteConfirm = false;
	let channelToDelete = '';
	let showPinnedModal = false;
	let selectedChannelForPinned = '';
	let showStatusPopup = false;
	let showChannelSettingsModal = false;
	let selectedChannelForSettings: Channel | null = null;
	let glimpseChannelId: string | null = null;
	let glimpsePopover: HTMLElement | null = null;
	let isTextSectionExpanded = true;
	let isVoiceSectionExpanded = true;
	let voiceDurationMode: 'off' | 'others' | 'all' = 'all';
	let nowMs = Date.now();
	let voiceDurationTicker: ReturnType<typeof setInterval> | null = null;
	let voicePresenceSince = new Map<string, number>();
	let draggedVoiceMember: { userId: string; channelId: string } | null = null;
	let voiceDropTargetChannelId: string | null = null;
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
	$: runtimeActiveVoiceChannelId = $callActiveVoiceChannel?.id || $socketActiveVoiceChannel || null;
	$: connectedVoiceChannelIds = (() => {
		const ids = new Set<string>();
		for (const id of $listeningVoiceChannels) ids.add(id);
		if (runtimeActiveVoiceChannelId) ids.add(runtimeActiveVoiceChannelId);
		return ids;
	})();
	$: primaryVoiceChannelId = (() => {
		return runtimeActiveVoiceChannelId || $listeningVoiceChannels[0] || null;
	})();
	$: currentServerLabel = (() => {
		if ($currentSavedServer?.effectiveName) return $currentSavedServer.effectiveName;
		try {
			return new URL(resolveServerUrl().url).hostname;
		} catch {
			return 'Wabi';
		}
	})();
	$: currentServerBannerUrl = $currentSavedServer?.effectiveBannerUrl || null;
	$: currentServerDescription = $currentSavedServer?.effectiveDescription || resolveServerUrl().url;
	$: followedChannelIds = new Set($currentServerFollowedChannels.map((entry) => entry.channelId));
	$: followedChannelPreferences = new Map(
		$currentServerFollowedChannels.map((entry) => [entry.channelId, entry])
	);
	$: followedUnreadCount = $currentServerFollowedChannels.reduce((sum, entry) => {
		return sum + ($channelUnreadCounts[entry.channelId] || 0);
	}, 0);
	$: glimpseChannelMessages = glimpseChannelId
		? ($channelMessages[glimpseChannelId] || []).slice(-4).reverse()
		: [];

	// Context menu state
	let contextMenuChannel: Channel | null = null;
	let contextMenuPosition = { x: 0, y: 0 };
	let showContextMenu = false;
	let showOwnProfilePopout = false;
	let ownProfilePopoutAnchor: HTMLElement | null = null;

	function toggleSidebar() {
		const current = $layoutStore.channelSidebarWidth;
		layoutStore.channelSidebarWidth.set(current === 0 ? 280 : 0);
	}

	function handleLogout() {
		dispatch('logout');
	}

	function openOwnProfilePopout(event: Event): void {
		if (!$currentUser) return;
		ownProfilePopoutAnchor = event.currentTarget as HTMLElement | null;
		showOwnProfilePopout = true;
		showStatusPopup = false;
	}

	function isChannelLocallyMuted(channelId: string): boolean {
		return $displayEnhancementSettingsStore.mutedChannelIds.includes(channelId);
	}

	function shouldHideChannelFromList(channel: Channel): boolean {
		if (!$displayEnhancementSettingsStore.hideMutedCategoriesEnabled) return false;
		if ($currentChannel === channel.id) return false;
		return isChannelLocallyMuted(channel.id);
	}

	// Separate channels by type
	// Note: DMs are excluded from sidebar - only accessible via UserPanel
	$: textChannels = $channels
		.filter(ch => !ch.type || ch.type === 'public' || ch.type === 'text')
		.filter(ch => !shouldHideChannelFromList(ch))
		.sort((a, b) => {
			if (a.id === 'general') return -1;
			if (b.id === 'general') return 1;
			return a.name.localeCompare(b.name);
		});
	$: groupChannels = $channels.filter(ch => ch.type === 'group').filter(ch => !shouldHideChannelFromList(ch));
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
		.filter(ch => !shouldHideChannelFromList(ch))
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
	$: activeListenChips = voiceChannels.filter(ch =>
		$listeningVoiceChannels.includes(ch.id) || ch.id === runtimeActiveVoiceChannelId
	);
	$: workspaceChannelCount = textChannels.length + groupChannels.length + voiceChannels.length;
	$: totalUnreadNotifications = Object.values($channelUnreadCounts).reduce((sum, value) => {
		return sum + (Number.isFinite(value) ? value : 0);
	}, 0);
	$: canTogglePersistMessages = $currentUser?.highestRole === 'owner';
	$: canManageWatchQueue = $currentUser?.highestRole === 'owner' || $currentUser?.highestRole === 'admin';
	$: canManageVoiceSettings = $currentUser?.highestRole === 'owner' || $currentUser?.highestRole === 'admin';
	$: canModerateVoiceMembers = ['owner', 'admin', 'mod'].includes($currentUser?.highestRole || '');
	$: {
		const previous = voicePresenceSince;
		const next = new Map<string, number>();
		const observedAt = Date.now();
		const selfStableId = $currentUser?.dbUserId ? `user-${$currentUser.dbUserId}` : null;
		const selfId = selfStableId || $currentUser?.id || null;

		for (const channel of allVoiceChannels) {
			const members = getVoiceMembers(channel.id);
			for (const member of members) {
				const key = `${channel.id}::${member.userId}`;
				next.set(key, previous.get(key) ?? observedAt);
			}
			if (selfId && isConnectedToVoice(channel.id)) {
				const selfKey = `${channel.id}::${selfId}`;
				next.set(selfKey, previous.get(selfKey) ?? observedAt);
			}
		}

		voicePresenceSince = next;
	}

	onMount(() => {
		try {
			const saved = localStorage.getItem('wabi-voice-duration-mode');
			if (saved === 'off' || saved === 'others' || saved === 'all') {
				voiceDurationMode = saved;
			}
		} catch {
			// no-op
		}
		voiceDurationTicker = setInterval(() => {
			nowMs = Date.now();
		}, 1000);

		const handlePointerDown = (event: PointerEvent) => {
			if (!glimpseChannelId) return;
			const target = event.target as HTMLElement | null;
			if (!target) return;
			if (glimpsePopover?.contains(target)) return;
			if (target.closest('.channel-btn')) return;
			glimpseChannelId = null;
		};

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && glimpseChannelId) {
				glimpseChannelId = null;
			}
		};

		document.addEventListener('pointerdown', handlePointerDown);
		document.addEventListener('keydown', handleKeyDown);

		return () => {
			document.removeEventListener('pointerdown', handlePointerDown);
			document.removeEventListener('keydown', handleKeyDown);
		};
	});

	onDestroy(() => {
		if (voiceDurationTicker) {
			clearInterval(voiceDurationTicker);
			voiceDurationTicker = null;
		}
	});

	// Clear unread count when switching to chat view
	$: if (activeView === 'chat') {
		markMessagesAsRead();
	}

	function handleChannelClick(channelId: string) {
		activeView = 'chat';
		glimpseChannelId = null;
		joinChannel(channelId);
		// Auto-dock the call UI when switching to a text/forum channel while in a voice channel
		if ($callMode === 'channel') {
			channelCallPanelOpen.set(false);
		}
		dispatch('close'); // Close sidebar on mobile after channel selection
	}

	function clearAllUnreadNotifications(): void {
		const channelIds = Object.keys($channelUnreadCounts);
		for (const channelId of channelIds) {
			markChannelAsRead(channelId);
		}
		markMessagesAsRead();
	}

	function openFollowingView(): void {
		activeView = 'following';
		glimpseChannelId = null;
		dispatch('close');
	}

	function toggleChannelFollowState(channelId: string, event?: Event): void {
		event?.stopPropagation();
		const followed = toggleChannelFollow(channelId);
		if (!followed && glimpseChannelId === channelId) {
			glimpseChannelId = null;
		}
	}

	function cycleFollowAlert(channelId: string, event?: Event): void {
		event?.stopPropagation();
		if (!followedChannelIds.has(channelId)) {
			toggleChannelFollow(channelId);
		}
		cycleChannelFollowAlertLevel(channelId);
	}

	function toggleChannelGlimpse(channelId: string): void {
		glimpseChannelId = glimpseChannelId === channelId ? null : channelId;
	}

	function handleChannelButtonClick(channelId: string, event: MouseEvent): void {
		if (event.altKey) {
			event.preventDefault();
			event.stopPropagation();
			toggleChannelGlimpse(channelId);
			return;
		}
		handleChannelClick(channelId);
	}

	function getFollowAlertLabel(channelId: string): string {
		return FOLLOW_ALERT_LEVEL_LABELS[followedChannelPreferences.get(channelId)?.alertLevel || 'off'];
	}

	function summarizeGlimpseMessage(message: Message): string {
		if (message.text?.trim()) return message.text.trim();
		if (message.type === 'gif') return 'Shared a GIF';
		if (message.type === 'emoji') return `Reacted with ${message.emojiName || 'an emoji'}`;
		if (message.type === 'file') {
			if (message.files?.length) return `Shared ${message.files.length} files`;
			return `Shared ${message.fileName || 'a file'}`;
		}
		return 'Sent a message';
	}

	function formatGlimpseTime(timestamp: number): string {
		try {
			return new Intl.DateTimeFormat(undefined, {
				hour: 'numeric',
				minute: '2-digit'
			}).format(new Date(timestamp));
		} catch {
			return '';
		}
	}

	function handleCreateThread(parentChannel: Channel) {
		const rawName = window.prompt(`Create a thread in #${parentChannel.name}`, `${parentChannel.name} thread`);
		if (!rawName) return;
		const name = rawName.trim();
		if (!name) return;
		createThread(parentChannel.id, name);
	}

	function isNsfwTaggedChannel(channel: Channel): boolean {
		return isLikelyNsfwChannel(channel.name, channel.description);
	}


	function getVoiceMembers(channelId: string) {
		return $voiceChannelMembers[channelId] || [];
	}

	function isConnectedToVoice(channelId: string): boolean {
		return connectedVoiceChannelIds.has(channelId);
	}

	function isPrimaryVoiceChannel(channelId: string): boolean {
		return primaryVoiceChannelId === channelId;
	}

	function isListeningToChannel(channelId: string): boolean {
		return isConnectedToVoice(channelId);
	}

	async function handleVoiceChannelClick(channelId: string) {
		if (isConnectedToVoice(channelId)) {
			openChannelCallPanel();
			dispatch('close'); // Close sidebar on mobile after opening call view
			return;
		}
		// Already in a primary channel — subscribe this one as a secondary listen-in
		if (runtimeActiveVoiceChannelId) {
			subscribeVoiceChannel(channelId);
			return;
		}
		try {
			await joinVoiceChannel(channelId);
			dispatch('close');
		} catch (error) {
			console.error('Failed to join voice channel:', error);
		}
	}

	function handleToggleListenChannel(channelId: string) {
		if (isPrimaryVoiceChannel(channelId)) return;
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

	async function handleLeaveVoice() {
		if (primaryVoiceChannelId) {
			await leaveVoiceChannel(primaryVoiceChannelId);
			return;
		}
		for (const channelId of connectedVoiceChannelIds) {
			unsubscribeVoiceChannel(channelId);
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

	function isSelfSpeakingInChannel(channelId: string): boolean {
		const isLocallySpeaking = $isLocalSpeaking && !$callMuted && !$callDeafened;
		if (!isLocallySpeaking) return false;
		if ($voiceTransmitMode === 'all-listening') {
			return isConnectedToVoice(channelId);
		}
		return isPrimaryVoiceChannel(channelId);
	}

	function isMemberSpeaking(member: { userId: string }, channelId: string): boolean {
		if (member.userId === $currentUser?.id) {
			return isSelfSpeakingInChannel(channelId);
		}
		return $speakingUsers.has(member.userId);
	}

	function getSelfStableVoiceUserId(): string | null {
		if ($currentUser?.dbUserId) {
			return `user-${$currentUser.dbUserId}`;
		}
		return $currentUser?.id || null;
	}

	function getRecordingParticipantsForChannel(channelId: string) {
		return $voiceCallRecordingParticipants[channelId] || [];
	}

	function isVoiceChannelBeingRecorded(channelId: string): boolean {
		return getRecordingParticipantsForChannel(channelId).length > 0;
	}

	function getVoiceChannelRecordingCount(channelId: string): number {
		return getRecordingParticipantsForChannel(channelId).length;
	}

	function isSelfRecordingInChannel(channelId: string): boolean {
		const selfStableId = getSelfStableVoiceUserId();
		if (!selfStableId) return false;
		return getRecordingParticipantsForChannel(channelId).some((participant) => participant.userId === selfStableId);
	}

	function isMemberRecording(member: { userId: string }, channelId: string): boolean {
		return getRecordingParticipantsForChannel(channelId).some((participant) => participant.userId === member.userId);
	}

	function canDragVoiceMember(memberUserId: string): boolean {
		if (!$currentUser) return false;
		if (memberUserId === $currentUser.id) return true;
		if ($currentUser.dbUserId && memberUserId === `user-${$currentUser.dbUserId}`) return true;
		return canModerateVoiceMembers;
	}

	function handleVoiceMemberDragStart(event: DragEvent, channelId: string, memberUserId: string): void {
		if (!canDragVoiceMember(memberUserId)) {
			event.preventDefault();
			return;
		}
		draggedVoiceMember = { userId: memberUserId, channelId };
		voiceDropTargetChannelId = null;
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('text/plain', JSON.stringify(draggedVoiceMember));
		}
	}

	function handleVoiceMemberDragEnd(): void {
		draggedVoiceMember = null;
		voiceDropTargetChannelId = null;
	}

	function handleVoiceChannelDragOver(event: DragEvent, channelId: string): void {
		if (!draggedVoiceMember || draggedVoiceMember.channelId === channelId) return;
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'move';
		}
		voiceDropTargetChannelId = channelId;
	}

	function handleVoiceChannelDragLeave(channelId: string): void {
		if (voiceDropTargetChannelId === channelId) {
			voiceDropTargetChannelId = null;
		}
	}

	function handleVoiceChannelDrop(event: DragEvent, channelId: string): void {
		if (!draggedVoiceMember || draggedVoiceMember.channelId === channelId) return;
		event.preventDefault();
		event.stopPropagation();
		moveUserToVoiceChannel(draggedVoiceMember.userId, channelId);
		draggedVoiceMember = null;
		voiceDropTargetChannelId = null;
	}

	function showVoiceMembers(channelId: string): boolean {
		return isConnectedToVoice(channelId) || getVoiceMembers(channelId).length > 0;
	}

	function visibleVoiceMembers(channelId: string): Array<{ userId: string; socketId?: string; username?: string; profilePicture?: string }> {
		const members = getVoiceMembers(channelId);
		if (!$currentUser) return members;
		return members.filter((member) => {
			if (member.userId === $currentUser?.id) return false;
			if ($currentUser?.dbUserId && member.userId === `user-${$currentUser.dbUserId}`) return false;
			return true;
		});
	}

	function formatDiag(value: number | null, unit = ''): string {
		if (value == null || Number.isNaN(value)) return '--';
		return `${value}${unit}`;
	}

	function getCurrentVoiceChannelName(): string {
		if (!runtimeActiveVoiceChannelId) return '';
		const match = voiceChannels.find((channel) => channel.id === runtimeActiveVoiceChannelId);
		return match?.name || runtimeActiveVoiceChannelId;
	}

	function getVoiceChannelNameById(channelId: string): string {
		const match = allVoiceChannels.find((channel) => channel.id === channelId);
		return match?.name || channelId;
	}

	function getVoicePresenceStart(channelId: string, userId: string): number | null {
		return voicePresenceSince.get(`${channelId}::${userId}`) ?? null;
	}

	function getSelfVoicePresenceStart(channelId: string): number | null {
		if (!$currentUser) return null;
		const stableId = $currentUser.dbUserId ? `user-${$currentUser.dbUserId}` : null;
		const candidates = stableId ? [stableId, $currentUser.id] : [$currentUser.id];
		for (const candidate of candidates) {
			const start = getVoicePresenceStart(channelId, candidate);
			if (start) return start;
		}
		return null;
	}

	function formatVoiceDuration(startMs: number | null): string {
		if (!startMs) return '0:00';
		const elapsedSeconds = Math.max(0, Math.floor((nowMs - startMs) / 1000));
		const hours = Math.floor(elapsedSeconds / 3600);
		const minutes = Math.floor((elapsedSeconds % 3600) / 60);
		const seconds = elapsedSeconds % 60;
		if (hours > 0) {
			return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
		}
		return `${minutes}:${String(seconds).padStart(2, '0')}`;
	}

	function setVoiceDurationMode(mode: 'off' | 'others' | 'all') {
		voiceDurationMode = mode;
		try {
			localStorage.setItem('wabi-voice-duration-mode', mode);
		} catch {
			// no-op
		}
	}

	function showSelfVoiceDuration(): boolean {
		return voiceDurationMode === 'all';
	}

	function showOtherVoiceDuration(): boolean {
		return voiceDurationMode === 'all' || voiceDurationMode === 'others';
	}

	$: speakingChannelName = runtimeActiveVoiceChannelId ? getVoiceChannelNameById(runtimeActiveVoiceChannelId) : 'None';
	$: listeningChannelNames = Array.from(connectedVoiceChannelIds).map((channelId) => getVoiceChannelNameById(channelId));
	$: listeningChannelSummary = listeningChannelNames.length > 0 ? listeningChannelNames.join(', ') : 'None';

	async function handleToggleVideoInSidebar() {
		await toggleVideo(getSocket() || undefined);
	}

	async function handleToggleScreenShareInSidebar() {
		const sock = getSocket();
		if (!sock) return;
		if ($isSharing) {
			stopScreenShare(sock);
		} else {
			await startScreenShare(sock);
		}
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
	let tempChannelName = '';
	let tempWatchQueueEnabled = false;
	let tempVoiceUserLimit = '';
	let tempVoiceForceSolo = false;

	function handleOpenChannelSettings(channel: Channel) {
		selectedChannelForSettings = channel;
		tempPersistMessages = channel.persistMessages || false;
		tempDescription = channel.description || '';
		tempChannelName = channel.name || '';
		tempWatchQueueEnabled = channel.watchQueueEnabled || false;
		tempVoiceUserLimit = channel.voiceSettings?.userLimit ? String(channel.voiceSettings.userLimit) : '';
		tempVoiceForceSolo = channel.voiceSettings?.forceSolo === true;
		showChannelSettingsModal = true;
	}

	function parseVoiceUserLimitInput(rawValue: string): number | null {
		const trimmed = rawValue.trim();
		if (!trimmed) return null;
		const parsed = Number.parseInt(trimmed, 10);
		if (!Number.isFinite(parsed) || parsed < 1) return 1;
		return Math.min(99, parsed);
	}

	function buildDraftVoiceSettings(channel: Channel): VoiceChannelSettings | undefined {
		if (channel.type !== 'voice') {
			return channel.voiceSettings;
		}

		const next: VoiceChannelSettings = {};
		const userLimit = parseVoiceUserLimitInput(tempVoiceUserLimit);
		if (userLimit !== null) {
			next.userLimit = userLimit;
		}
		if (tempVoiceForceSolo) {
			next.forceSolo = true;
		}
		if (channel.voiceSettings?.bitrateMode) {
			next.bitrateMode = channel.voiceSettings.bitrateMode;
		}
		return Object.keys(next).length > 0 ? next : undefined;
	}

	function getEffectiveVoiceLimit(channel: Channel): number | null {
		if (channel.type !== 'voice') return null;
		if (channel.voiceSettings?.forceSolo) return 1;
		const configured = channel.voiceSettings?.userLimit;
		if (configured == null) return null;
		if (!Number.isFinite(configured) || configured < 1) return null;
		return configured;
	}

	function formatVoiceOccupancy(channel: Channel, memberCount: number): string {
		const limit = getEffectiveVoiceLimit(channel);
		if (limit === null) return String(memberCount);
		return `${memberCount}/${limit}`;
	}

	function getVoiceOccupancyTitle(channel: Channel, memberCount: number): string {
		const limit = getEffectiveVoiceLimit(channel);
		if (limit === null) return `${memberCount} in voice`;
		return `${memberCount}/${limit} in voice`;
	}

	function handleUpdateAutoDelete(autoDeleteAfter: '5s' | '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d' | null) {
		if (selectedChannelForSettings) {
			updateChannelSettings(selectedChannelForSettings.id, {
				autoDeleteAfter,
				persistMessages: canTogglePersistMessages ? tempPersistMessages : selectedChannelForSettings.persistMessages,
				description: tempDescription,
				name: tempChannelName.trim() || selectedChannelForSettings.name,
				watchQueueEnabled: canManageWatchQueue ? tempWatchQueueEnabled : selectedChannelForSettings.watchQueueEnabled,
				voiceSettings: canManageVoiceSettings ? buildDraftVoiceSettings(selectedChannelForSettings) : selectedChannelForSettings.voiceSettings
			});
			showChannelSettingsModal = false;
		}
	}

	function handleSaveChannelSettings() {
		if (selectedChannelForSettings) {
			updateChannelSettings(selectedChannelForSettings.id, {
				autoDeleteAfter: selectedChannelForSettings.autoDeleteAfter || null,
				persistMessages: canTogglePersistMessages ? tempPersistMessages : selectedChannelForSettings.persistMessages,
				description: tempDescription,
				name: tempChannelName.trim() || selectedChannelForSettings.name,
				watchQueueEnabled: canManageWatchQueue ? tempWatchQueueEnabled : selectedChannelForSettings.watchQueueEnabled,
				voiceSettings: canManageVoiceSettings ? buildDraftVoiceSettings(selectedChannelForSettings) : selectedChannelForSettings.voiceSettings
			});
			showChannelSettingsModal = false;
		}
	}

	function toggleStatusPopup() {
		showStatusPopup = !showStatusPopup;
	}

	function changeStatus(newStatus: 'active' | 'away' | 'busy') {
		clearActiveCustomStatusPreset();
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

	function isChannelBookmarked(channel: Channel): boolean {
		const userId = $currentUser?.id;
		if (!userId) return false;
		return channel.pinnedBy?.includes(userId) ?? false;
	}

	function toggleChannelBookmark(channel: Channel): void {
		if (isChannelBookmarked(channel)) {
			unpinChannel(channel.id);
			return;
		}
		pinChannel(channel.id);
	}

	$: channelMenuItems = contextMenuChannel ? buildChannelMenuItems(contextMenuChannel) : [];

	function buildChannelMenuItems(channel: Channel): ContextMenuItem[] {
		const items: ContextMenuItem[] = [
			{
				id: 'pin-channel',
				label: isChannelBookmarked(channel) ? 'Remove Bookmark' : 'Bookmark Channel',
				icon: 'pin',
				onSelect: () => toggleChannelBookmark(channel)
			},
			{
				id: 'pinned-messages',
				label: 'Pinned Messages',
				icon: 'pin',
				onSelect: () => handleShowPinnedMessages(channel.id)
			},
			{
				id: 'toggle-mute-channel',
				label: isChannelLocallyMuted(channel.id) ? 'Unmute Channel' : 'Mute Channel',
				onSelect: () => toggleMutedChannelId(channel.id)
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
		<button type="button" class="server-identity" on:click={() => dispatch('openServerSwitcher')}>
			<div class="logo">
			<img src="/wabi-logo-small.webp" alt="Wabi" class="logo-img" />
			</div>
			{#if !isCompactSidebar}
				<div class="server-copy">
					<span class="server-product-label">Wabi</span>
					<strong class="server-name">{currentServerLabel}</strong>
				</div>
			{/if}
		</button>
		<div class="header-buttons">
			{#if sidebarWidth < 170}
				<button
					class="control-btn compact-settings-btn"
					on:click={() => dispatch('openSettings')}
					title="User Settings"
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
				</button>
			{/if}
		</div>
	</div>

	{#if !isCompactSidebar}
		<button type="button" class="server-banner" on:click={() => dispatch('openServerSwitcher')}>
			{#if currentServerBannerUrl}
				<img src={currentServerBannerUrl} alt={currentServerLabel} class="server-banner-image" />
			{/if}
			<div class="server-banner-copy">
				<strong>{currentServerLabel}</strong>
				<span>{currentServerDescription}</span>
			</div>
		</button>
	{/if}

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
		{#if $displayEnhancementSettingsStore.serverCounterEnabled}
			<div class="workspace-counter-chip" title="Workspace channel count">
				<span class="workspace-counter-label">Workspace</span>
				<span class="workspace-counter-value">{workspaceChannelCount} channels</span>
			</div>
		{/if}
		{#if $displayEnhancementSettingsStore.readAllNotificationsButtonEnabled}
			<div class="channel-list-actions">
				<button
					class="clear-unread-btn"
					on:click={clearAllUnreadNotifications}
					disabled={totalUnreadNotifications === 0}
				>
					{#if totalUnreadNotifications > 0}
						Clear Unread ({totalUnreadNotifications})
					{:else}
						No Unread
					{/if}
				</button>
			</div>
		{/if}
		<div class="following-entry-wrap">
			<button
				type="button"
				class="following-entry"
				class:active={activeView === 'following'}
				on:click={openFollowingView}
				title="Open your followed channel feed"
			>
				<span class="following-entry-icon">+</span>
				<span class="following-entry-copy">
					<strong>Following</strong>
					<small>RSS-style local feed</small>
				</span>
				<span class="following-entry-badges">
					{#if $currentServerFollowedChannels.length > 0}
						<span class="following-entry-pill">{$currentServerFollowedChannels.length}</span>
					{/if}
					{#if followedUnreadCount > 0}
						<span class="following-entry-pill following-entry-pill--unread">{followedUnreadCount}</span>
					{/if}
				</span>
			</button>
		</div>
		<div class="section-heading-row">
			<button
				class="section-toggle"
				type="button"
				aria-expanded={isTextSectionExpanded}
				on:click={() => toggleSection('text')}
			>
				<span class="section-chevron" aria-hidden="true">
					<svg viewBox="0 0 24 24">
						<path d="M9 6l6 6-6 6"></path>
					</svg>
				</span>
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
				<span class="plus-glyph" aria-hidden="true">+</span>
			</button>
		</div>
		{#if isTextSectionExpanded}
		<!-- Public text channels -->
		{#each textChannels as channel (channel.id)}
			<div class="channel-item" class:active={$currentChannel === channel.id} class:has-timer={channel.autoDeleteAfter} on:contextmenu={(e) => handleChannelRightClick(e, channel)} use:longpress={{ onLongPress: (e) => handleChannelLongPress(e, channel) }}>
				<button class="channel-btn" data-abbrev={channel.name.charAt(0).toUpperCase()} on:click={(event) => handleChannelButtonClick(channel.id, event)} title={channel.autoDeleteAfter ? `Auto-delete: ${channel.autoDeleteAfter}` : 'Alt-click to glimpse'}>
					<span class="hash">#</span>
					{channel.name}
					{#if $displayEnhancementSettingsStore.betterNsfwTagEnabled && isNsfwTaggedChannel(channel)}
						<span class="nsfw-tag">NSFW</span>
					{/if}
					{#if isChannelLocallyMuted(channel.id)}
						<span class="muted-tag">Muted</span>
					{/if}
					<!-- TODO(mod/admin-perms): Restore channel-pin indicator when channel pinning is role-gated. -->
					{#if $channelUnreadCounts[channel.id] && $currentChannel !== channel.id}
						<span class="unread-badge">{formatBadge($channelUnreadCounts[channel.id])}</span>
					{/if}
				</button>
				<div class="channel-actions text-channel-actions">
					<button
						class="follow-btn"
						class:active={followedChannelIds.has(channel.id)}
						on:click|stopPropagation={(event) => toggleChannelFollowState(channel.id, event)}
						title={followedChannelIds.has(channel.id) ? 'Unfollow channel' : 'Follow channel'}
					>
						{followedChannelIds.has(channel.id) ? '★' : '☆'}
					</button>
					<button class="settings-btn" on:click|stopPropagation={() => handleOpenChannelSettings(channel)} title="Channel settings">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
				</button>
					<button class="pin-btn" on:click|stopPropagation={() => handleShowPinnedMessages(channel.id)} title="View pinned messages">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="2"></circle><path d="M9 3h6l-1 6 3 3H7l3-3-1-6z"></path><line x1="12" y1="15" x2="12" y2="21"></line></svg>
				</button>
				</div>
				{#if glimpseChannelId === channel.id}
					<div class="channel-glimpse-popout" bind:this={glimpsePopover}>
						<div class="channel-glimpse-header">
							<div>
								<strong>#{channel.name}</strong>
								<small>{glimpseChannelMessages.length > 0 ? `${glimpseChannelMessages.length} recent loaded` : 'No recent messages loaded yet'}</small>
							</div>
							<button
								type="button"
								class="channel-glimpse-follow-btn"
								on:click|stopPropagation={(event) => toggleChannelFollowState(channel.id, event)}
								title={followedChannelIds.has(channel.id) ? 'Unfollow channel' : 'Follow channel'}
							>
								{followedChannelIds.has(channel.id) ? 'Following' : 'Follow'}
							</button>
						</div>
						{#if glimpseChannelMessages.length > 0}
							<div class="channel-glimpse-messages">
								{#each glimpseChannelMessages as message (message.id)}
									<div class="channel-glimpse-message">
										<div class="channel-glimpse-meta">
											<strong>{message.user}</strong>
											<span>{formatGlimpseTime(message.timestamp)}</span>
										</div>
										<p>{summarizeGlimpseMessage(message)}</p>
									</div>
								{/each}
							</div>
						{:else}
							<p class="channel-glimpse-empty">Open this channel once to cache its latest window for glance mode.</p>
						{/if}
						<div class="channel-glimpse-actions">
							<button type="button" class="channel-glimpse-alert-btn" on:click|stopPropagation={(event) => cycleFollowAlert(channel.id, event)}>
								Alerts: {getFollowAlertLabel(channel.id)}
							</button>
							<button type="button" class="channel-glimpse-open-btn" on:click|stopPropagation={() => handleChannelClick(channel.id)}>
								Open channel
							</button>
						</div>
					</div>
				{/if}
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
					<button class="channel-btn" data-abbrev={channel.name.charAt(0).toUpperCase()} on:click={(event) => handleChannelButtonClick(channel.id, event)} title={channel.autoDeleteAfter ? `Auto-delete: ${channel.autoDeleteAfter}` : 'Alt-click to glimpse'}>
						<svg class="group-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
						{channel.name}
						{#if $displayEnhancementSettingsStore.betterNsfwTagEnabled && isNsfwTaggedChannel(channel)}
							<span class="nsfw-tag">NSFW</span>
						{/if}
						{#if isChannelLocallyMuted(channel.id)}
							<span class="muted-tag">Muted</span>
						{/if}
						<!-- TODO(mod/admin-perms): Restore channel-pin indicator when channel pinning is role-gated. -->
						{#if $channelUnreadCounts[channel.id] && $currentChannel !== channel.id}
							<span class="unread-badge">{formatBadge($channelUnreadCounts[channel.id])}</span>
						{/if}
					</button>
					<div class="channel-actions text-channel-actions">
						<button
							class="follow-btn"
							class:active={followedChannelIds.has(channel.id)}
							on:click|stopPropagation={(event) => toggleChannelFollowState(channel.id, event)}
							title={followedChannelIds.has(channel.id) ? 'Unfollow group' : 'Follow group'}
						>
							{followedChannelIds.has(channel.id) ? '★' : '☆'}
						</button>
						<button class="settings-btn" on:click|stopPropagation={() => handleOpenChannelSettings(channel)} title="Channel settings">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
				</button>
						<button class="pin-btn" on:click|stopPropagation={() => handleShowPinnedMessages(channel.id)} title="View pinned messages">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="2"></circle><path d="M9 3h6l-1 6 3 3H7l3-3-1-6z"></path><line x1="12" y1="15" x2="12" y2="21"></line></svg>
				</button>
					</div>
					{#if glimpseChannelId === channel.id}
						<div class="channel-glimpse-popout" bind:this={glimpsePopover}>
							<div class="channel-glimpse-header">
								<div>
									<strong>{channel.name}</strong>
									<small>{glimpseChannelMessages.length > 0 ? `${glimpseChannelMessages.length} recent loaded` : 'No recent messages loaded yet'}</small>
								</div>
								<button
									type="button"
									class="channel-glimpse-follow-btn"
									on:click|stopPropagation={(event) => toggleChannelFollowState(channel.id, event)}
									title={followedChannelIds.has(channel.id) ? 'Unfollow group' : 'Follow group'}
								>
									{followedChannelIds.has(channel.id) ? 'Following' : 'Follow'}
								</button>
							</div>
							{#if glimpseChannelMessages.length > 0}
								<div class="channel-glimpse-messages">
									{#each glimpseChannelMessages as message (message.id)}
										<div class="channel-glimpse-message">
											<div class="channel-glimpse-meta">
												<strong>{message.user}</strong>
												<span>{formatGlimpseTime(message.timestamp)}</span>
											</div>
											<p>{summarizeGlimpseMessage(message)}</p>
										</div>
									{/each}
								</div>
							{:else}
								<p class="channel-glimpse-empty">Open this group once to cache its latest window for glance mode.</p>
							{/if}
							<div class="channel-glimpse-actions">
								<button type="button" class="channel-glimpse-alert-btn" on:click|stopPropagation={(event) => cycleFollowAlert(channel.id, event)}>
									Alerts: {getFollowAlertLabel(channel.id)}
								</button>
								<button type="button" class="channel-glimpse-open-btn" on:click|stopPropagation={() => handleChannelClick(channel.id)}>
									Open group
								</button>
							</div>
						</div>
					{/if}
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
				<span class="section-chevron" aria-hidden="true">
					<svg viewBox="0 0 24 24">
						<path d="M9 6l6 6-6 6"></path>
					</svg>
				</span>
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
				<span class="plus-glyph" aria-hidden="true">+</span>
			</button>
		</div>
		{#if isVoiceSectionExpanded}
		{#each voiceChannels as channel (channel.id)}
			{@const members = getVoiceMembers(channel.id)}
			{@const channelIsConnected = isConnectedToVoice(channel.id)}
			<div
				class="channel-item voice-channel-item"
				class:active={channelIsConnected}
				class:connected={channelIsConnected}
				class:voice-drop-target={voiceDropTargetChannelId === channel.id}
				on:click={() => handleVoiceChannelClick(channel.id)}
				on:dragover={(event) => handleVoiceChannelDragOver(event, channel.id)}
				on:dragleave={() => handleVoiceChannelDragLeave(channel.id)}
				on:drop={(event) => handleVoiceChannelDrop(event, channel.id)}
				on:contextmenu={(e) => handleChannelRightClick(e, channel)}
				use:longpress={{ onLongPress: (e) => handleChannelLongPress(e, channel) }}
			>
				<button class="channel-btn" data-abbrev={channel.name.charAt(0).toUpperCase()}>
					<span class="hash voice-icon" aria-hidden="true">
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
					</span>
					<span class="voice-channel-name">{channel.name}</span>
					<span class="voice-inline-count" title={getVoiceOccupancyTitle(channel, members.length)}>
						<svg class="voice-count-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
						{formatVoiceOccupancy(channel, members.length)}
					</span>
					{#if isVoiceChannelBeingRecorded(channel.id)}
						<span class="voice-recording-tag" title={`${getVoiceChannelRecordingCount(channel.id)} participant(s) recording in this call`}>
							REC {getVoiceChannelRecordingCount(channel.id)}
						</span>
					{/if}
				</button>
			</div>
			{#if showVoiceMembers(channel.id)}
				<div class="voice-member-list" transition:slide={{ duration: 180, easing: cubicOut }}>
					{#if channelIsConnected && $currentUser}
					<div class="voice-member-item" in:fly={{ x: -18, duration: 180, opacity: 0.2, easing: cubicOut }} out:fly={{ x: -24, duration: 150, opacity: 0.1 }}>
						{#if $currentUser.profilePicture}
							<img class="voice-member-avatar" class:speaking={isSelfSpeakingInChannel(channel.id)} src={$currentUser.profilePicture} alt={$currentUser.username} />
						{:else}
							<span class="voice-member-avatar voice-avatar-fallback" class:speaking={isSelfSpeakingInChannel(channel.id)}>{($currentUser.username || '?').charAt(0).toUpperCase()}</span>
						{/if}
						<span class="voice-member-name">{$currentUser.username}</span>
						{#if isSelfRecordingInChannel(channel.id)}
							<span class="voice-recording-tag member">REC</span>
						{/if}
						{#if showSelfVoiceDuration()}
							<span class="voice-member-duration">{formatVoiceDuration(getSelfVoicePresenceStart(channel.id))}</span>
						{/if}
					</div>
					{/if}
					{#each visibleVoiceMembers(channel.id) as member (member.userId)}
						<div
							class="voice-member-item"
							class:voice-member-draggable={canDragVoiceMember(member.userId)}
							draggable={canDragVoiceMember(member.userId)}
							on:dragstart={(event) => handleVoiceMemberDragStart(event, channel.id, member.userId)}
							on:dragend={handleVoiceMemberDragEnd}
							in:fly={{ x: -18, duration: 180, opacity: 0.2, easing: cubicOut }}
							out:fly={{ x: -24, duration: 150, opacity: 0.1 }}
						>
							{#if member.profilePicture}
								<img class="voice-member-avatar" class:speaking={isMemberSpeaking(member, channel.id)} src={member.profilePicture} alt={member.username || member.userId} />
							{:else}
								<span class="voice-member-avatar voice-avatar-fallback" class:speaking={isMemberSpeaking(member, channel.id)}>{(member.username || '?').charAt(0).toUpperCase()}</span>
							{/if}
							<span class="voice-member-name">{member.username || member.userId}</span>
							{#if isMemberRecording(member, channel.id)}
								<span class="voice-recording-tag member">REC</span>
							{/if}
							{#if showOtherVoiceDuration()}
								<span class="voice-member-duration">{formatVoiceDuration(getVoicePresenceStart(channel.id, member.userId))}</span>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
			{#each breakoutChannelsByParent[channel.id] || [] as breakout (breakout.id)}
				{@const breakoutMembers = getVoiceMembers(breakout.id)}
				{@const breakoutIsConnected = isConnectedToVoice(breakout.id)}
				<div
					class="channel-item voice-channel-item breakout-channel-item"
					class:active={breakoutIsConnected}
					class:connected={breakoutIsConnected}
					class:voice-drop-target={voiceDropTargetChannelId === breakout.id}
					on:click={() => handleVoiceChannelClick(breakout.id)}
					on:dragover={(event) => handleVoiceChannelDragOver(event, breakout.id)}
					on:dragleave={() => handleVoiceChannelDragLeave(breakout.id)}
					on:drop={(event) => handleVoiceChannelDrop(event, breakout.id)}
					on:contextmenu={(e) => handleChannelRightClick(e, breakout)}
					use:longpress={{ onLongPress: (e) => handleChannelLongPress(e, breakout) }}
				>
					<button class="channel-btn" data-abbrev={breakout.name.charAt(0).toUpperCase()}>
						<span class="breakout-prefix" aria-hidden="true">&gt;</span>
						<span class="voice-channel-name">{breakout.name}</span>
						<span class="voice-inline-count" title={getVoiceOccupancyTitle(breakout, breakoutMembers.length)}>
							<svg class="voice-count-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
							{formatVoiceOccupancy(breakout, breakoutMembers.length)}
						</span>
						{#if isVoiceChannelBeingRecorded(breakout.id)}
							<span class="voice-recording-tag" title={`${getVoiceChannelRecordingCount(breakout.id)} participant(s) recording in this call`}>
								REC {getVoiceChannelRecordingCount(breakout.id)}
							</span>
						{/if}
					</button>
				</div>
				{#if showVoiceMembers(breakout.id)}
					<div class="voice-member-list breakout-member-list" transition:slide={{ duration: 180, easing: cubicOut }}>
						{#if breakoutIsConnected && $currentUser}
						<div class="voice-member-item" in:fly={{ x: -18, duration: 180, opacity: 0.2, easing: cubicOut }} out:fly={{ x: -24, duration: 150, opacity: 0.1 }}>
							{#if $currentUser.profilePicture}
								<img class="voice-member-avatar" class:speaking={isSelfSpeakingInChannel(breakout.id)} src={$currentUser.profilePicture} alt={$currentUser.username} />
							{:else}
								<span class="voice-member-avatar voice-avatar-fallback" class:speaking={isSelfSpeakingInChannel(breakout.id)}>{($currentUser.username || '?').charAt(0).toUpperCase()}</span>
							{/if}
							<span class="voice-member-name">{$currentUser.username}</span>
							{#if isSelfRecordingInChannel(breakout.id)}
								<span class="voice-recording-tag member">REC</span>
							{/if}
							{#if showSelfVoiceDuration()}
								<span class="voice-member-duration">{formatVoiceDuration(getSelfVoicePresenceStart(breakout.id))}</span>
							{/if}
						</div>
						{/if}
						{#each visibleVoiceMembers(breakout.id) as member (member.userId)}
							<div
								class="voice-member-item"
								class:voice-member-draggable={canDragVoiceMember(member.userId)}
								draggable={canDragVoiceMember(member.userId)}
								on:dragstart={(event) => handleVoiceMemberDragStart(event, breakout.id, member.userId)}
								on:dragend={handleVoiceMemberDragEnd}
								in:fly={{ x: -18, duration: 180, opacity: 0.2, easing: cubicOut }}
								out:fly={{ x: -24, duration: 150, opacity: 0.1 }}
							>
								{#if member.profilePicture}
									<img class="voice-member-avatar" class:speaking={isMemberSpeaking(member, breakout.id)} src={member.profilePicture} alt={member.username || member.userId} />
								{:else}
									<span class="voice-member-avatar voice-avatar-fallback" class:speaking={isMemberSpeaking(member, breakout.id)}>{(member.username || '?').charAt(0).toUpperCase()}</span>
								{/if}
								<span class="voice-member-name">{member.username || member.userId}</span>
								{#if isMemberRecording(member, breakout.id)}
									<span class="voice-recording-tag member">REC</span>
								{/if}
								{#if showOtherVoiceDuration()}
									<span class="voice-member-duration">{formatVoiceDuration(getVoicePresenceStart(breakout.id, member.userId))}</span>
								{/if}
							</div>
						{/each}
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

	{#if $callMode === 'channel' && runtimeActiveVoiceChannelId && !isCompactSidebar}
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

			<div class="voice-route-controls">
				<label for="voice-transmit-mode">Transmit</label>
				<select id="voice-transmit-mode" on:change={handleTransmitModeChange} value={$voiceTransmitMode}>
					<option value="primary">Primary channel</option>
					<option value="all-listening">All listening channels</option>
				</select>
			</div>

			<div class="voice-route-controls">
				<label for="voice-duration-mode">Timers</label>
				<select
					id="voice-duration-mode"
					value={voiceDurationMode}
					on:change={(event) => setVoiceDurationMode((event.currentTarget as HTMLSelectElement).value as 'off' | 'others' | 'all')}
				>
					<option value="off">Off</option>
					<option value="others">Others</option>
					<option value="all">All</option>
				</select>
			</div>

			{#if $listeningVoiceChannels.length > 0}
			<div class="voice-listen-controls">
				<div class="voice-listen-title">Listen In</div>
				<div class="voice-listen-list">
					{#each activeListenChips as voiceChannel (voiceChannel.id)}
						<button
							type="button"
							class="voice-listen-chip"
							class:active={$listeningVoiceChannels.includes(voiceChannel.id) || voiceChannel.id === runtimeActiveVoiceChannelId}
							class:locked={voiceChannel.id === runtimeActiveVoiceChannelId}
							on:click={() => handleToggleListenChannel(voiceChannel.id)}
							title={voiceChannel.id === runtimeActiveVoiceChannelId ? 'Primary voice channel' : $listeningVoiceChannels.includes(voiceChannel.id) ? 'Stop listening' : 'Start listening'}
						>
							{voiceChannel.name}
						</button>
					{/each}
				</div>
			</div>
		{/if}

			<div class="voice-usercard-actions">
				<button class:active={!$isVideoOff} on:click={handleToggleVideoInSidebar} title={$isVideoOff ? 'Turn on camera' : 'Turn off camera'}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
				</button>
				<button class:active={$isSharing} on:click={handleToggleScreenShareInSidebar} title={$isSharing ? 'Stop sharing' : 'Share screen'}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
				</button>
				<button class="leave-btn" on:click={handleLeaveVoice} title="Leave voice channel">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07C9.44 17.28 8.17 16 7.05 14.68A19.79 19.79 0 0 1 4 6.05 2 2 0 0 1 5.99 4h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L10.68 11.68"/><line x1="23" y1="1" x2="1" y2="23"/></svg>
				</button>
			</div>
		</div>
	{/if}

	{#if $currentUser}
		<div class="profile-card">
			<div class="profile-info">
				<button class="avatar-container" on:click={openOwnProfilePopout}>
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
						on:click={() => dispatch('openSettings')}
						title="User Settings"
					>
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
					</button>
				{/if}
			</div>
		</div>
	{/if}
</div>


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
<UserPopout
	user={$currentUser}
	bind:isOpen={showOwnProfilePopout}
	anchorElement={ownProfilePopoutAnchor}
	isOwnProfile={true}
	on:close={() => (showOwnProfilePopout = false)}
	on:openFullProfile={() => dispatch('openSettings')}
/>

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
						<label>Name</label>
						<input
							type="text"
							bind:value={tempChannelName}
							placeholder="Channel name"
							class="description-input"
							maxlength="64"
						/>
					</div>

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
									disabled={!canTogglePersistMessages}
								/>
								Persist Messages Locally (Owner Only)
							</label>
							<p class="setting-description">
								Save messages to your browser's local storage so you can see them after the server restarts.
								Each client controls their own message history.
							</p>
							{#if !canTogglePersistMessages}
								<p class="setting-description">Only workspace owners can change this setting.</p>
							{/if}
						</div>
					{/if}

					{#if selectedChannelForSettings.type !== 'dm' && selectedChannelForSettings.type !== 'voice'}
						<div class="setting-group">
							<label class="setting-label">
								<input
									type="checkbox"
									bind:checked={tempWatchQueueEnabled}
									class="setting-checkbox"
									disabled={!canManageWatchQueue}
								/>
								YouTube Queue Channel
							</label>
							<p class="setting-description">
								Enable the dedicated watch queue embed area in this channel while keeping standard YouTube link previews.
							</p>
							{#if !canManageWatchQueue}
								<p class="setting-description">Only workspace owners or admins can change this setting.</p>
							{/if}
						</div>
					{/if}

					{#if selectedChannelForSettings.type === 'voice'}
						<div class="setting-group">
							<div class="setting-label">Voice Capacity</div>
							<p class="setting-description">Leave blank for unlimited. The sidebar will show current users as x/y when a limit is set.</p>
							<input
								type="number"
								min="1"
								max="99"
								step="1"
								value={tempVoiceUserLimit}
								on:input={(event) => {
									tempVoiceUserLimit = (event.currentTarget as HTMLInputElement).value;
								}}
								placeholder="Unlimited"
								class="description-input"
								disabled={!canManageVoiceSettings}
							/>
							{#if !canManageVoiceSettings}
								<p class="setting-description">Only workspace owners or admins can change voice capacity.</p>
							{/if}
						</div>

						<div class="setting-group">
							<label class="setting-label">
								<input
									type="checkbox"
									bind:checked={tempVoiceForceSolo}
									class="setting-checkbox"
									disabled={!canManageVoiceSettings}
								/>
								Focused Audio
							</label>
							<p class="setting-description">When enabled, joining this voice channel forces listen/transmit focus to this channel only. Use voice capacity `1` if you want a true one-person room.</p>
							{#if !canManageVoiceSettings}
								<p class="setting-description">Only workspace owners or admins can change focused audio mode.</p>
							{/if}
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
	.channel-sidebar.compact .create-channel,
	.channel-sidebar.compact .workspace-counter-chip,
	.channel-sidebar.compact .channel-list-actions {
		display: none;
	}

	.channel-sidebar.compact .following-entry-wrap {
		padding: 0.25rem;
	}

	.channel-sidebar.compact .following-entry {
		justify-content: center;
		padding: 0.5rem;
		border-radius: 14px;
	}

	.channel-sidebar.compact .following-entry-copy,
	.channel-sidebar.compact .following-entry-badges {
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
		height: var(--app-chrome-height);
		gap: 0.5rem;
		box-sizing: border-box;
	}

	.server-identity {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 0.65rem;
		min-width: 0;
		border: none;
		background: transparent;
		padding: 0;
		cursor: pointer;
		color: inherit;
		text-align: left;
	}

	.logo {
		display: flex;
		align-items: center;
	}

	.logo-img {
		height: 32px;
		width: auto;
		filter: drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.3));
		transition: filter 0.3s ease;
	}

	/* Keep logo white on dark presets for consistent contrast */
	:root[data-theme="dark"] .logo-img,
	:root[data-theme="midnight-blue"] .logo-img,
	:root[data-theme="vscode-high-contrast"] .logo-img,
	:root[data-theme="slate-signal"] .logo-img,
	:root[data-theme="catppuccin-mocha"] .logo-img,
	:root[data-theme="dracula"] .logo-img,
	:root[data-theme="nord"] .logo-img,
	:root[data-theme="tokyo-night"] .logo-img,
	:root[data-theme="forest"] .logo-img,
	:root[data-theme="ember"] .logo-img {
		filter: invert(1) drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.3));
	}

	.server-copy {
		min-width: 0;
		display: grid;
		gap: 0.08rem;
	}

	.server-product-label {
		font-size: 0.63rem;
		text-transform: uppercase;
		letter-spacing: 0.11em;
		color: var(--text-secondary);
	}

	.server-name {
		font-size: 0.92rem;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.server-banner {
		position: relative;
		margin: 0.8rem 1rem 0.35rem;
		min-height: 92px;
		border: 1px solid rgba(var(--border-rgb), 0.45);
		border-radius: 18px;
		overflow: hidden;
		background:
			linear-gradient(135deg, rgba(45, 212, 191, 0.18), rgba(37, 99, 235, 0.16)),
			radial-gradient(circle at top left, rgba(255, 255, 255, 0.08), transparent 52%);
		padding: 0;
		cursor: pointer;
		text-align: left;
	}

	.server-banner-image {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		opacity: 0.46;
	}

	.server-banner-copy {
		position: relative;
		z-index: 1;
		display: grid;
		gap: 0.18rem;
		padding: 0.95rem 1rem;
		background: linear-gradient(180deg, rgba(4, 9, 19, 0.1), rgba(4, 9, 19, 0.7));
	}

	.server-banner-copy strong {
		font-size: 0.95rem;
		color: #f8fafc;
	}

	.server-banner-copy span {
		font-size: 0.74rem;
		line-height: 1.35;
		color: rgba(248, 250, 252, 0.78);
		word-break: break-word;
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

	.workspace-counter-chip {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.6rem;
		margin: 0.55rem 0.7rem 0.15rem;
		padding: 0.35rem 0.55rem;
		border-radius: 8px;
		border: 1px solid rgba(var(--accent-rgb), var(--opacity-light));
		background: color-mix(in srgb, var(--bg-secondary) 80%, rgba(var(--accent-rgb), 0.2));
	}

	.workspace-counter-label {
		font-size: 0.66rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-secondary);
	}

	.workspace-counter-value {
		font-size: 0.72rem;
		font-weight: 700;
		color: var(--text-primary);
	}

	.channel-list-actions {
		padding: 0.25rem 0.7rem 0.15rem;
	}

	.clear-unread-btn {
		width: 100%;
		border: 1px solid rgba(var(--accent-rgb), var(--opacity-light));
		background: transparent;
		color: var(--text-secondary);
		border-radius: 7px;
		padding: 0.3rem 0.45rem;
		font-size: 0.7rem;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.18s ease;
	}

	.clear-unread-btn:hover:not(:disabled) {
		color: var(--text-primary);
		border-color: rgba(var(--accent-rgb), var(--opacity-strong));
		background: rgba(var(--accent-rgb), var(--opacity-subtle));
	}

	.clear-unread-btn:disabled {
		opacity: 0.55;
		cursor: default;
	}

	.following-entry-wrap {
		padding: 0.25rem 0.6rem 0.45rem;
	}

	.following-entry {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 0.7rem;
		padding: 0.75rem 0.8rem;
		border: 1px solid rgba(var(--accent-rgb), 0.14);
		border-radius: 16px;
		background:
			linear-gradient(135deg, rgba(var(--accent-rgb), 0.16), rgba(59, 130, 246, 0.1)),
			rgba(var(--bg-secondary-rgb), 0.92);
		color: var(--text-primary);
		cursor: pointer;
		text-align: left;
	}

	.following-entry:hover,
	.following-entry.active {
		border-color: rgba(var(--accent-rgb), 0.34);
		box-shadow: 0 12px 24px rgba(0, 0, 0, 0.16);
	}

	.following-entry-icon {
		width: 32px;
		height: 32px;
		border-radius: 12px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 1.2rem;
		font-weight: 700;
		color: rgba(255, 255, 255, 0.95);
		background: rgba(var(--accent-rgb), 0.24);
		flex-shrink: 0;
	}

	.following-entry-copy {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.following-entry-copy strong {
		font-size: 0.95rem;
	}

	.following-entry-copy small {
		font-size: 0.72rem;
		color: var(--text-secondary);
	}

	.following-entry-badges {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		flex-shrink: 0;
	}

	.following-entry-pill {
		min-width: 1.65rem;
		height: 1.65rem;
		padding: 0 0.42rem;
		border-radius: 999px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: rgba(15, 23, 42, 0.72);
		color: var(--text-primary);
		font-size: 0.72rem;
		font-weight: 700;
	}

	.following-entry-pill--unread {
		background: rgba(239, 68, 68, 0.86);
		color: #fff;
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

	.nsfw-tag {
		margin-left: 0.25rem;
		padding: 0.08rem 0.34rem;
		border-radius: 999px;
		font-size: 0.58rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: #ffd3d3;
		background: color-mix(in srgb, #d43b3b 72%, var(--bg-secondary));
		border: 1px solid rgba(255, 120, 120, 0.48);
	}

	.muted-tag {
		margin-left: 0.25rem;
		padding: 0.08rem 0.34rem;
		border-radius: 999px;
		font-size: 0.58rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-secondary);
		background: color-mix(in srgb, var(--bg-tertiary) 86%, transparent);
		border: 1px solid rgba(var(--border-rgb), 0.5);
	}

	.channel-item.active .channel-btn {
		color: var(--text-primary);
	}

	.channel-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.follow-btn {
		width: 24px;
		height: 24px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: none;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		border-radius: 999px;
		font-size: 0.95rem;
		opacity: 0.84;
		transition: background 0.18s ease, color 0.18s ease, opacity 0.18s ease;
	}

	.follow-btn:hover,
	.follow-btn.active {
		background: rgba(245, 158, 11, 0.14);
		color: #fbbf24;
		opacity: 1;
	}

	.channel-glimpse-popout {
		position: absolute;
		top: 0.2rem;
		left: calc(100% + 0.45rem);
		width: min(320px, 56vw);
		padding: 0.85rem;
		border-radius: 18px;
		border: 1px solid rgba(var(--accent-rgb), 0.2);
		background:
			linear-gradient(180deg, rgba(15, 23, 42, 0.96), rgba(17, 24, 39, 0.96)),
			rgba(var(--bg-secondary-rgb), 0.94);
		box-shadow: 0 22px 42px rgba(0, 0, 0, 0.28);
		z-index: 35;
	}

	:global(.app-container.nav-right) .channel-glimpse-popout,
	.channel-sidebar.compact .channel-glimpse-popout {
		left: auto;
		right: calc(100% + 0.45rem);
	}

	.channel-glimpse-header,
	.channel-glimpse-meta,
	.channel-glimpse-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.channel-glimpse-header {
		margin-bottom: 0.7rem;
	}

	.channel-glimpse-header small,
	.channel-glimpse-meta span,
	.channel-glimpse-empty {
		color: var(--text-secondary);
		font-size: 0.73rem;
	}

	.channel-glimpse-messages {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		margin-bottom: 0.75rem;
	}

	.channel-glimpse-message {
		padding: 0.55rem 0.65rem;
		border-radius: 12px;
		background: rgba(var(--border-rgb), var(--opacity-light));
	}

	.channel-glimpse-message p,
	.channel-glimpse-empty {
		margin: 0.22rem 0 0;
		line-height: 1.4;
	}

	.channel-glimpse-follow-btn,
	.channel-glimpse-alert-btn,
	.channel-glimpse-open-btn {
		border: 1px solid rgba(var(--border-rgb), 0.3);
		border-radius: 999px;
		padding: 0.42rem 0.65rem;
		background: rgba(15, 23, 42, 0.82);
		color: var(--text-primary);
		font: inherit;
		cursor: pointer;
	}

	.channel-glimpse-open-btn {
		background: rgba(var(--accent-rgb), 0.16);
		border-color: rgba(var(--accent-rgb), 0.28);
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
		border: none;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		opacity: 0.7;
		transition: all 0.18s ease;
	}

	.section-add-btn .plus-glyph {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
		font-size: 1.1rem;
		font-weight: 700;
		line-height: 1;
		transform: translateY(3px);
	}

	.section-heading-row:hover .section-add-btn,
	.section-add-btn.active {
		opacity: 1;
		color: var(--text-primary);
		background: transparent;
	}

	.section-toggle:hover {
		color: var(--text-primary);
	}

	.section-chevron {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 12px;
		height: 12px;
		transform-origin: center;
		transition: transform 0.18s ease;
	}

	.section-chevron svg {
		width: 12px;
		height: 12px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2.5;
		stroke-linecap: round;
		stroke-linejoin: round;
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
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		font-size: 0.68rem;
		font-weight: 600;
		color: var(--text-secondary);
		background: rgba(var(--border-rgb), var(--opacity-light));
		padding: 0.05rem 0.35rem;
		border-radius: 999px;
	}

	.voice-recording-tag {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		margin-left: 0.32rem;
		padding: 0.06rem 0.38rem;
		border-radius: 999px;
		font-size: 0.56rem;
		font-weight: 800;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: #fff1f2;
		background: color-mix(in srgb, #dc2626 74%, var(--bg-tertiary));
		border: 1px solid rgba(248, 113, 113, 0.44);
		flex-shrink: 0;
	}

	.voice-recording-tag.member {
		margin-left: 0;
		font-size: 0.54rem;
		padding: 0.05rem 0.34rem;
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

	.voice-channel-item.connected {
		border-color: color-mix(in srgb, #22c55e 42%, transparent);
		background: color-mix(in srgb, #22c55e 12%, var(--bg-tertiary));
	}

	.voice-channel-item.voice-drop-target {
		border-color: color-mix(in srgb, #60a5fa 58%, transparent);
		background: color-mix(in srgb, #60a5fa 15%, var(--bg-tertiary));
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
		padding: 0.16rem 0.42rem 0.16rem 0.18rem;
		border-radius: 999px;
		background: color-mix(in srgb, var(--bg-tertiary) 72%, transparent);
		border: 1px solid rgba(var(--border-rgb), 0.25);
		transition: transform 0.14s ease, border-color 0.14s ease, background 0.14s ease;
	}

	.voice-member-item:hover {
		transform: translateX(2px);
		border-color: rgba(var(--border-rgb), 0.45);
		background: color-mix(in srgb, var(--bg-tertiary) 88%, transparent);
	}

	.voice-member-item.voice-member-draggable {
		cursor: grab;
	}

	.voice-member-item.voice-member-draggable:active {
		cursor: grabbing;
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

	.voice-member-duration {
		margin-left: auto;
		font-size: 0.68rem;
		opacity: 0.72;
		font-variant-numeric: tabular-nums;
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

	.voice-route-controls {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.45rem;
		font-size: 0.72rem;
	}

	.voice-route-controls label {
		color: var(--text-secondary);
		flex-shrink: 0;
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

	.voice-usercard-actions button {
		background: rgba(var(--border-rgb), 0.2);
		border: 1px solid rgba(var(--border-rgb), 0.4);
		color: var(--text-primary);
		border-radius: 999px;
		width: 36px;
		height: 36px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		cursor: pointer;
		flex-shrink: 0;
	}

	.voice-usercard-actions button svg {
		width: 16px;
		height: 16px;
		stroke: currentColor;
		flex-shrink: 0;
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
		padding: 0.68rem 0.75rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		height: var(--app-chrome-height);
		min-height: var(--app-chrome-height);
		position: relative;
		box-sizing: border-box;
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

	.status-divider {
		height: 1px;
		background: var(--border);
		margin: 4px 2px;
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

	.status-preset-option {
		align-items: flex-start;
	}

	.status-preset-copy {
		display: inline-flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.status-preset-label {
		font-weight: 600;
		line-height: 1.2;
	}

	.status-preset-note {
		font-size: var(--text-xs);
		color: var(--text-secondary);
		line-height: 1.2;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 18ch;
	}

	.status-preset-empty {
		padding: 6px 10px;
		font-size: var(--text-xs);
		color: var(--text-secondary);
	}

	.status-preset-option.active-preset {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
	}

	.user-tag {
		font-size: var(--text-xs);
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.custom-status-pill {
		margin-top: 2px;
		max-width: 24ch;
		font-size: var(--text-xs);
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.profile-controls {
		display: flex;
		align-items: center;
		gap: 0.35rem;
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
		z-index: 5000;
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
		.settings-btn,
		.follow-btn {
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

		.channel-list {
			-ms-overflow-style: none;
			scrollbar-width: none;
		}

		.channel-list::-webkit-scrollbar {
			display: none;
			width: 0;
			height: 0;
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
