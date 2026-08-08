<script lang="ts">
	import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
	import { brandName } from '$lib/branding';
	import {
		channels,
		currentChannel,
		switchChannel,
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
		unpinChannel,
		reorderChannels
	} from '$lib/socket';
	import { createChannel } from '$lib/channelStore';
	import {
		activeVoiceChannel as callActiveVoiceChannel,
		openChannelCallPanel,
		callMode,
		channelCallPanelOpen,
		listeningVoiceChannels,
		setVoiceTransmitRoutingMode
	} from '$lib/calling';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import { longpress } from '$lib/actions/longpress';
	import PinnedMessagesModal from './PinnedMessagesModal.svelte';
	import UserPopout from './UserPopout.svelte';
	import ChannelSettingsModal from './sidebar/ChannelSettingsModal.svelte';
	import TextChannelList from './sidebar/TextChannelList.svelte';
	import VoiceChannelList from './sidebar/VoiceChannelList.svelte';
	import GalleryChannelList from './sidebar/GalleryChannelList.svelte';
	import ForumChannelList from './sidebar/ForumChannelList.svelte';
	import WikiChannelList from './sidebar/WikiChannelList.svelte';
	import LoreChannelList from './sidebar/LoreChannelList.svelte';
	import UnifiedChannelList from './sidebar/UnifiedChannelList.svelte';
	import VoiceUserCard from './sidebar/VoiceUserCard.svelte';
	import ProfileCard from './sidebar/ProfileCard.svelte';
	import CreateChannelForm from './sidebar/CreateChannelForm.svelte';
	import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';
	import type { ContextMenuItem } from '$lib/context-menu/types';
	import type { Channel } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import { selectedDmChannelId } from '$lib/layoutStoreStates';
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
	import { displayEnhancementSettingsStore } from '$lib/displayEnhancements';
	import { isServerChannelMuted, toggleServerMutedChannelId } from '$lib/serverSettings';
	import { whiteboardPresence } from '$lib/presenceStore';
	import { hasAddonCapability } from '$lib/addonInventory';
	import type { CreateableChannelType } from '$lib/channelStore';

	const dispatch = createEventDispatcher();
	export let activeView: 'chat' | 'business' | 'screen' | 'following' | 'dm' = 'chat';

	let newChannelName = '';
	let newChannelDescription = '';
	let newChannelType: CreateableChannelType = 'text';
	let newChannelForceSpoiler = false;
	let createChannelError = '';
	let creatingChannel = false;
	let showCreateInput = false;
	/** Folder placement for new channels: 'none' | categoryId | '__new__' */
	let createFolderChoice = 'none';
	let createNewFolderName = '';
	/** A6: Asset Storage option only when lore addon is enabled on this server. */
	let loreAvailable = false;
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
	let isForumSectionExpanded = true;
	let isWikiSectionExpanded = true;
	let isLoreSectionExpanded = true;
	let isPlanningSectionExpanded = true;
	let collapsedCategories = new Set<string>();
	function toggleCategory(id: string) {
		if (collapsedCategories.has(id)) collapsedCategories.delete(id);
		else collapsedCategories.add(id);
		collapsedCategories = collapsedCategories;
	}
	let voiceDurationMode: 'off' | 'others' | 'all' = 'off';
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
	$: currentServerLabel = $currentSavedServer?.effectiveName || (() => { try { return new URL(resolveServerUrl().url).hostname; } catch { return brandName; } })();
	$: currentServerBannerUrl = $currentSavedServer?.effectiveBannerUrl || null;
	$: serverIdentityIconUrl = $currentSavedServer?.effectiveIconUrl || null;
	$: currentServerTagline = $currentSavedServer?.effectiveTagline || null;
	$: if (serverIdentityIconUrl !== lastServerIdentityIconUrl) { lastServerIdentityIconUrl = serverIdentityIconUrl; serverIdentityImageFailed = false; }
	$: followedChannelIds = new Set($currentServerFollowedChannels.map(e => e.channelId));
	$: followedChannelPreferences = new Map($currentServerFollowedChannels.map(e => [e.channelId, e]));
	$: liveWhiteboardChannelIds = new Set(
		Object.entries($whiteboardPresence)
			.filter(([, users]) => Array.isArray(users) && users.length > 0)
			.map(([channelId]) => channelId)
	);

	let contextMenuChannel: Channel | null = null;
	let contextMenuPosition = { x: 0, y: 0 };
	let showContextMenu = false;
	let showOwnProfilePopout = false;
	let ownProfilePopoutAnchor: HTMLElement | null = null;

	function openOwnProfilePopout(event: Event) { if (!$currentUser) return; ownProfilePopoutAnchor = event.currentTarget as HTMLElement | null; showOwnProfilePopout = true; }
	function isChannelLocallyMuted(id: string) { return isServerChannelMuted(id); }
	function shouldHideChannelFromList(ch: Channel) { return $displayEnhancementSettingsStore.hideMutedCategoriesEnabled && $currentChannel !== ch.id && isChannelLocallyMuted(ch.id); }

		function sortByPosition(channels: Channel[]): Channel[] {
		return [...channels].sort((a, b) => (a.position ?? 999) - (b.position ?? 999) || a.name.localeCompare(b.name));
	}

	/**
	 * Categories are first-class channels (type === 'category'). Every such
	 * channel renders as a folder header (even when empty, so users can drag
	 * channels in). A channel belongs to a category when its `parentId` points
	 * at a category channel; everything else is uncategorized / free-floating.
	 */
	function groupByCategory(channels: Channel[], all: Channel[]): { categories: { id: string; name: string; channel: Channel; channels: Channel[] }[]; uncategorized: Channel[] } {
		const categoryChannels = all
			.filter((c) => (c.type as string | undefined) === 'category')
			.sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
		const seenCat = new Set<string>();
		const uniqueCats = categoryChannels.filter((c) => {
			const id = String(c.id || '').trim();
			if (!id || seenCat.has(id)) return false;
			seenCat.add(id);
			return true;
		});
		const categoryIds = new Set(uniqueCats.map((c) => c.id));
		const categories = uniqueCats.map((cat) => ({
			id: cat.id,
			name: cat.name,
			channel: cat,
			channels: sortByPosition(channels.filter((ch) => ch.parentId === cat.id))
		}));
		const uncategorized = channels.filter((ch) => !ch.parentId || !categoryIds.has(ch.parentId));
		return { categories, uncategorized: sortByPosition(uncategorized) };
	}

	/** B6: non-text sections only surface categories that actually hold channels here. */
	function nonEmptyCategories(categories: { id: string; name: string; channel: Channel; channels: Channel[] }[]) {
		return categories.filter((c) => c.channels.length > 0);
	}

	$: textChannelsAll = $channels.filter(ch => { const t = ch.type as string | undefined; return (!t || t === 'public' || t === 'text' || t === 'live') && t !== 'lore'; }).filter(ch => !shouldHideChannelFromList(ch));
	$: textChannelsByPos = sortByPosition([...textChannelsAll]);
	$: textCategoryMap = groupByCategory(textChannelsAll, $channels);
	$: groupChannels = $channels.filter(ch => ch.type === 'group').filter(ch => !shouldHideChannelFromList(ch));
	$: allCategories = $channels.filter(ch => (ch.type as string | undefined) === 'category').sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
	$: threadChannels = $channels.filter(ch => ch.type === 'thread_public' || ch.type === 'thread_private').sort((a, b) => (b.threadLastActivityAt || b.createdAt || 0) - (a.threadLastActivityAt || a.createdAt || 0));
	$: threadChannelsByParent = threadChannels.reduce((acc: Record<string, Channel[]>, t) => { const p = t.parentChannelId; if (!p) return acc; (acc[p] ||= []).push(t); return acc; }, {});
	$: allVoiceChannelsAll = $channels.filter(ch => ch.type === 'voice').filter(ch => !shouldHideChannelFromList(ch));
	$: voiceCategoryMap = groupByCategory(allVoiceChannelsAll, $channels);
	$: breakoutChannelsByParent = allVoiceChannelsAll.filter(ch => ch.isBreakout && ch.parentChannelId).reduce((acc: Record<string, Channel[]>, ch) => { const p = ch.parentChannelId!; (acc[p] ||= []).push(ch); return acc; }, {});
	$: Object.values(breakoutChannelsByParent).forEach(r => r.sort((a, b) => (a.breakoutIndex || 0) - (b.breakoutIndex || 0)));
	$: voiceChannels = allVoiceChannelsAll.filter(ch => !ch.isBreakout);
	$: galleryChannelsAll = $channels.filter(ch => ch.type === 'gallery').filter(ch => !shouldHideChannelFromList(ch));
	$: galleryCategoryMap = groupByCategory(galleryChannelsAll, $channels);
	// C3: forum/wiki own sections — never mix into text list
	$: forumChannelsAll = $channels.filter(ch => ch.type === 'forum').filter(ch => !shouldHideChannelFromList(ch));
	$: forumCategoryMap = groupByCategory(forumChannelsAll, $channels);
	$: wikiChannelsAll = $channels.filter(ch => ch.type === 'wiki').filter(ch => !shouldHideChannelFromList(ch));
	$: wikiCategoryMap = groupByCategory(wikiChannelsAll, $channels);
	// L2: Asset Storage (lore) — never mix into text list
	$: loreChannelsAll = $channels.filter(ch => { const t = ch.type as string | undefined; return t === 'lore' || (ch as any).asset_storage === true; }).filter(ch => !shouldHideChannelFromList(ch));
	$: loreCategoryMap = groupByCategory(loreChannelsAll, $channels);
	// BZ3: Planning channels render the Planner workspace (center stage).
	$: planningChannelsAll = $channels.filter(ch => (ch.type as string | undefined) === 'planning').filter(ch => !shouldHideChannelFromList(ch));
	$: planningCategoryMap = groupByCategory(planningChannelsAll, $channels);
	// Unified sidebar: ONE pool of every sidebar channel (all types), grouped by
	// category folders that may hold ANY mix of types. Folders are first-class
	// category channels; a channel belongs to a folder when its parentId points at it.
	$: unifiedSidebarChannels = [
		...textChannelsAll,
		...groupChannels,
		...voiceChannels,
		...galleryChannelsAll,
		...forumChannelsAll,
		...wikiChannelsAll,
		...loreChannelsAll,
		...planningChannelsAll,
	].filter(ch => (ch.type as string | undefined) !== 'category');
	$: unifiedCategoryMap = groupByCategory(unifiedSidebarChannels, $channels);
	$: unifiedChannelCount = unifiedSidebarChannels.length;
	$: workspaceChannelCount = textChannelsAll.length + groupChannels.length + voiceChannels.length + galleryChannelsAll.length + forumChannelsAll.length + wikiChannelsAll.length + loreChannelsAll.length + planningChannelsAll.length;
	$: totalUnreadNotifications = Object.values($channelUnreadCounts).reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
	/** Unread across DM + group DM channels only — badge for Messages hub. */
	$: dmUnreadCount = $channels
		.filter((ch) => ch.type === 'dm' || ch.type === 'group')
		.reduce((sum, ch) => sum + (Number($channelUnreadCounts[ch.id]) || 0), 0);
	$: canTogglePersistMessages = $currentUser?.highestRole === 'owner';
	$: canManageWatchQueue = $currentUser?.highestRole === 'owner' || $currentUser?.highestRole === 'admin';
	$: canManageVoiceSettings = $currentUser?.highestRole === 'owner' || $currentUser?.highestRole === 'admin';
	$: canModerateVoiceMembers = ['owner', 'admin', 'mod'].includes($currentUser?.highestRole || '');
	// Mirrors the backend `is_admin` gate in core/crates/wabi-server/src/api/channels.rs
	// (owner OR configured admin_user_ids OR Admin role). Moderators do NOT pass,
	// so the new-channel affordance must not render for them.
	$: canCreateChannel = $currentUser?.highestRole === 'owner' || $currentUser?.highestRole === 'admin';
	$: {
		const prev = voicePresenceSince; const next = new Map<string, number>(); const at = Date.now();
		const selfId = $currentUser?.dbUserId ? `user-${$currentUser.dbUserId}` : $currentUser?.id || null;
		for (const ch of allVoiceChannelsAll) { for (const m of getVoiceMembers(ch.id)) next.set(`${ch.id}::${m.userId}`, prev.get(`${ch.id}::${m.userId}`) ?? at); if (selfId && isConnectedToVoice(ch.id)) next.set(`${ch.id}::${selfId}`, prev.get(`${ch.id}::${selfId}`) ?? at); }
		voicePresenceSince = next;
	}

	onMount(() => {
		try { localStorage.setItem('wabi-voice-duration-mode', 'off'); } catch {}
		voiceDurationMode = 'off';
		voiceDurationTicker = setInterval(() => { nowMs = Date.now(); }, 1000);
		const onPtr = (e: PointerEvent) => { if (!glimpseChannelId) return; const t = e.target as HTMLElement | null; if (!t || glimpsePopover?.contains(t) || t.closest('.channel-btn')) return; glimpseChannelId = null; };
		const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && glimpseChannelId) glimpseChannelId = null; };
		document.addEventListener('pointerdown', onPtr); document.addEventListener('keydown', onKey);
		// A6: gate Asset Storage create option on server lore capability
		void hasAddonCapability('lore').then((ok) => {
	loreAvailable = ok;
	if (!ok && newChannelType === 'lore') newChannelType = 'text';
		});
		return () => { document.removeEventListener('pointerdown', onPtr); document.removeEventListener('keydown', onKey); };
	});
	onDestroy(() => { if (voiceDurationTicker) { clearInterval(voiceDurationTicker); voiceDurationTicker = null; } });

	$: if (activeView === 'chat') markMessagesAsRead();

	function handleChannelClick(id: string) { activeView = 'chat'; glimpseChannelId = null; switchChannel(id); if ($callMode === 'channel') channelCallPanelOpen.set(false); dispatch('close'); if ($selectedDmChannelId) layoutStore.closeDM(); }
	function clearAllUnreadNotifications() { for (const id of Object.keys($channelUnreadCounts)) markChannelAsRead(id); markMessagesAsRead(); }
	function openFollowingView() { activeView = 'following'; glimpseChannelId = null; dispatch('close'); }
	function openDmHub() { activeView = 'dm'; glimpseChannelId = null; dispatch('close'); }
	function openVoiceChannelWhiteboard(id: string, e?: Event) { e?.stopPropagation(); activeView = 'chat'; currentChannel.set(id); setWhiteboardSurface(id, 'whiteboard'); dispatch('close'); }
	function toggleChannelFollowState(id: string, e?: Event) { e?.stopPropagation(); const f = toggleChannelFollow(id); if (!f && glimpseChannelId === id) glimpseChannelId = null; }
	function cycleFollowAlert(id: string, e?: Event) { e?.stopPropagation(); if (!followedChannelIds.has(id)) toggleChannelFollow(id); cycleChannelFollowAlertLevel(id); }
	function toggleChannelGlimpse(id: string) { glimpseChannelId = glimpseChannelId === id ? null : id; }
	function handleChannelButtonClick(id: string, e: MouseEvent) { if (e.altKey) { e.preventDefault(); e.stopPropagation(); toggleChannelGlimpse(id); return; } (e.currentTarget as HTMLElement | null)?.blur?.(); handleChannelClick(id); }
	function handleCreateThread(ch: Channel) { const n = window.prompt(`Create a thread in #${ch.name}`, `${ch.name} thread`)?.trim(); if (n) createThread(ch.id, n); }
	function getVoiceMembers(id: string) { return $voiceChannelMembers[id] || []; }
	function isConnectedToVoice(id: string) { return connectedVoiceChannelIds.has(id); }
	function isPrimaryVoiceChannel(id: string) { return primaryVoiceChannelId === id; }
	async function handleVoiceChannelClick(id: string, e?: MouseEvent) { (e?.currentTarget as HTMLElement | null)?.blur?.(); if (isConnectedToVoice(id)) { openChannelCallPanel(); dispatch('close'); return; } if (runtimeActiveVoiceChannelId) { subscribeVoiceChannel(id); return; } try { await joinVoiceChannel(id); dispatch('close'); } catch (e) { console.error('Failed to join voice channel:', e); } }
	function handleToggleListenChannel(id: string) { if (isPrimaryVoiceChannel(id)) return; isConnectedToVoice(id) ? unsubscribeVoiceChannel(id) : subscribeVoiceChannel(id); }
	function handleTransmitModeChange(e: Event) {
		const mode = (e.currentTarget as HTMLSelectElement).value as 'primary' | 'all-listening';
		setVoiceTransmitRoutingMode(mode);
		setVoiceTransmitMode(mode);
	}
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
	function toggleSection(s: 'text' | 'voice' | 'gallery' | 'forum' | 'wiki' | 'lore' | 'planning') {
		if (s === 'text') isTextSectionExpanded = !isTextSectionExpanded;
		else if (s === 'gallery') isGallerySectionExpanded = !isGallerySectionExpanded;
		else if (s === 'forum') isForumSectionExpanded = !isForumSectionExpanded;
		else if (s === 'wiki') isWikiSectionExpanded = !isWikiSectionExpanded;
		else if (s === 'lore') isLoreSectionExpanded = !isLoreSectionExpanded;
		else if (s === 'planning') isPlanningSectionExpanded = !isPlanningSectionExpanded;
		else isVoiceSectionExpanded = !isVoiceSectionExpanded;
	}

	let draggedChannelId: string | null = null;
	let dropTargetChannelId: string | null = null;
	let dropPosition: 'before' | 'after' | null = null;
	let dropTargetCategoryId: string | null = null;
	/** When dragging a category folder itself (reorder folders, not nest channels). */
	let draggedCategoryId: string | null = null;
	let dropCategoryPosition: 'before' | 'after' | null = null;

	function sameChannelFamily(a: { type?: string | null }, b: { type?: string | null }): boolean {
		// Unified sidebar: folders may hold ANY mix of channel types (text, voice,
		// gallery, forum, wiki, lore, planning). Backend persists parentId+position
		// for every channel type, so cross-type drops are allowed.
		void a; void b;
		return true;
	}

	function handleChannelDragStart(e: DragEvent, channelId: string) {
		// Don't steal category-folder drags
		const ch = $channels.find((c) => c.id === channelId);
		if ((ch?.type as string | undefined) === 'category') return;
		draggedCategoryId = null;
		draggedChannelId = channelId;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', channelId);
			e.dataTransfer.setData('application/x-wabi-channel', channelId);
			// Ghost stays readable; row itself dims via is-dragging.
			try {
				const row = e.currentTarget as HTMLElement | null;
				if (row) e.dataTransfer.setDragImage(row, 16, 16);
			} catch {
				/* setDragImage optional */
			}
		}
	}

	function handleCategoryFolderDragStart(e: DragEvent, catId: string) {
		draggedChannelId = null;
		draggedCategoryId = catId;
		dropTargetChannelId = null;
		dropPosition = null;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', catId);
			e.dataTransfer.setData('application/x-wabi-category', catId);
			try {
				const row = e.currentTarget as HTMLElement | null;
				if (row) e.dataTransfer.setDragImage(row, 12, 12);
			} catch {
				/* optional */
			}
		}
	}

	function handleChannelDragOver(e: DragEvent, channelId: string) {
		// Category folder reorder uses its own handlers
		if (draggedCategoryId) return;
		if (!draggedChannelId || draggedChannelId === channelId) return;
		dropTargetCategoryId = null;
		const allCh = $channels;
		const dragged = allCh.find((c) => c.id === draggedChannelId);
		const target = allCh.find((c) => c.id === channelId);
		if (!dragged || !target || !sameChannelFamily(dragged, target)) {
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
			return;
		}
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const mid = rect.top + rect.height / 2;
		dropTargetChannelId = channelId;
		dropPosition = e.clientY < mid ? 'before' : 'after';
	}

	function handleChannelDragLeave(channelId: string) {
		if (dropTargetChannelId === channelId) {
			dropTargetChannelId = null;
			dropPosition = null;
		}
	}

	function handleChannelDrop(e: DragEvent, targetChannelId: string) {
		e.preventDefault();
		e.stopPropagation();
		const clearDrag = () => {
			draggedChannelId = null;
			dropTargetChannelId = null;
			dropPosition = null;
			dropTargetCategoryId = null;
			draggedCategoryId = null;
			dropCategoryPosition = null;
		};
		if (draggedCategoryId) {
			// Dropping a folder onto a channel: treat as "before/after that channel's parent section" — ignore for now
			clearDrag();
			return;
		}
		if (!draggedChannelId || draggedChannelId === targetChannelId) {
			clearDrag();
			return;
		}
		const allCh = $channels;
		const draggedIdx = allCh.findIndex((c) => c.id === draggedChannelId);
		const targetIdx = allCh.findIndex((c) => c.id === targetChannelId);
		if (draggedIdx === -1 || targetIdx === -1) {
			clearDrag();
			return;
		}

		const dragged = allCh[draggedIdx];
		const target = allCh[targetIdx];
		if (!sameChannelFamily(dragged, target)) {
			clearDrag();
			return;
		}

		const targetParentId = target.parentId ?? null;
		const sourceParentId = dragged.parentId ?? null;
		const pos = dropPosition ?? 'before';
		const orders: { id: string; position: number; parentId: string | null }[] = [];

		// Section = same parent folder only (any type). Exclude category channels.
		const sectionOf = (parentId: string | null) =>
			allCh
				.filter(
					(c) =>
						(c.parentId ?? null) === parentId &&
						(c.type as string | undefined) !== 'category' &&
						(c.type as string | undefined) !== 'thread_public' &&
						(c.type as string | undefined) !== 'thread_private'
				)
				.sort((a, b) => (a.position ?? 999) - (b.position ?? 999));

		if (sourceParentId === targetParentId) {
			const sectionChs = sectionOf(targetParentId);
			const fromIdx = sectionChs.findIndex((c) => c.id === dragged.id);
			const toIdx = sectionChs.findIndex((c) => c.id === target.id);
			if (fromIdx === -1 || toIdx === -1) {
				clearDrag();
				return;
			}
			const [moved] = sectionChs.splice(fromIdx, 1);
			let insertAt = toIdx;
			if (fromIdx < toIdx) {
				insertAt = pos === 'after' ? toIdx : toIdx - 1;
			} else {
				insertAt = pos === 'after' ? toIdx + 1 : toIdx;
			}
			insertAt = Math.max(0, Math.min(sectionChs.length, insertAt));
			sectionChs.splice(insertAt, 0, moved);
			sectionChs.forEach((ch, i) => {
				orders.push({ id: ch.id, position: i, parentId: targetParentId });
			});
		} else {
			const targetSection = sectionOf(targetParentId).filter((c) => c.id !== dragged.id);
			const toIdx = targetSection.findIndex((c) => c.id === target.id);
			const insertAt =
				toIdx === -1 ? targetSection.length : pos === 'after' ? toIdx + 1 : toIdx;
			targetSection.splice(Math.max(0, insertAt), 0, dragged);
			targetSection.forEach((ch, i) => {
				orders.push({ id: ch.id, position: i, parentId: targetParentId });
			});

			const fromSection = sectionOf(sourceParentId).filter((c) => c.id !== dragged.id);
			fromSection.forEach((ch, i) => {
				if (!orders.some((o) => o.id === ch.id)) {
					orders.push({ id: ch.id, position: i, parentId: sourceParentId });
				}
			});
		}

		if (orders.length > 0) reorderChannels(orders);
		clearDrag();
	}

	function handleChannelDragEnd() {
		draggedChannelId = null;
		dropTargetChannelId = null;
		dropPosition = null;
		dropTargetCategoryId = null;
		draggedCategoryId = null;
		dropCategoryPosition = null;
	}

	/** Move a (non-category) channel so it becomes a child of the given category. */
	function moveChannelToCategory(channelId: string, catId: string) {
		const allCh = $channels;
		const dragged = allCh.find((c) => c.id === channelId);
		if (!dragged || (dragged.type as string | undefined) === 'category' || dragged.id === catId) return;
		const sourceParentId = dragged.parentId ?? null;
		const orders: { id: string; position: number; parentId: string | null }[] = [];

		const targetList = allCh
			.filter(
				(c) =>
					(c.parentId ?? null) === catId &&
					c.id !== dragged.id &&
					(c.type as string | undefined) !== 'category'
			)
			.sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
		targetList.forEach((ch, i) => orders.push({ id: ch.id, position: i, parentId: catId }));
		orders.push({ id: dragged.id, position: targetList.length, parentId: catId });

		if (sourceParentId !== catId) {
			const sourceList = allCh
				.filter(
					(c) =>
						(c.parentId ?? null) === sourceParentId &&
						c.id !== dragged.id &&
						(c.type as string | undefined) !== 'category'
				)
				.sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
			sourceList.forEach((ch, i) => orders.push({ id: ch.id, position: i, parentId: sourceParentId }));
		}
		if (orders.length > 0) reorderChannels(orders);
	}

	/** Reorder category folders among themselves (global category position). */
	function reorderCategoryFolders(fromId: string, toId: string, pos: 'before' | 'after') {
		const cats = $channels
			.filter((c) => (c.type as string | undefined) === 'category')
			.sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
		const fromIdx = cats.findIndex((c) => c.id === fromId);
		const toIdx = cats.findIndex((c) => c.id === toId);
		if (fromIdx === -1 || toIdx === -1 || fromId === toId) return;
		const next = [...cats];
		const [moved] = next.splice(fromIdx, 1);
		let insertAt = toIdx;
		if (fromIdx < toIdx) {
			insertAt = pos === 'after' ? toIdx : toIdx - 1;
		} else {
			insertAt = pos === 'after' ? toIdx + 1 : toIdx;
		}
		insertAt = Math.max(0, Math.min(next.length, insertAt));
		next.splice(insertAt, 0, moved);
		// Categories are top-level — parentId stays null
		const orders = next.map((ch, i) => ({ id: ch.id, position: i, parentId: null as string | null }));
		reorderChannels(orders);
	}

	function handleCategoryDragOver(e: DragEvent, catId: string) {
		// Reordering folders
		if (draggedCategoryId) {
			if (draggedCategoryId === catId) {
				if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
				return;
			}
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			const mid = rect.top + rect.height / 2;
			dropTargetCategoryId = catId;
			dropCategoryPosition = e.clientY < mid ? 'before' : 'after';
			dropTargetChannelId = null;
			dropPosition = null;
			return;
		}

		const dragged = draggedChannelId ? $channels.find((c) => c.id === draggedChannelId) : null;
		if (!dragged || (dragged.type as string | undefined) === 'category' || dragged.id === catId) {
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
			return;
		}
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dropTargetChannelId = null;
		dropPosition = null;
		dropTargetCategoryId = catId;
		dropCategoryPosition = null;
	}

	function handleCategoryDragLeave(catId: string) {
		if (dropTargetCategoryId === catId) {
			dropTargetCategoryId = null;
			dropCategoryPosition = null;
		}
	}

	function handleCategoryDrop(e: DragEvent, catId: string) {
		e.preventDefault();
		e.stopPropagation();
		if (draggedCategoryId) {
			const pos = dropCategoryPosition ?? 'before';
			reorderCategoryFolders(draggedCategoryId, catId, pos);
		} else {
			const dragged = draggedChannelId ? $channels.find((c) => c.id === draggedChannelId) : null;
			if (dragged) moveChannelToCategory(dragged.id, catId);
		}
		draggedChannelId = null;
		dropTargetChannelId = null;
		dropPosition = null;
		dropTargetCategoryId = null;
		draggedCategoryId = null;
		dropCategoryPosition = null;
	}

	function categoryDropTargetClass(catId: string): string {
		if (dropTargetCategoryId !== catId) return '';
		if (draggedCategoryId) {
			return dropCategoryPosition === 'before' ? 'drop-before' : 'drop-after';
		}
		return 'drop-target';
	}

	function dropTargetClass(channelId: string): string {
		if (dropTargetChannelId !== channelId) return '';
		return dropPosition === 'before' ? 'drop-before' : 'drop-after';
	}

	/** R5: lists bind is-dragging on the row being dragged */
	function isChannelDragging(channelId: string): boolean {
		return draggedChannelId === channelId || draggedCategoryId === channelId;
	}
	async function handleCreateChannel() {
		const channelName = newChannelName.trim();
		if (!channelName || creatingChannel) return;
		createChannelError = '';
		creatingChannel = true;
		try {
			let parentId: string | null = null;
			const placingInFolder = newChannelType !== 'category';

			if (placingInFolder && createFolderChoice === '__new__') {
				const folderName = createNewFolderName.trim();
				if (!folderName) {
					createChannelError = 'Enter a name for the new folder.';
					creatingChannel = false;
					return;
				}
				// Create folder first, then nest the channel under it.
				const folderId = await createChannel(folderName, undefined, 'category', false);
				parentId = folderId ?? null;
				if (!parentId) {
					console.warn('[sidebar] folder created but id not found; channel will be top-level');
				}
			} else if (placingInFolder && createFolderChoice !== 'none') {
				parentId = createFolderChoice;
			}

			await createChannel(
				channelName,
				newChannelDescription.trim(),
				newChannelType,
				newChannelForceSpoiler,
				undefined,
				parentId
			);
			newChannelName = '';
			newChannelDescription = '';
			newChannelType = 'text';
			newChannelForceSpoiler = false;
			createFolderChoice = 'none';
			createNewFolderName = '';
			showCreateInput = false;
		} catch (error) {
			createChannelError = error instanceof Error ? error.message : 'Failed to create channel.';
		} finally {
			creatingChannel = false;
		}
	}
	function closeCreateForm() {
		showCreateInput = false;
		createChannelError = '';
		createFolderChoice = 'none';
		createNewFolderName = '';
	}
	function toggleCreateInputForType(t: CreateableChannelType) {
		if (t === 'lore' && !loreAvailable) return;
		if (showCreateInput && newChannelType === t) {
			closeCreateForm();
			return;
		}
		newChannelType = t;
		createChannelError = '';
		showCreateInput = true;
		tick().then(() => (document.querySelector('.create-channel input') as HTMLInputElement | null)?.focus());
	}
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
		const isCategory = (ch.type as string | undefined) === 'category';
		const noun = ch.type === 'group' ? 'Group' : 'Channel';
		const followed = sup && followedChannelIds.has(ch.id);
		const items: ContextMenuItem[] = [
	{ id: 'open-floating-panel', label: 'Open floating panel', icon: 'message-circle', onSelect: () => openChannelFloatingPanel(ch) },
	{ id: 'open-os-window', label: 'Open OS window', icon: 'external-window', onSelect: () => openDetachedPanel({ kind: 'channel-chat', channelId: ch.id, channelName: ch.name }) },
	{ id: 'windowing-divider', type: 'separator' },
	{ id: 'pin-channel', label: isChannelBookmarked(ch) ? 'Remove Bookmark' : 'Bookmark Channel', icon: 'pin', onSelect: () => toggleChannelBookmark(ch) },
	{ id: 'pinned-messages', label: 'Pinned Messages', icon: 'pin', onSelect: () => handleShowPinnedMessages(ch.id) },
	{ id: 'toggle-mute-channel', label: isChannelLocallyMuted(ch.id) ? 'Unmute Channel' : 'Mute Channel', onSelect: () => toggleServerMutedChannelId(ch.id) },
	{ id: 'channel-settings', label: isCategory ? 'Category Settings' : 'Channel Settings', icon: 'settings', onSelect: () => handleOpenChannelSettings(ch) }
		];
		if (!isCategory && allCategories.length > 0) {
			items.push({ id: 'category-divider', type: 'separator' });
			items.push({ id: 'pick-category', label: 'Move to folder', leading: '▸', disabled: true });
			for (const cat of allCategories) {
				const active = ch.parentId === cat.id;
				items.push(
					{
						id: `move-to-${cat.id}`,
						label: cat.name,
						leading: active ? '●' : '◦',
						hint: active ? 'current' : undefined,
						onSelect: () => moveChannelToCategory(ch.id, cat.id)
					}
				);
			}
		}
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
		if (ch.id !== 'general' && ch.id !== 'voice' && !ch.isBreakout && canCreateChannel) items.push({ id: 'danger-divider', type: 'separator' }, { id: 'delete-channel', label: isCategory ? 'Delete Category' : 'Delete Channel', icon: 'trash-2', danger: true, onSelect: () => handleDeleteChannel(ch.id) });
		if (!isCategory && canCreateChannel) {
			items.push({ id: 'create-category-divider', type: 'separator' }, { id: 'create-category', label: 'Create Category', icon: 'archive', onSelect: openCreateFormForCategory });
		}
		return items;
	}

	function openCreateFormForCategory() {
		newChannelType = 'category';
		createChannelError = '';
		createFolderChoice = 'none';
		createNewFolderName = '';
		showCreateInput = true;
		void tick().then(() => (document.querySelector('.create-channel input') as HTMLInputElement | null)?.focus());
	}
</script>

<div class="channel-sidebar" class:compact={isCompactSidebar} class:nav-right={!$layoutStore.isMobile && $layoutStore.navDock === 'right'} style:width={$layoutStore.isMobile ? '100%' : `${$layoutStore.channelSidebarWidth}px`}>
	<div class="top-section" class:has-banner={Boolean(currentServerBannerUrl)} style:--sidebar-banner-image={currentServerBannerUrl ? `url('${currentServerBannerUrl}')` : 'none'}>
		<button class="mobile-close-btn" on:click={() => dispatch('close')}>&times;</button>
		<button type="button" class="server-identity" on:click={() => dispatch('openServerSwitcher')}>
	<div class="logo">
		{#if serverIdentityIconUrl && !serverIdentityImageFailed}
			<img src={serverIdentityIconUrl} alt={`${currentServerLabel} icon`} class="logo-img server-logo-img" on:error={() => (serverIdentityImageFailed = true)} />
		{:else}
			<img src="/wabi-logo-small.webp" alt={brandName} class="logo-img brand-logo-img" />
		{/if}
	</div>
	{#if !isCompactSidebar}
		<div class="server-copy"><strong class="server-name">{currentServerLabel}</strong>{#if currentServerTagline}<span class="server-tagline">{currentServerTagline}</span>{/if}</div>
	{/if}
		</button>
		{#if sidebarWidth < 170 && !isCompactSidebar}
	<div class="header-buttons">
		<button class="control-btn compact-settings-btn" on:click={() => dispatch('openSettings')} title="User Settings">
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path></svg>
		</button>
	</div>
		{/if}
	</div>

	<!-- Personal hub: sticky under server chrome, above server channel list -->
	<div class="personal-nav" class:compact={isCompactSidebar}>
		<button
			class="messages-hub-btn"
			type="button"
			class:active={activeView === 'dm'}
			on:click={openDmHub}
			title={isCompactSidebar ? (dmUnreadCount > 0 ? `Messages (${dmUnreadCount} unread)` : 'Messages') : 'Direct messages & notes'}
			aria-label={dmUnreadCount > 0 ? `Messages, ${dmUnreadCount} unread` : 'Messages'}
			aria-current={activeView === 'dm' ? 'page' : undefined}
		>
			<span class="messages-hub-icon" aria-hidden="true">
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
			</span>
			{#if !isCompactSidebar}
				<span class="messages-hub-label">Messages</span>
			{/if}
			{#if dmUnreadCount > 0}
				<span class="messages-hub-badge">{dmUnreadCount > 99 ? '99+' : dmUnreadCount}</span>
			{/if}
		</button>
	</div>

	<CreateChannelForm
		{showCreateInput}
		canCreate={canCreateChannel}
		newChannelName={newChannelName}
		newChannelDescription={newChannelDescription}
		{newChannelType}
		forceSpoiler={newChannelForceSpoiler}
		createError={createChannelError}
		{creatingChannel}
		{loreAvailable}
		categories={allCategories.map((c) => ({ id: c.id, name: c.name }))}
		folderChoice={createFolderChoice}
		newFolderName={createNewFolderName}
		onNameChange={(v) => {
			newChannelName = v;
			createChannelError = '';
		}}
		onDescriptionChange={(v) => (newChannelDescription = v)}
		onTypeChange={(v) => {
			newChannelType = v;
			createChannelError = '';
			if (v === 'category') {
				createFolderChoice = 'none';
				createNewFolderName = '';
			}
		}}
		onForceSpoilerChange={(v) => {
			newChannelForceSpoiler = v;
		}}
		onFolderChoiceChange={(v) => {
			createFolderChoice = v;
			if (v !== '__new__') createNewFolderName = '';
		}}
		onNewFolderNameChange={(v) => (createNewFolderName = v)}
		onSubmit={handleCreateChannel}
		onCancel={closeCreateForm}
	/>

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
		<span class="section-toggle-label">Channels</span><span class="section-count">{unifiedChannelCount}</span>
	</button>
	{#if canCreateChannel}<button class="section-add-btn" class:active={showCreateInput && newChannelType !== 'category'} on:click={() => toggleCreateInputForType('text')} title="Create channel" aria-label="Create channel"><span class="plus-glyph" aria-hidden="true">+</span></button>
		<button class="section-add-btn section-category-btn" class:active={showCreateInput && newChannelType === 'category'} on:click={openCreateFormForCategory} title="Create category" aria-label="Create category"><span class="plus-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><line x1="12" y1="10" x2="12" y2="16"></line><line x1="9" y1="13" x2="15" y2="13"></line></svg></span></button>{/if}
		</div>
		{#if isTextSectionExpanded}
	{#each unifiedCategoryMap.categories as cat (cat.id)}
		<div
			class="category-row"
			class:drop-target={categoryDropTargetClass(cat.id) === 'drop-target'}
			class:drop-before={categoryDropTargetClass(cat.id) === 'drop-before'}
			class:drop-after={categoryDropTargetClass(cat.id) === 'drop-after'}
			class:is-dragging={draggedCategoryId === cat.id}
			draggable="true"
			title="Drag to reorder folders · Drop channels here to nest"
			on:dragstart|stopPropagation={(e) => handleCategoryFolderDragStart(e, cat.id)}
			on:dragover|stopPropagation={(e) => handleCategoryDragOver(e, cat.id)}
			on:dragleave|stopPropagation={() => handleCategoryDragLeave(cat.id)}
			on:drop|stopPropagation={(e) => handleCategoryDrop(e, cat.id)}
			on:dragend={handleChannelDragEnd}
			on:contextmenu={(e) => handleChannelRightClick(e, cat.channel)}
			use:longpress={{ onLongPress: (e) => handleChannelLongPress(e, cat.channel) }}
		>
			<button class="category-toggle" type="button" aria-expanded={!collapsedCategories.has(cat.id)} on:click={() => toggleCategory(cat.id)}>
				<span class="category-drag-grip" aria-hidden="true" title="Drag to reorder">⋮⋮</span>
				<span class="category-chevron"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"></path></svg></span>
				<span class="category-folder-icon"><svg class="category-folder-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg></span>
				<span class="category-name">{cat.name}<span class="category-count">{cat.channels.length}</span></span>
			</button>
		</div>
		{#if !collapsedCategories.has(cat.id)}
			<div
				class="category-channels"
				data-category-id={cat.id}
				class:drop-target={dropTargetCategoryId === cat.id && !draggedCategoryId}
				on:dragover|stopPropagation={(e) => handleCategoryDragOver(e, cat.id)}
				on:dragleave|stopPropagation={() => handleCategoryDragLeave(cat.id)}
				on:drop|stopPropagation={(e) => handleCategoryDrop(e, cat.id)}
			>
				<UnifiedChannelList channels={cat.channels} {threadChannelsByParent} {followedChannelIds} {liveWhiteboardChannelIds} {breakoutChannelsByParent} {connectedVoiceChannelIds} {runtimeActiveVoiceChannelId} {voiceDropTargetChannelId} {voicePresenceSince} {voiceDurationMode} {nowMs} {dropTargetClass} {isChannelDragging} onChannelClick={handleChannelClick} onChannelButtonClick={handleChannelButtonClick} onVoiceChannelClick={handleVoiceChannelClick} onChannelRightClick={handleChannelRightClick} onChannelLongPress={handleChannelLongPress} onToggleChannelFollow={toggleChannelFollowState} onOpenChannelSettings={handleOpenChannelSettings} onShowPinnedMessages={handleShowPinnedMessages} onToggleListenChannel={handleToggleListenChannel} onOpenVoiceChannelWhiteboard={openVoiceChannelWhiteboard} {canDragVoiceMember} onVoiceMemberDragStart={handleVoiceMemberDragStart} onVoiceMemberDragEnd={handleVoiceMemberDragEnd} onVoiceChannelDragOver={handleVoiceChannelDragOver} onVoiceChannelDragLeave={handleVoiceChannelDragLeave} onVoiceChannelDrop={handleVoiceChannelDrop} onChannelDragStart={handleChannelDragStart} onChannelDragOver={handleChannelDragOver} onChannelDragLeave={handleChannelDragLeave} onChannelDrop={handleChannelDrop} onChannelDragEnd={handleChannelDragEnd} />
			</div>
		{/if}
	{/each}
	<UnifiedChannelList channels={unifiedCategoryMap.uncategorized} {threadChannelsByParent} {followedChannelIds} {liveWhiteboardChannelIds} {breakoutChannelsByParent} {connectedVoiceChannelIds} {runtimeActiveVoiceChannelId} {voiceDropTargetChannelId} {voicePresenceSince} {voiceDurationMode} {nowMs} {dropTargetClass} {isChannelDragging} onChannelClick={handleChannelClick} onChannelButtonClick={handleChannelButtonClick} onVoiceChannelClick={handleVoiceChannelClick} onChannelRightClick={handleChannelRightClick} onChannelLongPress={handleChannelLongPress} onToggleChannelFollow={toggleChannelFollowState} onOpenChannelSettings={handleOpenChannelSettings} onShowPinnedMessages={handleShowPinnedMessages} onToggleListenChannel={handleToggleListenChannel} onOpenVoiceChannelWhiteboard={openVoiceChannelWhiteboard} {canDragVoiceMember} onVoiceMemberDragStart={handleVoiceMemberDragStart} onVoiceMemberDragEnd={handleVoiceMemberDragEnd} onVoiceChannelDragOver={handleVoiceChannelDragOver} onVoiceChannelDragLeave={handleVoiceChannelDragLeave} onVoiceChannelDrop={handleVoiceChannelDrop} onChannelDragStart={handleChannelDragStart} onChannelDragOver={handleChannelDragOver} onChannelDragLeave={handleChannelDragLeave} onChannelDrop={handleChannelDrop} onChannelDragEnd={handleChannelDragEnd} />
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