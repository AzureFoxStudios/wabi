<script lang="ts">
	import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
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
		canScreenShare,
		speakingUsers
	} from '$lib/calling';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import PinnedMessagesModal from './PinnedMessagesModal.svelte';
	import UserPopout from './UserPopout.svelte';
	import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';
	import type { ContextMenuItem } from '$lib/context-menu/types';
	import type { Channel, Message, VoiceChannelSettings } from '$lib/socket';
	import { longpress } from '$lib/actions/longpress';
	import {
		MESSAGE_RETENTION_LABELS,
		MESSAGE_RETENTION_PRESETS,
		type MessageRetentionDuration
	} from '../../../../shared/messageRetention.js';
	import { layoutStore } from '$lib/layoutStore';
	import { currentSavedServer } from '$lib/savedServers';
	import { resolveServerUrl } from '$lib/serverUrl';
	import {
		FOLLOW_ALERT_LEVEL_LABELS,
		currentServerFollowedChannels,
		cycleChannelFollowAlertLevel,
		toggleChannelFollow
	} from '$lib/following';
	import { setWhiteboardSurface } from '$lib/whiteboard/whiteboardSurface';
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
	let newChannelType: 'text' | 'voice' | 'forum' | 'gallery' | 'wiki' | 'stage' = 'text';
	let showCreateInput = false;
	let newChannelNameInput: HTMLInputElement | null = null;
	let serverIdentityImageFailed = false;
	let lastServerIdentityIconUrl: string | null = null;
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
	let isGallerySectionExpanded = true;
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
	$: serverIdentityIconUrl = $currentSavedServer?.effectiveIconUrl || null;
	$: if (serverIdentityIconUrl !== lastServerIdentityIconUrl) {
		lastServerIdentityIconUrl = serverIdentityIconUrl;
		serverIdentityImageFailed = false;
	}
	$: if (showCreateInput) {
		void tick().then(() => newChannelNameInput?.focus());
	}
	$: followedChannelIds = new Set($currentServerFollowedChannels.map((entry) => entry.channelId));
	$: followedChannelPreferences = new Map(
		$currentServerFollowedChannels.map((entry) => [entry.channelId, entry])
	);
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
	$: galleryChannels = $channels
		.filter(ch => ch.type === 'gallery')
		.filter(ch => !shouldHideChannelFromList(ch))
		.sort((a, b) => a.name.localeCompare(b.name));
	$: activeListenChips = voiceChannels.filter(ch =>
		$listeningVoiceChannels.includes(ch.id) || ch.id === runtimeActiveVoiceChannelId
	);
	$: workspaceChannelCount = textChannels.length + groupChannels.length + voiceChannels.length + galleryChannels.length;
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

	function openVoiceChannelWhiteboard(channelId: string, event?: Event): void {
		event?.stopPropagation();
		activeView = 'chat';
		currentChannel.set(channelId);
		setWhiteboardSurface(channelId, 'whiteboard');
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
		const value = (event.currentTarget as HTMLSelectElement).value as 'auto' | 'always' | 'push-to-talk';
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
			try {
				await startScreenShare(sock);
			} catch {
				// swallow — startScreenShare already logs
			}
		}
	}

	function toggleSection(section: 'text' | 'voice' | 'gallery') {
		if (section === 'text') {
			isTextSectionExpanded = !isTextSectionExpanded;
			return;
		}
		if (section === 'gallery') {
			isGallerySectionExpanded = !isGallerySectionExpanded;
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

	function toggleCreateInputForType(channelType: 'text' | 'voice' | 'forum' | 'gallery' | 'wiki' | 'stage') {
		if (showCreateInput && newChannelType === channelType) {
			showCreateInput = false;
			return;
		}
		newChannelType = channelType;
		showCreateInput = true;
		void tick().then(() => newChannelNameInput?.focus());
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

	function handleUpdateAutoDelete(autoDeleteAfter: MessageRetentionDuration | null) {
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
		updateProfile({ status: newStatus });
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
		const supportsFollowing =
			channel.type === 'text' || channel.type === 'public' || channel.type === 'group' || !channel.type;
		const followNoun = channel.type === 'group' ? 'Group' : 'Channel';
		const isFollowed = supportsFollowing && followedChannelIds.has(channel.id);
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

		if (supportsFollowing) {
			items.unshift(
				{
					id: 'follow-feed',
					label: 'Open Follow Feed',
					leading: '≈',
					hint:
						$currentServerFollowedChannels.length > 0
							? `${$currentServerFollowedChannels.length} followed`
							: undefined,
					disabled: $currentServerFollowedChannels.length === 0,
					onSelect: openFollowingView
				},
				{
					id: 'follow-alerts',
					label: isFollowed ? 'Cycle Follow Alerts' : `Follow ${followNoun} With Alerts`,
					leading: '!',
					hint: getFollowAlertLabel(channel.id),
					onSelect: () => cycleFollowAlert(channel.id)
				},
				{
					id: 'toggle-follow',
					label: isFollowed ? `Unfollow ${followNoun}` : `Follow ${followNoun}`,
					leading: isFollowed ? '★' : '☆',
					onSelect: () => toggleChannelFollowState(channel.id)
				},
				{ id: 'follow-divider', type: 'separator' }
			);
		}

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

<div
	class="channel-sidebar"
	class:compact={isCompactSidebar}
	class:nav-right={!$layoutStore.isMobile && $layoutStore.navDock === 'right'}
	style:width={$layoutStore.isMobile ? '100%' : `${$layoutStore.channelSidebarWidth}px`}
>
	<div
		class="top-section"
		class:has-banner={Boolean(currentServerBannerUrl)}
		style:--sidebar-banner-image={currentServerBannerUrl ? `url('${currentServerBannerUrl}')` : 'none'}
	>
		<button class="mobile-close-btn" on:click={() => dispatch('close')}>&times;</button>
		<button type="button" class="server-identity" on:click={() => dispatch('openServerSwitcher')}>
			<div class="logo">
				{#if serverIdentityIconUrl && !serverIdentityImageFailed}
					<img
						src={serverIdentityIconUrl}
						alt={`${currentServerLabel} icon`}
						class="logo-img server-logo-img"
						on:error={() => (serverIdentityImageFailed = true)}
					/>
				{:else}
					<img src="/wabi-logo-small.webp" alt="Wabi" class="logo-img brand-logo-img" />
				{/if}
			</div>
			{#if !isCompactSidebar}
				<div class="server-copy">
					<strong class="server-name">{currentServerLabel}</strong>
				</div>
			{/if}
		</button>
		{#if sidebarWidth < 170 && !isCompactSidebar}
			<div class="header-buttons">
				<button
					class="control-btn compact-settings-btn"
					on:click={() => dispatch('openSettings')}
					title="User Settings"
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
				</button>
			</div>
		{/if}
	</div>

	{#if showCreateInput}
		<div class="create-channel">
			<input
				bind:this={newChannelNameInput}
				type="text"
				bind:value={newChannelName}
				placeholder={newChannelType === 'voice' ? 'voice-room' : 'channel-name'}
				on:keydown={(e) => e.key === 'Enter' && handleCreateChannel()}
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
				<option value="gallery">Gallery Channel</option>
				<option value="forum" disabled>Forum Channel (coming soon)</option>
			</select>
			<p class="create-channel-hint">Forum channels are planned but not supported yet.</p>
			<button on:click={handleCreateChannel}>
				Create {newChannelType === 'voice' ? 'Voice' : newChannelType === 'forum' ? 'Forum' : newChannelType === 'gallery' ? 'Gallery' : newChannelType === 'wiki' ? 'Wiki' : newChannelType === 'stage' ? 'Stage' : 'Text'} Channel
			</button>
		</div>
	{/if}

	<div class="channel-list">
		{#if $displayEnhancementSettingsStore.serverCounterEnabled}
			<div class="workspace-counter-chip" title="Server channel count">
				<span class="workspace-counter-label">Server</span>
				<span class="workspace-counter-value">{workspaceChannelCount} channels</span>
			</div>
		{/if}
		{#if $displayEnhancementSettingsStore.readAllNotificationsButtonEnabled && totalUnreadNotifications > 0}
			<div class="channel-list-actions">
				<button
					class="clear-unread-btn"
					on:click={clearAllUnreadNotifications}
				>
					Clear Unread ({totalUnreadNotifications})
				</button>
			</div>
		{/if}
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
				on:click={() => toggleCreateInputForType('text')}
				title="Create channel"
				aria-label="Create channel"
			>
				<span class="plus-glyph" aria-hidden="true">+</span>
			</button>
		</div>
		{#if isTextSectionExpanded}
		<!-- Public text channels -->
		{#each textChannels as channel (channel.id)}
			<div
				class="channel-item"
				class:active={$currentChannel === channel.id}
				class:has-timer={channel.autoDeleteAfter}
				class:followed={followedChannelIds.has(channel.id)}
				class:bookmarked={isChannelBookmarked(channel)}
				role="group"
				on:contextmenu={(e) => handleChannelRightClick(e, channel)}
				use:longpress={{ onLongPress: (e) => handleChannelLongPress(e, channel) }}
			>
				<button class="channel-btn" data-abbrev={channel.name.charAt(0).toUpperCase()} on:click={(event) => handleChannelButtonClick(channel.id, event)} title={channel.autoDeleteAfter ? `Auto-delete: ${channel.autoDeleteAfter}` : 'Alt-click to glimpse'}>
					<span class="hash">#</span>
					{channel.name}
					{#if $displayEnhancementSettingsStore.betterNsfwTagEnabled && isNsfwTaggedChannel(channel)}
						<span class="nsfw-tag">NSFW</span>
					{/if}
					{#if isChannelLocallyMuted(channel.id)}
						<span class="muted-tag">Muted</span>
					{/if}
					{#if isChannelBookmarked(channel)}
						<span class="bookmark-tag" title="Bookmarked for the quick switcher">Saved</span>
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
				<div
					class="channel-item"
					class:active={$currentChannel === channel.id}
					class:has-timer={channel.autoDeleteAfter}
					class:followed={followedChannelIds.has(channel.id)}
					class:bookmarked={isChannelBookmarked(channel)}
					role="group"
					on:contextmenu={(e) => handleChannelRightClick(e, channel)}
					use:longpress={{ onLongPress: (e) => handleChannelLongPress(e, channel) }}
				>
					<button class="channel-btn" data-abbrev={channel.name.charAt(0).toUpperCase()} on:click={(event) => handleChannelButtonClick(channel.id, event)} title={channel.autoDeleteAfter ? `Auto-delete: ${channel.autoDeleteAfter}` : 'Alt-click to glimpse'}>
						<svg class="group-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
						{channel.name}
						{#if $displayEnhancementSettingsStore.betterNsfwTagEnabled && isNsfwTaggedChannel(channel)}
							<span class="nsfw-tag">NSFW</span>
						{/if}
						{#if isChannelLocallyMuted(channel.id)}
							<span class="muted-tag">Muted</span>
						{/if}
						{#if isChannelBookmarked(channel)}
							<span class="bookmark-tag" title="Bookmarked for the quick switcher">Saved</span>
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
				on:click={() => toggleCreateInputForType('voice')}
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
				class:followed={followedChannelIds.has(channel.id)}
				class:voice-drop-target={voiceDropTargetChannelId === channel.id}
				role="group"
				on:dragover={(event) => handleVoiceChannelDragOver(event, channel.id)}
				on:dragleave={() => handleVoiceChannelDragLeave(channel.id)}
				on:drop={(event) => handleVoiceChannelDrop(event, channel.id)}
				on:contextmenu={(e) => handleChannelRightClick(e, channel)}
				use:longpress={{ onLongPress: (e) => handleChannelLongPress(e, channel) }}
			>
				<div class="voice-channel-main">
					<button class="channel-btn" data-abbrev={channel.name.charAt(0).toUpperCase()} on:click={() => handleVoiceChannelClick(channel.id)}>
						<span class="hash voice-icon" aria-hidden="true">
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
						</span>
						<span class="voice-channel-name">{channel.name}</span>
						{#if isVoiceChannelBeingRecorded(channel.id)}
							<span class="voice-recording-tag" title={`${getVoiceChannelRecordingCount(channel.id)} participant(s) recording in this call`}>
								REC {getVoiceChannelRecordingCount(channel.id)}
							</span>
						{/if}
					</button>
					<div class="voice-channel-actions">
						<span class="voice-inline-count voice-action-count" title={getVoiceOccupancyTitle(channel, members.length)}>
							<svg class="voice-count-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
							{formatVoiceOccupancy(channel, members.length)}
						</span>
						<button
							class="follow-btn voice-follow-btn"
							class:active={followedChannelIds.has(channel.id)}
							on:click|stopPropagation={(event) => toggleChannelFollowState(channel.id, event)}
							title={followedChannelIds.has(channel.id) ? 'Unfollow voice channel' : 'Follow voice channel'}
						>
							{followedChannelIds.has(channel.id) ? '★' : '☆'}
						</button>
						<button
							type="button"
							class="voice-whiteboard-btn"
							on:click|stopPropagation={(event) => openVoiceChannelWhiteboard(channel.id, event)}
							title="Open voice whiteboard"
							aria-label={`Open ${channel.name} whiteboard`}
						>
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<rect x="3" y="4" width="18" height="14" rx="2"></rect>
								<path d="M7 8h10"></path>
								<path d="M7 12h6"></path>
								<path d="M8 20h8"></path>
							</svg>
						</button>
					</div>
				</div>
				{#if members.length > 0}
					<div class="voice-channel-chips">
						{#each members.slice(0, 6) as member}
							{#if member.profilePicture}
								<img class="voice-chip-avatar" src={member.profilePicture} alt={member.username || ''} title={member.username || 'Unknown'} />
							{:else}
								<span class="voice-chip-avatar voice-chip-fallback" title={member.username || 'Unknown'}>
									{(member.username || '?').charAt(0).toUpperCase()}
								</span>
							{/if}
						{/each}
						{#if members.length > 6}
							<span class="voice-chip-more">+{members.length - 6}</span>
						{/if}
					</div>
				{/if}
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
							role="listitem"
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
					class:followed={followedChannelIds.has(breakout.id)}
					class:voice-drop-target={voiceDropTargetChannelId === breakout.id}
					role="group"
					on:dragover={(event) => handleVoiceChannelDragOver(event, breakout.id)}
					on:dragleave={() => handleVoiceChannelDragLeave(breakout.id)}
					on:drop={(event) => handleVoiceChannelDrop(event, breakout.id)}
					on:contextmenu={(e) => handleChannelRightClick(e, breakout)}
					use:longpress={{ onLongPress: (e) => handleChannelLongPress(e, breakout) }}
				>
					<button class="channel-btn" data-abbrev={breakout.name.charAt(0).toUpperCase()} on:click={() => handleVoiceChannelClick(breakout.id)}>
						<span class="breakout-prefix" aria-hidden="true">&gt;</span>
						<span class="voice-channel-name">{breakout.name}</span>
						{#if isVoiceChannelBeingRecorded(breakout.id)}
							<span class="voice-recording-tag" title={`${getVoiceChannelRecordingCount(breakout.id)} participant(s) recording in this call`}>
								REC {getVoiceChannelRecordingCount(breakout.id)}
							</span>
						{/if}
					</button>
					<div class="voice-channel-actions">
						<span class="voice-inline-count voice-action-count" title={getVoiceOccupancyTitle(breakout, breakoutMembers.length)}>
							<svg class="voice-count-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
							{formatVoiceOccupancy(breakout, breakoutMembers.length)}
						</span>
						<button
							class="follow-btn voice-follow-btn"
							class:active={followedChannelIds.has(breakout.id)}
							on:click|stopPropagation={(event) => toggleChannelFollowState(breakout.id, event)}
							title={followedChannelIds.has(breakout.id) ? 'Unfollow breakout voice channel' : 'Follow breakout voice channel'}
						>
							{followedChannelIds.has(breakout.id) ? '★' : '☆'}
						</button>
						<button
							type="button"
							class="voice-whiteboard-btn"
							on:click|stopPropagation={(event) => openVoiceChannelWhiteboard(breakout.id, event)}
							title="Open breakout whiteboard"
							aria-label={`Open ${breakout.name} whiteboard`}
						>
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<rect x="3" y="4" width="18" height="14" rx="2"></rect>
								<path d="M7 8h10"></path>
								<path d="M7 12h6"></path>
								<path d="M8 20h8"></path>
							</svg>
						</button>
					</div>
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
								role="listitem"
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

		{#if galleryChannels.length > 0}
		<div class="section-heading-row">
			<button
				class="section-toggle"
				type="button"
				aria-expanded={isGallerySectionExpanded}
				on:click={() => toggleSection('gallery')}
			>
				<span class="section-chevron" aria-hidden="true">
					<svg viewBox="0 0 24 24">
						<path d="M9 6l6 6-6 6"></path>
					</svg>
				</span>
				<span class="section-toggle-label">Gallery</span>
				<span class="section-count">{galleryChannels.length}</span>
			</button>
			<button
				class="section-add-btn"
				class:active={showCreateInput}
				on:click={() => toggleCreateInputForType('gallery')}
				title="Create gallery channel"
				aria-label="Create gallery channel"
			>
				<span class="plus-glyph" aria-hidden="true">+</span>
			</button>
		</div>
		{#if isGallerySectionExpanded}
		{#each galleryChannels as channel (channel.id)}
			<div
				class="channel-item"
				class:active={$currentChannel === channel.id}
				role="group"
				on:contextmenu={(e) => handleChannelRightClick(e, channel)}
				use:longpress={{ onLongPress: (e) => handleChannelLongPress(e, channel) }}
			>
				<button class="channel-btn" data-abbrev={channel.name.charAt(0).toUpperCase()} on:click={(event) => handleChannelButtonClick(channel.id, event)} title="Alt-click to glimpse">
					<span class="hash gallery-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<rect x="3" y="3" width="18" height="18" rx="2"/>
							<circle cx="8.5" cy="8.5" r="1.5"/>
							<path d="M21 15l-5-5L5 21"/>
						</svg>
					</span>
					{channel.name}
					{#if $channelUnreadCounts[channel.id] && $currentChannel !== channel.id}
						<span class="unread-badge">{formatBadge($channelUnreadCounts[channel.id])}</span>
					{/if}
				</button>
			</div>
		{/each}
		{/if}
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
				{#if canScreenShare()}
				<button class:active={$isSharing} on:click={handleToggleScreenShareInSidebar} title={$isSharing ? 'Stop sharing' : 'Share screen'}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
				</button>
				{/if}
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
						<div class="avatar-placeholder" style="--avatar-color: {$currentUser.color}">
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
					on:click={() => toggleDeafen()}
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
						<label for="channel-settings-name">Name</label>
						<input
							id="channel-settings-name"
							type="text"
							bind:value={tempChannelName}
							placeholder="Channel name"
							class="description-input"
							maxlength="64"
						/>
					</div>

					<div class="setting-group">
						<label for="channel-settings-description">Description</label>
						<input
							id="channel-settings-description"
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
						<span class="setting-label">Auto-Delete Messages</span>
						<p class="setting-description">Automatically delete messages after a set period of time</p>

						<div class="auto-delete-options">
							<button
								class="auto-delete-btn"
								class:active={!selectedChannelForSettings.autoDeleteAfter}
								on:click={() => handleUpdateAutoDelete(null)}
							>
								Never
							</button>
							{#each MESSAGE_RETENTION_PRESETS as duration}
								<button
									class="auto-delete-btn"
									class:active={selectedChannelForSettings.autoDeleteAfter === duration}
									on:click={() => handleUpdateAutoDelete(duration)}
								>
									{MESSAGE_RETENTION_LABELS[duration]}
								</button>
							{/each}
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
