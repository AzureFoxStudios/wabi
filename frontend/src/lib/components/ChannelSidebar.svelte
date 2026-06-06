<script lang="ts">
	import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
	import {
		channels,
		currentChannel,
		joinChannel,
		createChannel,
		createThread,
		deleteChannel,
		markMessagesAsRead,
		markChannelAsRead,
		updateChannelSettings,
		channelUnreadCounts,
		activeVoiceChannel as socketActiveVoiceChannel,
		currentUser,
		voiceChannelMembers,
		joinVoiceChannel,
		leaveVoiceChannel,
		subscribeVoiceChannel,
		unsubscribeVoiceChannel,
		setVoiceTransmitMode,
		createBreakoutRooms,
		closeBreakoutRooms,
		moveUserToVoiceChannel,
		pinChannel,
		unpinChannel
	} from '$lib/socket';
	import {
		activeVoiceChannel as callActiveVoiceChannel,
		openChannelCallPanel,
		callMode,
		channelCallPanelOpen,
		listeningVoiceChannels
	} from '$lib/calling';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import PinnedMessagesModal from './PinnedMessagesModal.svelte';
	import UserPopout from './UserPopout.svelte';
	import ChannelSettingsModal from './sidebar/ChannelSettingsModal.svelte';
	import TextChannelList from './sidebar/TextChannelList.svelte';
	import VoiceChannelList from './sidebar/VoiceChannelList.svelte';
	import GalleryChannelList from './sidebar/GalleryChannelList.svelte';
	import VoiceUserCard from './sidebar/VoiceUserCard.svelte';
	import ProfileCard from './sidebar/ProfileCard.svelte';
	import CreateChannelForm from './sidebar/CreateChannelForm.svelte';
	import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';
	import type { ContextMenuItem } from '$lib/context-menu/types';
	import type { Channel } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import { currentSavedServer } from '$lib/savedServers';
	import { resolveServerUrl } from '$lib/serverUrl';
	import { openDetachedPanel } from '$lib/detachedPanels';
	import { floatingPanelStore } from '$lib/windowing/floatingPanelStore';
	import {
		FOLLOW_ALERT_LEVEL_LABELS,
		currentServerFollowedChannels,
		cycleChannelFollowAlertLevel,
		toggleChannelFollow
	} from '$lib/following';
	import { setWhiteboardSurface } from '$lib/whiteboard/whiteboardSurface';
	import { displayEnhancementSettingsStore, toggleMutedChannelId } from '$lib/displayEnhancements';

	const dispatch = createEventDispatcher();
	export let activeView: 'chat' | 'screen' | 'following' = 'chat';

	let newChannelName = '';
	let newChannelDescription = '';
	let newChannelType: 'text' | 'voice' | 'forum' | 'gallery' | 'wiki' | 'stage' = 'text';
	let showCreateInput = false;
	let serverIdentityImageFailed = false;
	let lastServerIdentityIconUrl: string | null = null;
	let showDeleteConfirm = false;
	let channelToDelete = '';
	let showPinnedModal = false;
	let selectedChannelForPinned = '';
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

	$: sidebarWidth = $layoutStore.channelSidebarWidth;
	$: isCompactSidebar = sidebarWidth === 60;
	$: runtimeActiveVoiceChannelId = $callActiveVoiceChannel?.id || $socketActiveVoiceChannel || null;
	$: connectedVoiceChannelIds = (() => {
		const ids = new Set<string>();
		for (const id of $listeningVoiceChannels) ids.add(id);
		if (runtimeActiveVoiceChannelId) ids.add(runtimeActiveVoiceChannelId);
		return ids;
	})();
	$: primaryVoiceChannelId = runtimeActiveVoiceChannelId || $listeningVoiceChannels[0] || null;
	$: currentServerLabel = $currentSavedServer?.effectiveName || (() => { try { return new URL(resolveServerUrl().url).hostname; } catch { return 'Wabi'; } })();
	$: currentServerBannerUrl = $currentSavedServer?.effectiveBannerUrl || null;
	$: serverIdentityIconUrl = $currentSavedServer?.effectiveIconUrl || null;
	$: if (serverIdentityIconUrl !== lastServerIdentityIconUrl) { lastServerIdentityIconUrl = serverIdentityIconUrl; serverIdentityImageFailed = false; }
	$: followedChannelIds = new Set($currentServerFollowedChannels.map(e => e.channelId));
	$: followedChannelPreferences = new Map($currentServerFollowedChannels.map(e => [e.channelId, e]));

	let contextMenuChannel: Channel | null = null;
	let contextMenuPosition = { x: 0, y: 0 };
	let showContextMenu = false;
	let showOwnProfilePopout = false;
	let ownProfilePopoutAnchor: HTMLElement | null = null;

	function toggleSidebar() { layoutStore.channelSidebarWidth.set($layoutStore.channelSidebarWidth === 0 ? 280 : 0); }
	function openOwnProfilePopout(event: Event) { if (!$currentUser) return; ownProfilePopoutAnchor = event.currentTarget as HTMLElement | null; showOwnProfilePopout = true; }
	function isChannelLocallyMuted(id: string) { return $displayEnhancementSettingsStore.mutedChannelIds.includes(id); }
	function shouldHideChannelFromList(ch: Channel) { return $displayEnhancementSettingsStore.hideMutedCategoriesEnabled && $currentChannel !== ch.id && isChannelLocallyMuted(ch.id); }

	$: textChannels = $channels.filter(ch => !ch.type || ch.type === 'public' || ch.type === 'text').filter(ch => !shouldHideChannelFromList(ch)).sort((a, b) => { if (a.id === 'general') return -1; if (b.id === 'general') return 1; return a.name.localeCompare(b.name); });
	$: groupChannels = $channels.filter(ch => ch.type === 'group').filter(ch => !shouldHideChannelFromList(ch));
	$: threadChannels = $channels.filter(ch => ch.type === 'thread_public' || ch.type === 'thread_private').sort((a, b) => (b.threadLastActivityAt || b.createdAt || 0) - (a.threadLastActivityAt || a.createdAt || 0));
	$: threadChannelsByParent = threadChannels.reduce((acc: Record<string, Channel[]>, t) => { const p = t.parentChannelId; if (!p) return acc; (acc[p] ||= []).push(t); return acc; }, {});
	$: allVoiceChannels = $channels.filter(ch => ch.type === 'voice').filter(ch => !shouldHideChannelFromList(ch)).sort((a, b) => { if (a.id === 'voice') return -1; if (b.id === 'voice') return 1; return a.name.localeCompare(b.name); });
	$: breakoutChannelsByParent = allVoiceChannels.filter(ch => ch.isBreakout && ch.parentChannelId).reduce((acc: Record<string, Channel[]>, ch) => { const p = ch.parentChannelId!; (acc[p] ||= []).push(ch); return acc; }, {});
	$: Object.values(breakoutChannelsByParent).forEach(r => r.sort((a, b) => (a.breakoutIndex || 0) - (b.breakoutIndex || 0)));
	$: voiceChannels = allVoiceChannels.filter(ch => !ch.isBreakout);
	$: galleryChannels = $channels.filter(ch => ch.type === 'gallery').filter(ch => !shouldHideChannelFromList(ch)).sort((a, b) => a.name.localeCompare(b.name));
	$: workspaceChannelCount = textChannels.length + groupChannels.length + voiceChannels.length + galleryChannels.length;
	$: totalUnreadNotifications = Object.values($channelUnreadCounts).reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
	$: canTogglePersistMessages = $currentUser?.highestRole === 'owner';
	$: canManageWatchQueue = $currentUser?.highestRole === 'owner' || $currentUser?.highestRole === 'admin';
	$: canManageVoiceSettings = $currentUser?.highestRole === 'owner' || $currentUser?.highestRole === 'admin';
	$: canModerateVoiceMembers = ['owner', 'admin', 'mod'].includes($currentUser?.highestRole || '');
	$: {
		const prev = voicePresenceSince; const next = new Map<string, number>(); const at = Date.now();
		const selfId = $currentUser?.dbUserId ? `user-${$currentUser.dbUserId}` : $currentUser?.id || null;
		for (const ch of allVoiceChannels) { for (const m of getVoiceMembers(ch.id)) next.set(`${ch.id}::${m.userId}`, prev.get(`${ch.id}::${m.userId}`) ?? at); if (selfId && isConnectedToVoice(ch.id)) next.set(`${ch.id}::${selfId}`, prev.get(`${ch.id}::${selfId}`) ?? at); }
		voicePresenceSince = next;
	}

	onMount(() => {
		try { const s = localStorage.getItem('wabi-voice-duration-mode'); if (s === 'off' || s === 'others' || s === 'all') voiceDurationMode = s; } catch {}
		voiceDurationTicker = setInterval(() => { nowMs = Date.now(); }, 1000);
		const onPtr = (e: PointerEvent) => { if (!glimpseChannelId) return; const t = e.target as HTMLElement | null; if (!t || glimpsePopover?.contains(t) || t.closest('.channel-btn')) return; glimpseChannelId = null; };
		const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && glimpseChannelId) glimpseChannelId = null; };
		document.addEventListener('pointerdown', onPtr); document.addEventListener('keydown', onKey);
		return () => { document.removeEventListener('pointerdown', onPtr); document.removeEventListener('keydown', onKey); };
	});
	onDestroy(() => { if (voiceDurationTicker) { clearInterval(voiceDurationTicker); voiceDurationTicker = null; } });

	$: if (activeView === 'chat') markMessagesAsRead();

	function handleChannelClick(id: string) { activeView = 'chat'; glimpseChannelId = null; joinChannel(id); if ($callMode === 'channel') channelCallPanelOpen.set(false); dispatch('close'); }
	function clearAllUnreadNotifications() { for (const id of Object.keys($channelUnreadCounts)) markChannelAsRead(id); markMessagesAsRead(); }
	function openFollowingView() { activeView = 'following'; glimpseChannelId = null; dispatch('close'); }
	function openVoiceChannelWhiteboard(id: string, e?: Event) { e?.stopPropagation(); activeView = 'chat'; currentChannel.set(id); setWhiteboardSurface(id, 'whiteboard'); dispatch('close'); }
	function toggleChannelFollowState(id: string, e?: Event) { e?.stopPropagation(); const f = toggleChannelFollow(id); if (!f && glimpseChannelId === id) glimpseChannelId = null; }
	function cycleFollowAlert(id: string, e?: Event) { e?.stopPropagation(); if (!followedChannelIds.has(id)) toggleChannelFollow(id); cycleChannelFollowAlertLevel(id); }
	function toggleChannelGlimpse(id: string) { glimpseChannelId = glimpseChannelId === id ? null : id; }
	function handleChannelButtonClick(id: string, e: MouseEvent) { if (e.altKey) { e.preventDefault(); e.stopPropagation(); toggleChannelGlimpse(id); return; } handleChannelClick(id); }
	function handleCreateThread(ch: Channel) { const n = window.prompt(`Create a thread in #${ch.name}`, `${ch.name} thread`)?.trim(); if (n) createThread(ch.id, n); }
	function getVoiceMembers(id: string) { return $voiceChannelMembers[id] || []; }
	function isConnectedToVoice(id: string) { return connectedVoiceChannelIds.has(id); }
	function isPrimaryVoiceChannel(id: string) { return primaryVoiceChannelId === id; }
	async function handleVoiceChannelClick(id: string) { if (isConnectedToVoice(id)) { openChannelCallPanel(); dispatch('close'); return; } if (runtimeActiveVoiceChannelId) { subscribeVoiceChannel(id); return; } try { await joinVoiceChannel(id); dispatch('close'); } catch (e) { console.error('Failed to join voice channel:', e); } }
	function handleToggleListenChannel(id: string) { if (isPrimaryVoiceChannel(id)) return; isConnectedToVoice(id) ? unsubscribeVoiceChannel(id) : subscribeVoiceChannel(id); }
	function handleTransmitModeChange(e: Event) { setVoiceTransmitMode((e.currentTarget as HTMLSelectElement).value as 'auto' | 'always' | 'push-to-talk'); }
	async function handleLeaveVoice() { if (primaryVoiceChannelId) { await leaveVoiceChannel(primaryVoiceChannelId); return; } for (const id of connectedVoiceChannelIds) unsubscribeVoiceChannel(id); }
	function hasBreakoutRooms(id: string) { return (breakoutChannelsByParent[id] || []).length > 0; }
	function handleCreateBreakoutRooms(ch: Channel) { const n = Math.max(2, Math.ceil(getVoiceMembers(ch.id).length / 2)); const r = window.prompt(`Create breakout rooms for ${ch.name} (2-20):`, String(n)); const p = Number.parseInt(r || '', 10); if (Number.isFinite(p)) createBreakoutRooms(ch.id, p, true); }
	function handleCloseBreakoutRooms(ch: Channel) { closeBreakoutRooms(ch.id); }
	function canDragVoiceMember(uid: string) { return !!$currentUser && (uid === $currentUser.id || ($currentUser.dbUserId && uid === `user-${$currentUser.dbUserId}`) || canModerateVoiceMembers); }
	function handleVoiceMemberDragStart(e: DragEvent, chId: string, uid: string) { if (!canDragVoiceMember(uid)) { e.preventDefault(); return; } draggedVoiceMember = { userId: uid, channelId: chId }; voiceDropTargetChannelId = null; if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', JSON.stringify(draggedVoiceMember)); } }
	function handleVoiceMemberDragEnd() { draggedVoiceMember = null; voiceDropTargetChannelId = null; }
	function handleVoiceChannelDragOver(e: DragEvent, chId: string) { if (!draggedVoiceMember || draggedVoiceMember.channelId === chId) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; voiceDropTargetChannelId = chId; }
	function handleVoiceChannelDragLeave(chId: string) { if (voiceDropTargetChannelId === chId) voiceDropTargetChannelId = null; }
	function handleVoiceChannelDrop(e: DragEvent, chId: string) { if (!draggedVoiceMember || draggedVoiceMember.channelId === chId) return; e.preventDefault(); e.stopPropagation(); moveUserToVoiceChannel(draggedVoiceMember.userId, chId); draggedVoiceMember = null; voiceDropTargetChannelId = null; }
	function setVoiceDurationMode(mode: 'off' | 'others' | 'all') { voiceDurationMode = mode; try { localStorage.setItem('wabi-voice-duration-mode', mode); } catch {} }
	function toggleSection(s: 'text' | 'voice' | 'gallery') { if (s === 'text') isTextSectionExpanded = !isTextSectionExpanded; else if (s === 'gallery') isGallerySectionExpanded = !isGallerySectionExpanded; else isVoiceSectionExpanded = !isVoiceSectionExpanded; }
	function handleCreateChannel() { if (newChannelName.trim()) { createChannel(newChannelName.trim(), newChannelDescription.trim(), newChannelType); newChannelName = ''; newChannelDescription = ''; newChannelType = 'text'; showCreateInput = false; } }
	function toggleCreateInputForType(t: 'text' | 'voice' | 'forum' | 'gallery' | 'wiki' | 'stage') { if (showCreateInput && newChannelType === t) { showCreateInput = false; return; } newChannelType = t; showCreateInput = true; tick().then(() => (document.querySelector('.create-channel input') as HTMLInputElement | null)?.focus()); }
	function handleDeleteChannel(id: string) { channelToDelete = id; showDeleteConfirm = true; }
	function confirmDeleteChannel() { deleteChannel(channelToDelete); showDeleteConfirm = false; }
	function handleShowPinnedMessages(id: string) { selectedChannelForPinned = id; showPinnedModal = true; }
	function handleOpenChannelSettings(ch: Channel) { selectedChannelForSettings = ch; showChannelSettingsModal = true; }
	function handleSaveChannelSettings(e: CustomEvent<{ channelId: string; updates: Parameters<typeof updateChannelSettings>[1] }>) { updateChannelSettings(e.detail.channelId, e.detail.updates); showChannelSettingsModal = false; }
	function handleChannelLongPress(e: TouchEvent, ch: Channel) { const t = e.touches?.[0] || e.changedTouches?.[0]; if (t) handleChannelRightClick(new MouseEvent('contextmenu', { clientX: t.clientX, clientY: t.clientY, bubbles: true }), ch); }
	function handleChannelRightClick(e: MouseEvent, ch: Channel) { e.preventDefault(); contextMenuChannel = ch; contextMenuPosition = { x: e.clientX, y: e.clientY }; showContextMenu = true; }
	function closeContextMenu() { showContextMenu = false; contextMenuChannel = null; }
	function isChannelBookmarked(ch: Channel) { return !!$currentUser?.id && (ch.pinnedBy?.includes($currentUser.id) ?? false); }
	function toggleChannelBookmark(ch: Channel) { isChannelBookmarked(ch) ? unpinChannel(ch.id) : pinChannel(ch.id); }
	function openChannelFloatingPanel(ch: Channel) {
		floatingPanelStore.openFloatingPanel({
			kind: 'channel-chat',
			title: `#${ch.name}`,
			payload: { channelId: ch.id, channelName: ch.name }
		});
	}

	$: channelMenuItems = contextMenuChannel ? buildChannelMenuItems(contextMenuChannel) : [];
	function buildChannelMenuItems(ch: Channel): ContextMenuItem[] {
		const sup = ch.type === 'text' || ch.type === 'public' || ch.type === 'group' || !ch.type;
		const noun = ch.type === 'group' ? 'Group' : 'Channel';
		const followed = sup && followedChannelIds.has(ch.id);
		const items: ContextMenuItem[] = [
			{ id: 'open-floating-panel', label: 'Open floating panel', icon: 'message-circle', onSelect: () => openChannelFloatingPanel(ch) },
			{ id: 'open-os-window', label: 'Open OS window', icon: 'external-window', onSelect: () => openDetachedPanel({ kind: 'channel-chat', channelId: ch.id, channelName: ch.name }) },
			{ id: 'windowing-divider', type: 'separator' },
			{ id: 'pin-channel', label: isChannelBookmarked(ch) ? 'Remove Bookmark' : 'Bookmark Channel', icon: 'pin', onSelect: () => toggleChannelBookmark(ch) },
			{ id: 'pinned-messages', label: 'Pinned Messages', icon: 'pin', onSelect: () => handleShowPinnedMessages(ch.id) },
			{ id: 'toggle-mute-channel', label: isChannelLocallyMuted(ch.id) ? 'Unmute Channel' : 'Mute Channel', onSelect: () => toggleMutedChannelId(ch.id) },
			{ id: 'channel-settings', label: 'Channel Settings', icon: 'settings', onSelect: () => handleOpenChannelSettings(ch) }
		];
		if (sup) items.unshift(
			{ id: 'follow-feed', label: 'Open Follow Feed', leading: '≈', hint: $currentServerFollowedChannels.length > 0 ? `${$currentServerFollowedChannels.length} followed` : undefined, disabled: $currentServerFollowedChannels.length === 0, onSelect: openFollowingView },
			{ id: 'follow-alerts', label: followed ? 'Cycle Follow Alerts' : `Follow ${noun} With Alerts`, leading: '!', hint: FOLLOW_ALERT_LEVEL_LABELS[followedChannelPreferences.get(ch.id)?.alertLevel || 'off'], onSelect: () => cycleFollowAlert(ch.id) },
			{ id: 'toggle-follow', label: followed ? `Unfollow ${noun}` : `Follow ${noun}`, leading: followed ? '★' : '☆', onSelect: () => toggleChannelFollowState(ch.id) },
			{ id: 'follow-divider', type: 'separator' }
		);
		if (ch.type === 'text' || ch.type === 'public' || !ch.type) items.splice(1, 0, { id: 'create-thread', label: 'Create Thread', icon: 'message-circle', onSelect: () => handleCreateThread(ch) });
		if (ch.type === 'voice' && !ch.isBreakout) {
			items.push({ id: 'voice-divider', type: 'separator' });
			items.push(hasBreakoutRooms(ch.id) ? { id: 'close-breakout-rooms', label: 'Close Breakout Rooms', icon: 'archive-restore', onSelect: () => handleCloseBreakoutRooms(ch) } : { id: 'create-breakout-rooms', label: 'Create Breakout Rooms', icon: 'archive', onSelect: () => handleCreateBreakoutRooms(ch) });
		}
		if (ch.id !== 'general' && ch.id !== 'voice' && !ch.isBreakout) items.push({ id: 'danger-divider', type: 'separator' }, { id: 'delete-channel', label: 'Delete Channel', icon: 'trash-2', danger: true, onSelect: () => handleDeleteChannel(ch.id) });
		return items;
	}
</script>

{#if sidebarWidth === 0}
	<button class="expand-btn" on:click={toggleSidebar} title="Expand sidebar">›</button>
{/if}

<div class="channel-sidebar" class:compact={isCompactSidebar} class:nav-right={!$layoutStore.isMobile && $layoutStore.navDock === 'right'} style:width={$layoutStore.isMobile ? '100%' : `${$layoutStore.channelSidebarWidth}px`}>
	<div class="top-section" class:has-banner={Boolean(currentServerBannerUrl)} style:--sidebar-banner-image={currentServerBannerUrl ? `url('${currentServerBannerUrl}')` : 'none'}>
		<button class="mobile-close-btn" on:click={() => dispatch('close')}>&times;</button>
		<button type="button" class="server-identity" on:click={() => dispatch('openServerSwitcher')}>
			<div class="logo">
				{#if serverIdentityIconUrl && !serverIdentityImageFailed}
					<img src={serverIdentityIconUrl} alt={`${currentServerLabel} icon`} class="logo-img server-logo-img" on:error={() => (serverIdentityImageFailed = true)} />
				{:else}
					<img src="/wabi-logo-small.webp" alt="Wabi" class="logo-img brand-logo-img" />
				{/if}
			</div>
			{#if !isCompactSidebar}
				<div class="server-copy"><strong class="server-name">{currentServerLabel}</strong></div>
			{/if}
		</button>
		{#if sidebarWidth < 170 && !isCompactSidebar}
			<div class="header-buttons">
				<button class="control-btn compact-settings-btn" on:click={() => dispatch('openSettings')} title="User Settings">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
				</button>
			</div>
		{/if}
	</div>

	<CreateChannelForm {showCreateInput} newChannelName={newChannelName} newChannelDescription={newChannelDescription} {newChannelType} onNameChange={(v) => newChannelName = v} onDescriptionChange={(v) => newChannelDescription = v} onTypeChange={(v) => newChannelType = v} onSubmit={handleCreateChannel} />

	<div class="channel-list">
		{#if $displayEnhancementSettingsStore.serverCounterEnabled}
			<div class="workspace-counter-chip" title="Server channel count"><span class="workspace-counter-label">Server</span><span class="workspace-counter-value">{workspaceChannelCount} channels</span></div>
		{/if}
		{#if $displayEnhancementSettingsStore.readAllNotificationsButtonEnabled && totalUnreadNotifications > 0}
			<div class="channel-list-actions"><button class="clear-unread-btn" on:click={clearAllUnreadNotifications}>Clear Unread ({totalUnreadNotifications})</button></div>
		{/if}

		<div class="section-heading-row">
			<button class="section-toggle" type="button" aria-expanded={isTextSectionExpanded} on:click={() => toggleSection('text')}>
				<span class="section-chevron" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"></path></svg></span>
				<span class="section-toggle-label">Text Channels</span><span class="section-count">{textChannels.length + groupChannels.length}</span>
			</button>
			<button class="section-add-btn" class:active={showCreateInput} on:click={() => toggleCreateInputForType('text')} title="Create channel" aria-label="Create channel"><span class="plus-glyph" aria-hidden="true">+</span></button>
		</div>
		{#if isTextSectionExpanded}
			<TextChannelList {textChannels} {groupChannels} {threadChannelsByParent} {followedChannelIds} {followedChannelPreferences} onChannelClick={handleChannelClick} onChannelButtonClick={handleChannelButtonClick} onChannelRightClick={handleChannelRightClick} onChannelLongPress={handleChannelLongPress} onToggleChannelFollow={toggleChannelFollowState} onCycleFollowAlert={cycleFollowAlert} onOpenChannelSettings={handleOpenChannelSettings} onShowPinnedMessages={handleShowPinnedMessages} />
		{/if}

		<div class="section-heading-row">
			<button class="section-toggle" type="button" aria-expanded={isVoiceSectionExpanded} on:click={() => toggleSection('voice')}>
				<span class="section-chevron" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"></path></svg></span>
				<span class="section-toggle-label">Voice Channels</span><span class="section-count">{allVoiceChannels.length}</span>
			</button>
			<button class="section-add-btn" class:active={showCreateInput} on:click={() => toggleCreateInputForType('voice')} title="Create channel" aria-label="Create channel"><span class="plus-glyph" aria-hidden="true">+</span></button>
		</div>
		{#if isVoiceSectionExpanded}
			<VoiceChannelList {voiceChannels} {allVoiceChannels} {breakoutChannelsByParent} {connectedVoiceChannelIds} {runtimeActiveVoiceChannelId} {voiceDropTargetChannelId} {voicePresenceSince} {voiceDurationMode} {nowMs} {followedChannelIds} onVoiceChannelClick={handleVoiceChannelClick} onChannelRightClick={handleChannelRightClick} onChannelLongPress={handleChannelLongPress} onToggleChannelFollow={toggleChannelFollowState} onToggleListenChannel={handleToggleListenChannel} onOpenVoiceChannelWhiteboard={openVoiceChannelWhiteboard} onVoiceMemberDragStart={handleVoiceMemberDragStart} onVoiceMemberDragEnd={handleVoiceMemberDragEnd} onVoiceChannelDragOver={handleVoiceChannelDragOver} onVoiceChannelDragLeave={handleVoiceChannelDragLeave} onVoiceChannelDrop={handleVoiceChannelDrop} />
		{/if}

		{#if galleryChannels.length > 0}
			<div class="section-heading-row">
				<button class="section-toggle" type="button" aria-expanded={isGallerySectionExpanded} on:click={() => toggleSection('gallery')}>
					<span class="section-chevron" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"></path></svg></span>
					<span class="section-toggle-label">Gallery</span><span class="section-count">{galleryChannels.length}</span>
				</button>
				<button class="section-add-btn" class:active={showCreateInput} on:click={() => toggleCreateInputForType('gallery')} title="Create gallery channel" aria-label="Create gallery channel"><span class="plus-glyph" aria-hidden="true">+</span></button>
			</div>
			{#if isGallerySectionExpanded}
				<GalleryChannelList {galleryChannels} {followedChannelIds} onChannelClick={handleChannelClick} onChannelButtonClick={handleChannelButtonClick} onChannelRightClick={handleChannelRightClick} onChannelLongPress={handleChannelLongPress} />
			{/if}
		{/if}
	</div>

	<ContextMenu open={showContextMenu && !!contextMenuChannel} x={contextMenuPosition.x} y={contextMenuPosition.y} items={channelMenuItems} ariaLabel="Channel actions" headerLabel={contextMenuChannel ? `#${contextMenuChannel.name}` : null} on:close={closeContextMenu} />
	<VoiceUserCard {runtimeActiveVoiceChannelId} {voiceChannels} {voiceDurationMode} onToggleListenChannel={handleToggleListenChannel} onTransmitModeChange={handleTransmitModeChange} onSetVoiceDurationMode={setVoiceDurationMode} onLeaveVoice={handleLeaveVoice} />
	<ProfileCard {sidebarWidth} on:openProfilePopout={openOwnProfilePopout} on:openSettings={() => dispatch('openSettings')} />
</div>

<ConfirmDialog isOpen={showDeleteConfirm} title="Delete Channel" message="Delete channel #{channelToDelete}? This action cannot be undone." confirmText="Delete" variant="danger" onConfirm={confirmDeleteChannel} onCancel={() => showDeleteConfirm = false} />
<PinnedMessagesModal bind:isOpen={showPinnedModal} channelId={selectedChannelForPinned} />
<UserPopout user={$currentUser} bind:isOpen={showOwnProfilePopout} anchorElement={ownProfilePopoutAnchor} isOwnProfile={true} on:close={() => (showOwnProfilePopout = false)} on:openFullProfile={() => dispatch('openSettings')} />
{#if showChannelSettingsModal && selectedChannelForSettings}
	<ChannelSettingsModal channel={selectedChannelForSettings} {canTogglePersistMessages} {canManageWatchQueue} {canManageVoiceSettings} on:save={handleSaveChannelSettings} on:close={() => (showChannelSettingsModal = false)} />
{/if}
