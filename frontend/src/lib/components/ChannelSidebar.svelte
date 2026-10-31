<script lang="ts">
	import { openGlance } from '$lib/glance';
	import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
	import { confirmLeaveWhileRecording } from '$lib/callRecording';
	import { fly, slide } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';
	import { get } from 'svelte/store';
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
		channelMessages,
		joinChannel,
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
		kickVoiceMember,
		pinChannel,
		unpinChannel,
		reorderChannels
	} from '$lib/socket';
	import { createChannel, deleteChannel as deleteChannelWithOptions } from '$lib/channelStore';
	import { showToast } from '$lib/toast';
	import { mobileTabQueue } from '$lib/mobileTabQueue';
	import {
		activeVoiceChannel as callActiveVoiceChannel,
		toggleChannelCallPanelFor,
		callMode,
		channelCallPanelOpen,
		listeningVoiceChannels,
		setVoiceTransmitRoutingMode
	} from '$lib/calling';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import BreakoutRoomsModal from './BreakoutRoomsModal.svelte';
	import { longpress } from '$lib/actions/longpress';
	import PinnedMessagesModal from './PinnedMessagesModal.svelte';
	import UserPopout from './UserPopout.svelte';
	import ChannelSettingsModal from './sidebar/ChannelSettingsModal.svelte';
	import UnifiedChannelList from './sidebar/UnifiedChannelList.svelte';
	import {
		buildMixedRoot,
		channelNoun,
		communityUnreadIds,
		deleteConfirmCopy,
		dmRowLabel,
		formatBadge,
		formatGlimpseTime,
		resolveDropGap,
		resolveSidebarPlace,
		sidebarWidthTier,
		splitRootSections,
		summarizeGlimpseMessage
	} from './sidebar/channelSidebarHelpers';
	import type { ChannelNoun } from './sidebar/channelSidebarHelpers';
	import type { DragAnchor, DropGap } from './sidebar/channelSidebarHelpers';
	import VoiceUserCard from './sidebar/VoiceUserCard.svelte';
	import ProfileCard from './sidebar/ProfileCard.svelte';
	import CreateChannelForm from './sidebar/CreateChannelForm.svelte';
	import ContextMenu, { type MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import { openPalette } from '$lib/jumpPalette';
	import { activeWorkspaceView } from '$lib/workspaceNavigationState';
	import { _ } from '$lib/i18n';
	import type { Channel } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import { compactShellTier, selectedDmChannelId } from '$lib/layoutStoreStates';
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
	import { activeServerSettings, toggleServerMutedChannelId } from '$lib/serverSettings';
	import { whiteboardPresence } from '$lib/presenceStore';
	import { hasAddonCapability } from '$lib/addonInventory';
	import type { CreateableChannelType } from '$lib/channelStore';

	const dispatch = createEventDispatcher();
	export let activeView: 'chat' | 'business' | 'screen' | 'following' | 'dm' | 'server' = 'chat';
	export let dmHubTab: 'messages' | 'friends' = 'messages';
	export let friendRequestCount = 0;

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
	let channelToDeleteName = '';
	let channelToDeleteNoun: ChannelNoun = 'channel';
	let channelToDeleteChildCount = 0;
	let deletingChannel = false;
	let deleteChannelError = '';
	let showPinnedModal = false;
	let selectedChannelForPinned = '';
	let showChannelSettingsModal = false;
	let selectedChannelForSettings: Channel | null = null;
	let glimpseChannelId: string | null = null;
	/** Fixed-position peek box coords (viewport space) — survives sidebar scroll. */
	let glimpsePosition = { x: 0, y: 0 };
	let glimpsePopover: HTMLElement | null = null;

	function openChannelGlimpse(channelId: string, anchorRect: DOMRect) {
		glimpseChannelId = channelId;
		const width = Math.min(320, Math.round(window.innerWidth * 0.56));
		const maxH = Math.min(420, Math.round(window.innerHeight * 0.6));
		// Dock-right sidebars must open leftward or the box goes off-window.
		const flipLeft = get(layoutStore).navDock === 'right';
		const x = flipLeft
			? Math.max(8, anchorRect.left - width - 12)
			: Math.min(anchorRect.right + 12, window.innerWidth - width - 12);
		const y = Math.max(8, Math.min(anchorRect.top - 6, window.innerHeight - maxH - 12));
		glimpsePosition = { x, y };
		// Always re-hydrate: joining the socket room makes the server push a
		// fresh message window into channelMessages (presence.rs
		// on_join_channel), wiping ghosts of messages deleted while we were
		// disconnected — the norm on ephemeral/low-message servers. Cheap,
		// idempotent emit.
		joinChannel(channelId);
	}
	function closeChannelGlimpse() { glimpseChannelId = null; }
	let isTextSectionExpanded = true;
	let isVoiceSectionExpanded = true;
	let collapsedCategories = new Set<string>();
	// Folder collapse state persists per-server across reloads and surface
	// switches. Keyed by server URL under one localStorage entry.
	const FOLDER_COLLAPSE_KEY = 'wabi-sidebar-folders';
	try {
		const rawState = localStorage.getItem(FOLDER_COLLAPSE_KEY);
		if (rawState) {
			const parsed = JSON.parse(rawState) as Record<string, unknown>;
			const ids = parsed[resolveServerUrl().url];
			if (Array.isArray(ids)) {
				collapsedCategories = new Set(ids.filter((id): id is string => typeof id === 'string'));
			}
		}
	} catch {}
	function persistCollapsedCategories() {
		try {
			let all: Record<string, unknown> = {};
			try { all = JSON.parse(localStorage.getItem(FOLDER_COLLAPSE_KEY) || '{}') as Record<string, unknown>; } catch {}
			all[resolveServerUrl().url] = [...collapsedCategories];
			localStorage.setItem(FOLDER_COLLAPSE_KEY, JSON.stringify(all));
		} catch {}
	}
	function toggleCategory(id: string) {
		if (collapsedCategories.has(id)) collapsedCategories.delete(id);
		else collapsedCategories.add(id);
		collapsedCategories = collapsedCategories;
		persistCollapsedCategories();
	}
	let voiceDurationMode: 'off' | 'others' | 'all' = 'off';
	let nowMs = Date.now();
	let voiceDurationTicker: ReturnType<typeof setInterval> | null = null;
	let voicePresenceSince = new Map<string, number>();
	let draggedVoiceMember: { userId: string; channelId: string } | null = null;
	let voiceDropTargetChannelId: string | null = null;

	$: sidebarWidth = $layoutStore.channelSidebarWidth;
	// A real compact rail (spec §8.1): any narrow desktop column renders 40px glyph tiles; a
	// narrow (but not compact) column drops the search keycap. The phone drawer is always full.
	// In the 769–1023px band (§8.13) the shell decides: the 60px rail at rest, the full column
	// while it is open over the stage; the stored width stays the desktop preference.
	$: widthTier = (!$layoutStore.isMobile && $compactShellTier) || sidebarWidthTier(sidebarWidth, $layoutStore.isMobile);
	$: isCompactSidebar = widthTier === 'compact';
	// Exactly one "you are here" entry: Server home, DMs, or the channel (page or context).
	$: sidebarPlace = resolveSidebarPlace(activeView, $activeWorkspaceView);
	$: runtimeActiveVoiceChannelId = $callActiveVoiceChannel?.id || $socketActiveVoiceChannel || null;
	$: connectedVoiceChannelIds = (() => {
		const ids = new Set<string>();
		for (const id of $listeningVoiceChannels) ids.add(id);
		if (runtimeActiveVoiceChannelId) ids.add(runtimeActiveVoiceChannelId);
		return ids;
	})();
	$: primaryVoiceChannelId = runtimeActiveVoiceChannelId || $listeningVoiceChannels[0] || null;
	$: currentServerLabel = $currentSavedServer?.effectiveName || (() => { try { return new URL(resolveServerUrl().url).hostname; } catch { return brandName; } })();
	$: serverIdentityIconUrl = $currentSavedServer?.effectiveIconUrl || null;
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

	function openOwnProfilePopout(event: CustomEvent<{ anchor: HTMLElement | null }>) { if (!$currentUser) return; ownProfilePopoutAnchor = event.detail?.anchor ?? null; showOwnProfilePopout = true; }
	// Read the per-server mute list from the store value (isServerChannelMuted() indexes the
	// store object itself, so it never sees a mute).
	$: mutedChannelIds = new Set<string>($activeServerSettings.mutedChannelIds ?? []);
	function isChannelLocallyMuted(id: string) { return mutedChannelIds.has(id); }
	/** Muted channels hidden by the "hide muted" setting; the open channel always stays listed. */
	$: hiddenMutedIds = $displayEnhancementSettingsStore.hideMutedCategoriesEnabled
		? new Set([...mutedChannelIds].filter((id) => id !== $currentChannel))
		: new Set<string>();
	function shouldHideChannelFromList(ch: Channel, hidden: Set<string>) { return hidden.has(ch.id); }

	/**
	 * Categories are first-class channels (type === 'category'). The unified
	 * mixed-root list (buildMixedRoot in channelSidebarHelpers) handles all
	 * folder grouping; nothing here needs the old per-type category maps.
	 */

	$: textChannelsAll = $channels.filter(ch => { const t = ch.type as string | undefined; return (!t || t === 'public' || t === 'text' || t === 'live') && t !== 'lore'; }).filter(ch => !shouldHideChannelFromList(ch, hiddenMutedIds));
	$: groupChannels = $channels.filter(ch => ch.type === 'group').filter(ch => !shouldHideChannelFromList(ch, hiddenMutedIds));
	$: allCategories = $channels.filter(ch => (ch.type as string | undefined) === 'category').sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
	$: threadChannels = $channels.filter(ch => ch.type === 'thread_public' || ch.type === 'thread_private').sort((a, b) => (b.threadLastActivityAt || b.createdAt || 0) - (a.threadLastActivityAt || a.createdAt || 0));
	$: threadChannelsByParent = threadChannels.reduce((acc: Record<string, Channel[]>, t) => { const p = t.parentChannelId; if (!p) return acc; (acc[p] ||= []).push(t); return acc; }, {});
	$: allVoiceChannelsAll = $channels.filter(ch => ch.type === 'voice').filter(ch => !shouldHideChannelFromList(ch, hiddenMutedIds));
	$: breakoutChannelsByParent = allVoiceChannelsAll.filter(ch => ch.isBreakout && ch.parentChannelId).reduce((acc: Record<string, Channel[]>, ch) => { const p = ch.parentChannelId!; (acc[p] ||= []).push(ch); return acc; }, {});
	$: Object.values(breakoutChannelsByParent).forEach(r => r.sort((a, b) => (a.breakoutIndex || 0) - (b.breakoutIndex || 0)));
	$: voiceChannels = allVoiceChannelsAll.filter(ch => !ch.isBreakout);
	$: galleryChannelsAll = $channels.filter(ch => ch.type === 'gallery').filter(ch => !shouldHideChannelFromList(ch, hiddenMutedIds));
	// C3: forum/wiki own sections — never mix into text list
	$: forumChannelsAll = $channels.filter(ch => ch.type === 'forum').filter(ch => !shouldHideChannelFromList(ch, hiddenMutedIds));
	$: wikiChannelsAll = $channels.filter(ch => ch.type === 'wiki').filter(ch => !shouldHideChannelFromList(ch, hiddenMutedIds));
	// L2: Asset Storage (lore) — never mix into text list
	$: loreChannelsAll = $channels.filter(ch => { const t = ch.type as string | undefined; return t === 'lore' || (ch as any).asset_storage === true; }).filter(ch => !shouldHideChannelFromList(ch, hiddenMutedIds));
	// Planning channels open the shared Project workspace; personal Planner is separate.
	$: planningChannelsAll = $channels.filter(ch => (ch.type as string | undefined) === 'planning').filter(ch => !shouldHideChannelFromList(ch, hiddenMutedIds));
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
	$: mixedRootItems = buildMixedRoot($channels, unifiedSidebarChannels);
	$: rootSections = splitRootSections(mixedRootItems);
	/** Community channels with unread messages: what CHANNELS › Mark all read clears (never DMs). */
	$: communityUnread = communityUnreadIds($channelUnreadCounts, $channels);
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

	let reduceMotion = false;
	$: sectionSlideParams = reduceMotion ? { duration: 0 } : { duration: 180, easing: cubicOut };
	// Flip is the *settle* confirmation after a commit, collapsed to instant
	// under prefers-reduced-motion. (Filtering moved to the jump palette.)
	$: rootFlipParams = reduceMotion ? { duration: 0 } : { duration: 220, easing: cubicOut };

	onMount(() => {
		if (typeof window !== 'undefined' && window.matchMedia) {
			const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
			reduceMotion = mq.matches;
			const onMotionChange = (event: MediaQueryListEvent) => { reduceMotion = event.matches; };
			mq.addEventListener('change', onMotionChange);
		}
		try { localStorage.setItem('wabi-voice-duration-mode', 'off'); } catch {}
		voiceDurationMode = 'off';
		// Duration labels are off by default — do not start the 1s nowMs ticker
		// until the user enables a duration mode (see setVoiceDurationMode).
		// An unconditional interval re-invalidated the whole channel list every
		// second while nothing rendered the durations.
		const onPtr = (e: PointerEvent) => { if (!glimpseChannelId) return; const t = e.target as HTMLElement | null; if (!t || glimpsePopover?.contains(t) || t.closest('.channel-btn')) return; glimpseChannelId = null; };
		const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && glimpseChannelId) glimpseChannelId = null; };
		// Peek is position:fixed — scrolling anywhere outside detaches it from
		// its anchor row, so those scrolls close it. Scrolls originating inside
		// the popout (its own message list) are exempt so the history can be
		// browsed without dismissing the peek.
		const onScroll = (e: Event) => {
			if (!glimpseChannelId) return;
			const t = e.target as Node | null;
			if (t && glimpsePopover?.contains(t)) return;
			glimpseChannelId = null;
		};
		document.addEventListener('pointerdown', onPtr); document.addEventListener('keydown', onKey); document.addEventListener('scroll', onScroll, true);
		// A6: gate Asset Storage create option on server lore capability.
		// Negative results are NOT cached (see addonInventory) so a flaky
		// first probe re-runs; the create form renders the Project chip in a
		// disabled state instead of hiding it, and never force-resets a
		// selection.
		void hasAddonCapability('lore').then((ok) => {
	loreAvailable = ok;
		});
		// Allow the LoreWorkspace "New Project Channel" button to open this form
		// pre-selected for the lore type. Always open the form; the Project chip
		// renders only when the lore capability resolves true (and the type
		// falls back to text if lore turns out unavailable).
		const onCreateChannelRequest = (e: Event) => {
			const type = (e as CustomEvent).detail?.type as CreateableChannelType | undefined;
			if (!type || type === 'text' || type === 'category') return;
			newChannelType = type;
			createChannelError = '';
			createFolderChoice = 'none';
			createNewFolderName = '';
			showCreateInput = true;
			// Same re-probe as openCreateForm: a flaky mount-time capability probe
			// must not leave Project files disabled when the dialog is opened from
			// the LoreWorkspace "New Project Channel" button. The dialog focuses
			// its name field itself.
			void refreshLoreCapability();
		};
		window.addEventListener('wabi:create-channel', onCreateChannelRequest);
		return () => { document.removeEventListener('pointerdown', onPtr); document.removeEventListener('keydown', onKey); document.removeEventListener('scroll', onScroll, true); window.removeEventListener('wabi:create-channel', onCreateChannelRequest); };
	});
	onDestroy(() => {
		if (voiceDurationTicker) { clearInterval(voiceDurationTicker); voiceDurationTicker = null; }
		// A drag in flight during teardown must not leave its rAF loop running.
		clearChannelDragState();
	});

	$: if (activeView === 'chat') markMessagesAsRead();

	function handleChannelClick(id: string) {
		activeView = 'chat';
		glimpseChannelId = null;
		const channel = $channels.find((candidate) => candidate.id === id);
		if (!channel) return;
		mobileTabQueue.closeAllAddonTabs();
		switchChannel(id);
		if ($callMode === 'channel') channelCallPanelOpen.set(false);
		if ($selectedDmChannelId) layoutStore.closeDM();
		dispatch('close');
	}
	$: glimpseChannel = glimpseChannelId ? ($channels.find((c) => c.id === glimpseChannelId) || null) : null;
	// Store-reactive ($channelMessages auto-subscribes; an imperative get()
	// here would freeze the peek on its first evaluation). Chat order,
	// oldest→newest — the popout opens auto-scrolled to the bottom.
	$: glimpseChannelMessages = glimpseChannelId
		? ($channelMessages[glimpseChannelId] || [])
		: [];
	// Hydrated = server window landed (store key is a real array). Distinguishes
	// "never hydrated" from "genuinely empty" so quiet channels show an honest
	// empty state instead of an eternal spinner.
	$: glimpseHydrated = glimpseChannelId !== null && Array.isArray($channelMessages[glimpseChannelId]);
	let glimpseMessagesEl: HTMLElement | null = null;
	$: if (glimpseChannelId !== null && glimpseChannelMessages.length > 0) {
		void tick().then(() => { if (glimpseMessagesEl) glimpseMessagesEl.scrollTop = glimpseMessagesEl.scrollHeight; });
	}

	/** CHANNELS › Mark all read: the community's channels only; DMs and groups keep their own state. */
	function markCommunityRead() { for (const id of communityUnread) markChannelAsRead(id); }
	/** Unread entries a channel's menu "Mark as read" clears: the channel, or a folder's channels. */
	function unreadIdsFor(ch: Channel, counts: Record<string, number>): string[] {
		const ids = (ch.type as string | undefined) === 'category'
			? $channels.filter((item) => item.parentId === ch.id).map((item) => item.id)
			: [ch.id];
		return ids.filter((id) => Number(counts[id]) > 0);
	}
	function markEntriesRead(ids: string[]) { for (const id of ids) markChannelAsRead(id); }
	function openFollowingView() { activeView = 'following'; glimpseChannelId = null; dispatch('close'); }
	function openDmHub() { activeView = 'dm'; glimpseChannelId = null; dispatch('openMessages'); dispatch('close'); }
	function openFriendsHub() { activeView = 'dm'; glimpseChannelId = null; dispatch('openFriends'); dispatch('close'); }
	function openVoiceChannelWhiteboard(id: string, e?: Event) { e?.stopPropagation(); activeView = 'chat'; currentChannel.set(id); setWhiteboardSurface(id, 'whiteboard'); dispatch('close'); }
	function toggleChannelFollowState(id: string, e?: Event) { e?.stopPropagation(); const f = toggleChannelFollow(id); if (!f && glimpseChannelId === id) glimpseChannelId = null; }
	function cycleFollowAlert(id: string, e?: Event) { e?.stopPropagation(); if (!followedChannelIds.has(id)) toggleChannelFollow(id); cycleChannelFollowAlertLevel(id); }
	// Zen peek: Alt-click (incl. middle-click+Alt from the list) is the only
	// trigger — same channel toggles off, otherwise open anchored to the row.
	// Plain click navigates and kills the peek. No hover trigger by design.
	function handleChannelButtonClick(id: string, e: MouseEvent) {
		if (e.altKey) {
			e.preventDefault();
			e.stopPropagation();
			glimpseChannelId = null;
			openGlance({kind: 'channel', channelId: id});
			return;
		}
		glimpseChannelId = null;
		(e.currentTarget as HTMLElement | null)?.blur?.();
		handleChannelClick(id);
	}
	function handleCreateThread(ch: Channel) { const n = window.prompt(`Create a thread in #${ch.name}`, `${ch.name} thread`)?.trim(); if (n) createThread(ch.id, n); }
	function getVoiceMembers(id: string) { return $voiceChannelMembers[id] || []; }
	function isConnectedToVoice(id: string) { return connectedVoiceChannelIds.has(id); }
	function isPrimaryVoiceChannel(id: string) { return primaryVoiceChannelId === id; }
	// Discord model (2026-08-27 join, revised 2026-09-07 view contract):
	// 1st click JOINS and stays put (roster in the sidebar, Calls panel
	// peeks); 2nd click on a connected channel TOGGLES the embedded call
	// panel in place — feeds + controls without leaving the channel, and
	// without touching transmit focus. The full Voice dashboard stays
	// reachable via the workspace pill.
	async function handleVoiceChannelClick(id: string, e?: MouseEvent) {
		(e?.currentTarget as HTMLElement | null)?.blur?.();
		if (isConnectedToVoice(id)) { toggleChannelCallPanelFor(id); dispatch('close'); return; }
		try {
			if (runtimeActiveVoiceChannelId) await subscribeVoiceChannel(id);
			else await joinVoiceChannel(id);
		} catch (error) { showToast(error instanceof Error ? error.message : 'Could not join voice channel', 'error'); }
	}
	async function handleToggleListenChannel(id: string) {
		if (isPrimaryVoiceChannel(id)) return;
		try {
			if (isConnectedToVoice(id)) await unsubscribeVoiceChannel(id);
			else await subscribeVoiceChannel(id);
		} catch (error) { showToast(error instanceof Error ? error.message : 'Could not update voice subscription', 'error'); }
	}
	function handleTransmitModeChange(e: Event) {
		const mode = (e.currentTarget as HTMLSelectElement).value as 'primary' | 'all-listening';
		setVoiceTransmitRoutingMode(mode);
		setVoiceTransmitMode(mode);
	}
	async function handleLeaveVoice() {
		if (!confirmLeaveWhileRecording()) return;
		try {
			if (primaryVoiceChannelId) await leaveVoiceChannel(primaryVoiceChannelId);
			else for (const id of connectedVoiceChannelIds) await unsubscribeVoiceChannel(id);
		} catch (error) { showToast(error instanceof Error ? error.message : 'Could not leave voice channel', 'error'); }
	}
	function hasBreakoutRooms(id: string) { return (breakoutChannelsByParent[id] || []).length > 0; }
	let showBreakoutModal = false;
	let breakoutTargetChannel: Channel | null = null;
	function handleCreateBreakoutRooms(ch: Channel) { breakoutTargetChannel = ch; showBreakoutModal = true; }
	function confirmCreateBreakoutRooms(roomCount: number, autoAssign: boolean) {
		if (!breakoutTargetChannel) return;
		createBreakoutRooms(breakoutTargetChannel.id, Math.min(20, Math.max(2, Math.round(roomCount))), autoAssign);
		showBreakoutModal = false;
	}
	function handleCloseBreakoutRooms(ch: Channel) { closeBreakoutRooms(ch.id); }
	function canDragVoiceMember(uid: string) { return !!$currentUser && (uid === $currentUser.id || ($currentUser.dbUserId && uid === `user-${$currentUser.dbUserId}`) || canModerateVoiceMembers); }
	function canKickVoiceMember(uid: string) { return !!$currentUser && canModerateVoiceMembers && uid !== $currentUser.id && !($currentUser.dbUserId && uid === `user-${$currentUser.dbUserId}`); }
	function handleKickVoiceMember(chId: string, uid: string) { if (!canKickVoiceMember(uid)) return; kickVoiceMember(chId, uid); }
	function handleVoiceMemberDragStart(e: DragEvent, chId: string, uid: string) { if (!canDragVoiceMember(uid)) { e.preventDefault(); return; } draggedVoiceMember = { userId: uid, channelId: chId }; voiceDropTargetChannelId = null; if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', JSON.stringify(draggedVoiceMember)); } }
	function handleVoiceMemberDragEnd() { draggedVoiceMember = null; voiceDropTargetChannelId = null; }
	function handleVoiceChannelDragOver(e: DragEvent, chId: string) { if (!draggedVoiceMember || draggedVoiceMember.channelId === chId) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; voiceDropTargetChannelId = chId; }
	function handleVoiceChannelDragLeave(chId: string) { if (voiceDropTargetChannelId === chId) voiceDropTargetChannelId = null; }
	function handleVoiceChannelDrop(e: DragEvent, chId: string) { if (!draggedVoiceMember || draggedVoiceMember.channelId === chId) return; e.preventDefault(); e.stopPropagation(); moveUserToVoiceChannel(draggedVoiceMember.userId, chId); draggedVoiceMember = null; voiceDropTargetChannelId = null; }
	function setVoiceDurationMode(mode: 'off' | 'others' | 'all') {
		voiceDurationMode = mode;
		try { localStorage.setItem('wabi-voice-duration-mode', mode); } catch {}
		if (mode === 'off') {
			if (voiceDurationTicker) { clearInterval(voiceDurationTicker); voiceDurationTicker = null; }
		} else if (!voiceDurationTicker) {
			nowMs = Date.now();
			voiceDurationTicker = setInterval(() => { nowMs = Date.now(); }, 1000);
		}
	}

	// ========================================================================
	// DRAG & DROP — single-coordinator model
	// ------------------------------------------------------------------------
	// One dragover listener on .channel-list owns ALL channel/folder targeting.
	// Rows only declare anchors (data-drop-anchor) and report dragstart/end.
	// Benefits over per-row handlers:
	//   • dead zones (voice rosters, threads, padding) resolve to the nearest
	//     gap instead of keeping a stale target or swallowing the drop
	//   • folder interiors support positional inserts (not append-only)
	//   • the insertion line lives in one overlay element that never flickers
	//     across child-boundary dragleave events (Gecko fires these eagerly)
	// Pure geometry lives in resolveDropGap() (channelSidebarHelpers.ts).
	// ========================================================================
	let draggedChannelId: string | null = null;
	/** When dragging a category folder itself (reorder folders, not nest channels). */
	let draggedCategoryId: string | null = null;

	let channelListEl: HTMLElement | null = null;
	/** The CHANNELS and VOICE section bodies: top-level voice rooms render under VOICE. */
	let channelSectionEl: HTMLElement | null = null;
	let voiceSectionEl: HTMLElement | null = null;

	/** Current computed landing gap (drives both the line and the commit). */
	let activeGap: DropGap | null = null;
	/** Insertion-line position in scroll-content coordinates; null hides it. */
	let dropLine: { y: number; x: number } | null = null;
	const ROOT_LINE_X = 4;
	/** Folder children sit 12px in (sidebar.css .category-channels), so their line does too. */
	const FOLDER_LINE_X = 30;

	let dragFrameHandle: number | null = null;
	let lastPointer = { x: 0, y: 0 };

	/** Server enforces the same rule (Owner/Admin/Moderator) in channel_ops.rs. */
	$: canReorderChannels = ['owner', 'admin', 'mod'].includes($currentUser?.highestRole || '');

	// Discord-style: hovering a COLLAPSED folder mid-drag expands it after a
	// short dwell, so you can see inside and drop into it.
	const CATEGORY_AUTO_EXPAND_MS = 400;
	let autoExpandTimer: ReturnType<typeof setTimeout> | null = null;
	let autoExpandCategoryId: string | null = null;

	function clearAutoExpand() {
		if (autoExpandTimer) { clearTimeout(autoExpandTimer); autoExpandTimer = null; }
		autoExpandCategoryId = null;
	}

	function scheduleAutoExpand(catId: string) {
		if (autoExpandCategoryId === catId && autoExpandTimer) return;
		clearAutoExpand();
		if (!collapsedCategories.has(catId)) return;
		autoExpandCategoryId = catId;
		autoExpandTimer = setTimeout(() => {
			autoExpandTimer = null;
			autoExpandCategoryId = null;
			toggleCategory(catId);
		}, CATEGORY_AUTO_EXPAND_MS);
	}

	function isDraggingAnything(): boolean {
		return Boolean(draggedChannelId || draggedCategoryId);
	}

	function clearChannelDragState() {
		draggedChannelId = null;
		draggedCategoryId = null;
		activeGap = null;
		dropLine = null;
		lastPointer = { x: 0, y: 0 };
		stopDragFrame();
		clearAutoExpand();
	}

	function stopDragFrame() {
		if (dragFrameHandle !== null) {
			cancelAnimationFrame(dragFrameHandle);
			dragFrameHandle = null;
		}
	}

	/** True while the row being dragged is a voice room. */
	function isDraggingVoiceRoom(): boolean {
		if (!draggedChannelId) return false;
		return $channels.find((c) => c.id === draggedChannelId)?.type === 'voice';
	}

	/**
	 * Anchors the drag may land on, in document order. The line never lies about where the row
	 * will appear: a top-level voice room always renders under VOICE, so a voice room only
	 * targets folders and the VOICE rows, and every other row ignores the VOICE section.
	 */
	function collectAnchors(): DragAnchor[] {
		if (!channelListEl) return [];
		const nodes = channelListEl.querySelectorAll<HTMLElement>('[data-drop-anchor]');
		const anchors: DragAnchor[] = [];
		const voiceDrag = isDraggingVoiceRoom();
		for (const node of nodes) {
			const inVoiceSection = Boolean(voiceSectionEl?.contains(node));
			if (voiceDrag) {
				const looseRootRow = !inVoiceSection && node.dataset.dropAnchor === 'channel' && !node.dataset.parentFolder;
				if (looseRootRow) continue;
			} else if (inVoiceSection) {
				continue;
			}
			const rect = node.getBoundingClientRect();
			if (rect.height <= 0) continue;
			anchors.push({
				kind: (node.dataset.dropAnchor as 'folder' | 'channel') || 'channel',
				id: node.dataset.channelId || node.dataset.folderId || '',
				parentFolderId: node.dataset.parentFolder ? node.dataset.parentFolder : null,
				top: rect.top,
				bottom: rect.bottom
			});
		}
		return anchors;
	}

	function dragFrame() {
		dragFrameHandle = null;
		const listEl = channelListEl;
		if (!listEl || !isDraggingAnything()) return;

		// Edge auto-scroll so below-the-fold targets are reachable mid-drag
		// (native DnD blocks wheel scroll in Gecko/Blink).
		const containerRect = listEl.getBoundingClientRect();
		const EDGE = 36;
		const distanceUp = lastPointer.y - (containerRect.top + EDGE);
		const distanceDown = containerRect.bottom - EDGE - lastPointer.y;
		if (distanceUp < 0) listEl.scrollTop += Math.max(4, Math.min(18, -distanceUp / 3));
		else if (distanceDown < 0) listEl.scrollTop -= Math.max(4, Math.min(18, -distanceDown / 3));

		// The tail gap ("end of the list") sits under the section the row will render in.
		const voiceDrag = isDraggingVoiceRoom();
		const tailSection = voiceDrag ? voiceSectionEl : channelSectionEl;
		const tailY = tailSection ? Math.min(tailSection.getBoundingClientRect().bottom, containerRect.bottom) : containerRect.bottom;
		// A voice room dropped "before/after a folder" would land at the top level, which renders
		// under VOICE, so for a voice room a folder header only means "into this folder".
		const resolved = resolveDropGap(
			collectAnchors(),
			lastPointer.y,
			Boolean(draggedCategoryId),
			containerRect.top,
			listEl.scrollTop,
			tailY,
			voiceDrag
		);

		// Collapsed-folder dwell: hovering a collapsed folder's interior target
		// expands it after the dwell window so its children become droppable.
		if (resolved.gap?.scope === 'folder' && collapsedCategories.has(resolved.gap.categoryId)) {
			scheduleAutoExpand(resolved.gap.categoryId);
		} else {
			clearAutoExpand();
		}

		if (!resolved.gap || resolved.lineY === null) {
			activeGap = null;
			dropLine = null;
		} else {
			activeGap = resolved.gap;
			dropLine = { y: resolved.lineY, x: resolved.indented ? FOLDER_LINE_X : ROOT_LINE_X };
		}

		dragFrameHandle = requestAnimationFrame(dragFrame);
	}

	function handleListDragOver(event: DragEvent) {
		if (!canReorderChannels || !isDraggingAnything()) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		lastPointer = { x: event.clientX, y: event.clientY };
		if (dragFrameHandle === null) dragFrameHandle = requestAnimationFrame(dragFrame);
	}

	function handleListDragLeave(event: DragEvent) {
		// Only hide the line when the cursor truly left the scroll container
		// (child-to-child transitions bubble dragleave with an inside target).
		if (!channelListEl) return;
		const next = event.relatedTarget as Node | null;
		if (next && channelListEl.contains(next)) return;
		activeGap = null;
		dropLine = null;
	}

	function handleListDrop(event: DragEvent) {
		event.preventDefault();
		const gap = activeGap;
		if (gap) commitMoveToGap(gap);
		clearChannelDragState();
	}

	/**
	 * Translate a hover gap into persisted orders against the FULL model
	 * (never the search-filtered view). Reuses the existing order emitters so
	 * the optimistic store update + socket payload contract is unchanged.
	 */
	function commitMoveToGap(gap: DropGap) {
		const draggedId = draggedCategoryId || draggedChannelId;
		if (!draggedId) return;
		if (gap.scope === 'folder-header') {
			if (draggedCategoryId) reorderCategoryFolders(draggedCategoryId, gap.categoryId, gap.pos);
			else moveChannelAroundCategory(draggedId, gap.categoryId, gap.pos);
		} else if (gap.scope === 'root') {
			// Handles loose channels AND folders (folders carry their children).
			moveItemToRootGap(draggedId, gap.anchorId, gap.pos);
		} else if (gap.scope === 'folder' && draggedChannelId) {
			moveChannelIntoFolderGap(draggedId, gap.categoryId, gap.anchorId, gap.pos);
		}
	}

	/** Move any root item (loose channel OR folder) relative to another root item. */
	function moveItemToRootGap(itemId: string, anchorId: string | null, pos: 'before' | 'after') {
		const dragged = $channels.find((c) => c.id === itemId);
		if (!dragged || dragged.id === anchorId) return;
		const folderIds = new Set($channels.filter((c) => (c.type as string | undefined) === 'category').map((c) => c.id));
		const extra: { id: string; position: number; parentId: string | null }[] = [];
		// Reindex the source folder when the item leaves one.
		if (dragged.parentId && folderIds.has(dragged.parentId)) {
			sectionOf(dragged.parentId)
				.filter((c) => c.id !== itemId)
				.forEach((c, i) => extra.push({ id: c.id, position: i, parentId: dragged.parentId ?? null }));
		}
		const nextRoot = insertRelative(
			rootItems().filter((c) => c.id !== itemId),
			itemId,
			anchorId ?? '',
			pos,
			{ ...dragged, parentId: undefined }
		);
		emitRootOrders(nextRoot, extra);
	}

	/** Positional insert of a channel into a folder at the hovered gap. */
	function moveChannelIntoFolderGap(
		channelId: string,
		categoryId: string,
		anchorId: string | null,
		pos: 'before' | 'after'
	) {
		const allCh = $channels;
		const dragged = allCh.find((c) => c.id === channelId);
		if (!dragged || (dragged.type as string | undefined) === 'category') return;
		const sourceParentId = dragged.parentId ?? null;
		const orders: { id: string; position: number; parentId: string | null }[] = [];

		const destChildren = allCh
			.filter(
				(c) =>
					(c.parentId ?? null) === categoryId &&
					c.id !== channelId &&
					(c.type as string | undefined) !== 'category'
			)
			.sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
		let insertAt = destChildren.length;
		if (anchorId) {
			const anchorIdx = destChildren.findIndex((c) => c.id === anchorId);
			insertAt = anchorIdx === -1 ? destChildren.length : anchorIdx + (pos === 'after' ? 1 : 0);
		}
		destChildren.splice(insertAt, 0, { ...dragged, parentId: categoryId });
		destChildren.forEach((c, i) => orders.push({ id: c.id, position: i, parentId: categoryId }));

		if (sourceParentId !== categoryId) {
			allCh
				.filter(
					(c) =>
						(c.parentId ?? null) === sourceParentId &&
						c.id !== channelId &&
						(c.type as string | undefined) !== 'category'
				)
				.sort((a, b) => (a.position ?? 999) - (b.position ?? 999))
				.forEach((c, i) => orders.push({ id: c.id, position: i, parentId: sourceParentId }));
		}
		if (orders.length > 0) reorderChannels(orders);
	}

	function handleChannelDragStart(e: DragEvent, channelId: string) {
		if (!canReorderChannels) { e.preventDefault(); return; }
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
		if (!canReorderChannels) { e.preventDefault(); return; }
		draggedChannelId = null;
		draggedCategoryId = catId;
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

	function rootItems(): Channel[] {
		const folderIds = new Set(
			$channels.filter((c) => (c.type as string | undefined) === 'category').map((c) => c.id)
		);
		return $channels
			.filter((c) => {
				const type = c.type as string | undefined;
				if (type === 'thread_public' || type === 'thread_private') return false;
				if (type === 'category') return true;
				return !c.parentId || !folderIds.has(c.parentId);
			})
			.sort((a, b) => (a.position ?? 999) - (b.position ?? 999) || a.name.localeCompare(b.name));
	}

	function emitRootOrders(nextRoot: Channel[], extra: { id: string; position: number; parentId: string | null }[] = []) {
		const orders = nextRoot.map((channel, index) => ({
			id: channel.id,
			position: index,
			parentId: null
		}));
		for (const item of extra) {
			if (!orders.some((order) => order.id === item.id)) orders.push(item);
		}
		if (orders.length > 0) reorderChannels(orders);
	}

	function sectionOf(parentId: string | null) {
		return $channels
			.filter(
				(c) =>
					(c.parentId ?? null) === parentId &&
					(c.type as string | undefined) !== 'category' &&
					(c.type as string | undefined) !== 'thread_public' &&
					(c.type as string | undefined) !== 'thread_private'
			)
			.sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
	}

	function insertRelative(list: Channel[], fromId: string, toId: string, pos: 'before' | 'after', fallback?: Channel): Channel[] {
		const next = list.filter((channel) => channel.id !== fromId);
		const moved = list.find((channel) => channel.id === fromId) ?? fallback;
		const toIdx = next.findIndex((channel) => channel.id === toId);
		if (!moved) return next;
		if (toIdx === -1) {
			next.push(moved);
			return next;
		}
		next.splice(pos === 'after' ? toIdx + 1 : toIdx, 0, moved);
		return next;
	}

	function handleChannelDragEnd() {
		clearChannelDragState();
	}

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

	/** Move a channel out of any folder and into the top-level channel list. */
	function moveChannelToRoot(channelId: string, requestedIndex?: number) {
		const dragged = $channels.find((c) => c.id === channelId);
		if (!dragged || (dragged.type as string | undefined) === 'category') return;
		const extra: { id: string; position: number; parentId: string | null }[] = [];
		if (dragged.parentId) {
			sectionOf(dragged.parentId)
				.filter((channel) => channel.id !== dragged.id)
				.forEach((channel, index) => extra.push({ id: channel.id, position: index, parentId: dragged.parentId ?? null }));
		}
		const nextRoot = rootItems().filter((channel) => channel.id !== dragged.id);
		const insertAt = Math.max(0, Math.min(nextRoot.length, requestedIndex ?? nextRoot.length));
		nextRoot.splice(insertAt, 0, { ...dragged, parentId: undefined });
		emitRootOrders(nextRoot, extra);
	}

	/** Reorder a channel into the root sequence immediately before or after a folder. */
	function moveChannelAroundCategory(channelId: string, categoryId: string, position: 'before' | 'after') {
		const dragged = $channels.find((c) => c.id === channelId);
		if (!dragged || (dragged.type as string | undefined) === 'category') return;
		const extra: { id: string; position: number; parentId: string | null }[] = [];
		if (dragged.parentId) {
			sectionOf(dragged.parentId)
				.filter((channel) => channel.id !== dragged.id)
				.forEach((channel, index) => extra.push({ id: channel.id, position: index, parentId: dragged.parentId ?? null }));
		}
		const nextRoot = insertRelative(
			rootItems().map((channel) => (channel.id === dragged.id ? { ...channel, parentId: undefined } : channel)),
			dragged.id,
			categoryId,
			position,
			{ ...dragged, parentId: undefined }
		);
		emitRootOrders(nextRoot, extra);
	}

	/** Reorder a folder among the mixed root list, not a separate folder-only list. */
	function reorderCategoryFolders(fromId: string, toId: string, pos: 'before' | 'after') {
		emitRootOrders(insertRelative(rootItems(), fromId, toId, pos));
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

			const createdType = newChannelType;
			const createdId = await createChannel(
				channelName,
				newChannelDescription.trim(),
				createdType,
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
			// Project channels land in the shared Project workspace.
			if ((createdType === 'lore' || createdType === 'planning') && createdId) {
				// give the optimistic upsert a tick, then switch into it
				await new Promise((r) => setTimeout(r, 50));
				switchChannel(createdId);
			}
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
	/** The confirm names what is deleted: "Delete this voice room?", never "channel" for a room. */
	$: deleteCopy = deleteConfirmCopy(channelToDeleteNoun, channelToDeleteName || channelToDelete, channelToDeleteChildCount);
	function handleDeleteChannel(id: string) {
		const channel = $channels.find((item) => item.id === id);
		channelToDelete = id;
		channelToDeleteName = channel?.name || id;
		channelToDeleteNoun = channelNoun(channel?.type as string | undefined);
		channelToDeleteChildCount = $channels.filter((item) => item.parentId === id).length;
		showDeleteConfirm = true;
	}
	async function confirmDeleteChannel() {
		if (!channelToDelete || deletingChannel) return;
		deletingChannel = true;
		deleteChannelError = '';
		try {
			await deleteChannel(channelToDelete);
			showDeleteConfirm = false;
		} catch (error) {
			deleteChannelError = error instanceof Error ? error.message : 'Failed to delete channel.';
		} finally {
			deletingChannel = false;
		}
	}
	async function confirmDeleteChannelPreserveChildren() {
		if (!channelToDelete || deletingChannel) return;
		deletingChannel = true;
		deleteChannelError = '';
		try {
			await deleteChannelWithOptions(channelToDelete, { preserveChildren: true });
			showDeleteConfirm = false;
		} catch (error) {
			deleteChannelError = error instanceof Error ? error.message : 'Failed to delete folder.';
		} finally {
			deletingChannel = false;
		}
	}
	function handleShowPinnedMessages(id: string) { selectedChannelForPinned = id; showPinnedModal = true; }
	function handleOpenChannelSettings(ch: Channel) { selectedChannelForSettings = ch; showChannelSettingsModal = true; }
	function handleDeleteFromSettings(e: CustomEvent<{ channel: Channel }>) {
		showChannelSettingsModal = false;
		handleDeleteChannel(e.detail.channel.id);
	}
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

	// Built when the menu opens; the reactive inputs are passed in so a mute or follow change
	// while it is open re-renders the rows.
	$: channelMenuItems = contextMenuChannel
		? buildChannelMenuItems(contextMenuChannel, { muted: mutedChannelIds, followed: followedChannelIds, unreadCounts: $channelUnreadCounts })
		: [];
	/**
	 * Channel menu (spec §7.4, §9.6): sentence case at the source, kicker groups (Open, Follow,
	 * Organize, Move to folder), one glyph per meaning (star = bookmark, pin = pinned messages),
	 * folders as menuitemradio rows, and the destructive row last. Toggles keep one label and
	 * report their state through `checked` ("Mute channel", checked), never a flipped verb.
	 */
	function buildChannelMenuItems(
		ch: Channel,
		state: { muted: Set<string>; followed: Set<string>; unreadCounts: Record<string, number> }
	): MenuEntry[] {
		const sup = ch.type === 'text' || ch.type === 'public' || ch.type === 'group' || !ch.type;
		const isCategory = (ch.type as string | undefined) === 'category';
		const isVoiceRoom = ch.type === 'voice';
		const noun = channelNoun(ch.type as string | undefined);
		const followed = sup && state.followed.has(ch.id);
		const muted = state.muted.has(ch.id);
		const items: MenuEntry[] = [];

		if (!isCategory) {
			items.push(
				{ id: 'open-kicker', type: 'kicker', label: 'Open' },
				{ id: 'open-floating-panel', label: 'Open in a floating panel', icon: 'chat', onSelect: () => openChannelFloatingPanel(ch) },
				{ id: 'open-os-window', label: 'Open in a new window', icon: 'externalLink', onSelect: () => openDetachedPanel({ kind: 'channel-chat', channelId: ch.id, channelName: ch.name }) }
			);
			// The hover tray's whiteboard key, reachable on touch too (the tray is hidden there).
			if (isVoiceRoom) {
				items.push({ id: 'open-whiteboard', label: 'Open whiteboard', icon: 'whiteboard', onSelect: () => openVoiceChannelWhiteboard(ch.id) });
			}
			if (ch.type === 'text' || ch.type === 'public' || !ch.type) {
				items.push({ id: 'create-thread', label: 'New thread', icon: 'reply', onSelect: () => handleCreateThread(ch) });
			}
		}

		if (sup) {
			const followCount = $currentServerFollowedChannels.length;
			items.push(
				{ id: 'follow-kicker', type: 'kicker', label: 'Follow' },
				{ id: 'toggle-follow', label: `Follow ${noun}`, icon: 'bell', role: 'menuitemcheckbox', checked: followed, onSelect: () => toggleChannelFollowState(ch.id) },
				{ id: 'follow-alerts', label: followed ? 'Change follow alerts' : `Follow ${noun} with alerts`, icon: 'flag', hint: FOLLOW_ALERT_LEVEL_LABELS[followedChannelPreferences.get(ch.id)?.alertLevel || 'off'], onSelect: () => cycleFollowAlert(ch.id) },
				{ id: 'follow-feed', label: 'Open follow feed', icon: 'list', hint: followCount > 0 ? `${followCount} followed` : 'None followed yet', disabled: followCount === 0, onSelect: openFollowingView }
			);
		}

		items.push({ id: 'organize-kicker', type: 'kicker', label: 'Organize' });
		if (!isCategory) {
			items.push(
				{ id: 'pin-channel', label: isChannelBookmarked(ch) ? 'Remove bookmark' : `Bookmark ${noun}`, icon: 'star', onSelect: () => toggleChannelBookmark(ch) },
				{ id: 'pinned-messages', label: 'Pinned messages', icon: 'pin', onSelect: () => handleShowPinnedMessages(ch.id) }
			);
		}
		items.push({ id: 'toggle-mute-channel', label: `Mute ${noun}`, icon: 'eyeOff', role: 'menuitemcheckbox', checked: muted, onSelect: () => toggleServerMutedChannelId(ch.id) });
		// This entry only (a folder: its channels). Mark all read lives in the CHANNELS menu.
		if (!isVoiceRoom) {
			const unreadHere = unreadIdsFor(ch, state.unreadCounts);
			items.push({
				id: 'mark-read',
				label: isCategory ? 'Mark folder as read' : 'Mark as read',
				icon: 'check',
				disabled: unreadHere.length === 0,
				hint: unreadHere.length === 0 ? 'Nothing unread' : undefined,
				onSelect: () => markEntriesRead(unreadHere)
			});
		}
		items.push({ id: 'channel-settings', label: `${noun[0].toUpperCase()}${noun.slice(1)} settings`, icon: 'gear', onSelect: () => handleOpenChannelSettings(ch) });
		if (!isCategory && canCreateChannel) {
			items.push({ id: 'create-category', label: 'New folder', icon: 'folder', onSelect: openCreateFormForCategory });
		}

		if (!isCategory && allCategories.length > 0 && canReorderChannels) {
			items.push({ id: 'move-kicker', type: 'kicker', label: 'Move to folder' });
			for (const cat of allCategories) {
				items.push({
					id: `move-to-${cat.id}`,
					label: cat.name,
					keepCase: true,
					role: 'menuitemradio',
					checked: ch.parentId === cat.id,
					onSelect: () => moveChannelToCategory(ch.id, cat.id)
				});
			}
			items.push({ id: 'move-to-root', label: 'No folder (top level)', role: 'menuitemradio', checked: !ch.parentId, onSelect: () => { if (ch.parentId) moveChannelToRoot(ch.id); } });
		}

		if (isVoiceRoom && !ch.isBreakout) {
			items.push({ id: 'voice-kicker', type: 'kicker', label: 'Voice room' });
			items.push(
				hasBreakoutRooms(ch.id)
					? { id: 'close-breakout-rooms', label: 'Close breakout rooms', icon: 'undo', onSelect: () => handleCloseBreakoutRooms(ch) }
					: { id: 'create-breakout-rooms', label: 'Create breakout rooms', icon: 'layers', onSelect: () => handleCreateBreakoutRooms(ch) }
			);
		}

		// Destructive action always last (§7.4), behind a confirm.
		if (ch.id !== 'general' && ch.id !== 'voice' && !ch.isBreakout && canCreateChannel) {
			items.push({ id: 'danger-divider', type: 'separator' }, { id: 'delete-channel', label: `Delete ${noun}…`, icon: 'trash', danger: true, onSelect: () => handleDeleteChannel(ch.id) });
		}
		return items;
	}

	/** Open the create dialog on a kind (the CHANNELS / VOICE menus and buttons). */
	function openCreateForm(type: CreateableChannelType) {
		if (type === 'lore' && !loreAvailable) return;
		newChannelType = type;
		createChannelError = '';
		if (type === 'category') {
			createFolderChoice = 'none';
			createNewFolderName = '';
		}
		showCreateInput = true;
		// Re-probe lore capability when the form opens: the mount-time check
		// may have raced the very first page load and returned false, which
		// would otherwise leave the Project files option stuck as unavailable.
		void refreshLoreCapability();
	}

	/** The CHANNELS kicker menu (spec §8.1): New channel, New folder, Mark all read. */
	$: channelsMenuItems = [
		...(canCreateChannel
			? ([
					{ id: 'new-channel', label: $_('sidebar.new_channel'), icon: 'plus', onSelect: () => openCreateForm('text') },
					{ id: 'new-folder', label: $_('sidebar.new_folder'), icon: 'folder', onSelect: openCreateFormForCategory },
					{ id: 'channels-divider', type: 'separator' }
				] satisfies MenuEntry[])
			: []),
		{
			id: 'mark-all-read',
			label: $_('sidebar.mark_all_read'),
			icon: 'check',
			disabled: communityUnread.length === 0,
			hint: communityUnread.length === 0 ? 'Nothing unread' : undefined,
			onSelect: markCommunityRead
		}
	] satisfies MenuEntry[];

	/** Row B: the search field opens the jump palette (§7.24); typing in it carries the text over. */
	function openSearch(event: MouseEvent) {
		openPalette('all', { origin: event.currentTarget as HTMLElement | null });
	}
	function handleSearchKeydown(event: KeyboardEvent) {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (event.key.length === 1 && event.key !== ' ') {
			event.preventDefault();
			openPalette('all', { query: event.key, origin: event.currentTarget as HTMLElement | null });
		}
	}

	function openCreateFormForCategory() {
		newChannelType = 'category';
		createChannelError = '';
		createFolderChoice = 'none';
		createNewFolderName = '';
		showCreateInput = true;
		void refreshLoreCapability();
	}

	/** Re-probe lore addon capability (mount-time check may have raced). */
	function refreshLoreCapability(): void {
		void hasAddonCapability('lore').then((ok) => {
			loreAvailable = ok;
		});
	}
</script>

<nav
	class="channel-sidebar"
	class:compact={isCompactSidebar}
	class:narrow={widthTier === 'narrow'}
	class:nav-right={!$layoutStore.isMobile && $layoutStore.navDock === 'right'}
	style:width={$layoutStore.isMobile ? '100%' : $compactShellTier === 'full' ? null : `${$compactShellTier === 'compact' ? 60 : $layoutStore.channelSidebarWidth}px`}
	aria-label={currentServerLabel}
>
	<!--
		Names show in tooltips only in the 60px rail, so a Tooltip (its bubble, observers and
		listeners) is mounted only there; the full column renders the bare controls.
	-->
	{#snippet homeButton()}
		<button
			type="button"
			class="server-identity sb-home"
			class:active={sidebarPlace === 'server'}
			aria-label={`${currentServerLabel}, ${$_('places.server_home')}`}
			aria-current={sidebarPlace === 'server' ? 'page' : undefined}
			on:click={() => { dispatch('openServerHub'); dispatch('close'); }}
		>
			{#if serverIdentityIconUrl && !serverIdentityImageFailed}
				<img src={serverIdentityIconUrl} alt="" class="sb-mark sb-mark--image" on:error={() => (serverIdentityImageFailed = true)} />
			{:else}
				<span class="sb-mark sb-enso" aria-hidden="true"></span>
			{/if}
			<span class="server-name">{currentServerLabel}</span>
		</button>
	{/snippet}
	{#snippet searchButton()}
		<button
			type="button"
			class="w-field w-field--chrome sb-search"
			aria-label={$_('sidebar.search')}
			aria-haspopup="dialog"
			aria-keyshortcuts="Control+K"
			on:click={openSearch}
			on:keydown={handleSearchKeydown}
		>
			<Icon name="search" size={16} />
			<span class="sb-search-label">{$_('sidebar.search')}</span>
			<kbd class="w-kbd">Ctrl K</kbd>
		</button>
	{/snippet}
	{#snippet dmsButton()}
		<button
			class="channel-btn messages-hub-btn"
			type="button"
			class:active={sidebarPlace === 'dm'}
			class:unread={dmUnreadCount > 0}
			on:click={openDmHub}
			aria-label={dmRowLabel(dmUnreadCount, friendRequestCount)}
			aria-current={sidebarPlace === 'dm' ? 'page' : undefined}
		>
			<span class="row-glyph" aria-hidden="true"><Icon name="dm" size={18} /></span>
			<span class="row-name">{$_('places.dms')}</span>
			<span class="row-trail" aria-hidden="true">
				{#if friendRequestCount > 0}
					<span class="row-mark row-mark--count" title="Friend requests"><Icon name="userPlus" size={14} /><span class="w-count">{formatBadge(friendRequestCount)}</span></span>
				{/if}
				{#if dmUnreadCount > 0}<span class="w-badge">{formatBadge(dmUnreadCount)}</span>{/if}
			</span>
		</button>
	{/snippet}

	<!-- Masthead: row A (community, Switch server) + row B (search), one hairline at --w-mast. -->
	<header class="sb-mast">
		<div class="sb-head">
			<button type="button" class="mobile-close-btn w-ibtn" aria-label="Close channels" on:click={() => dispatch('close')}><Icon name="x" size={20} /></button>
			{#if isCompactSidebar}
				<Tooltip text={currentServerLabel} placement="right" describe={false}>{@render homeButton()}</Tooltip>
			{:else}
				{@render homeButton()}
			{/if}
			<button
				type="button"
				class="w-ibtn sb-switch"
				aria-label={$_('sidebar.switch_server')}
				title={$_('sidebar.switch_server')}
				on:click={() => dispatch('openServerSwitcher')}
			><Icon name="chevUpDown" size={18} /></button>
		</div>
		<div class="sb-search-row">
			{#if isCompactSidebar}
				<Tooltip text={$_('sidebar.search')} shortcut="Ctrl K" placement="right" describe={false}>{@render searchButton()}</Tooltip>
			{:else}
				{@render searchButton()}
			{/if}
		</div>
	</header>

	<div
		class="channel-list"
		bind:this={channelListEl}
		on:dragover={handleListDragOver}
		on:dragleave={handleListDragLeave}
		on:drop={handleListDrop}
	>
		<!-- DMs: the personal destination (spec D6: one name, "DMs"). -->
		<div class="personal-nav">
			{#if isCompactSidebar}
				<Tooltip text={$_('places.dms')} placement="right" describe={false}>{@render dmsButton()}</Tooltip>
			{:else}
				{@render dmsButton()}
			{/if}
		</div>

		<!-- CHANNELS -->
		<div class="sb-sec">
			<button class="sb-sec-toggle" type="button" aria-expanded={isTextSectionExpanded} on:click={() => (isTextSectionExpanded = !isTextSectionExpanded)}>
				<span class="w-kicker">{$_('sidebar.channels')}</span>
				<span class="sb-sec-chevron" aria-hidden="true"><Icon name="chevDown" size={12} /></span>
			</button>
			<!-- The menu also holds Mark all read, so its name is the whole set, not "New channel". -->
			<Menu class="w-ibtn sb-sec-add" label={$_('sidebar.channel_actions')} triggerLabel={$_('sidebar.channel_actions')} align="end" items={channelsMenuItems}>
				<Icon name={canCreateChannel ? 'plus' : 'more'} size={14} />
			</Menu>
		</div>
		{#if isTextSectionExpanded}
		<div class="section-body" bind:this={channelSectionEl} transition:slide={sectionSlideParams}>
	{#each rootSections.channels as item (item.id)}
		<div class="mixed-root-item" animate:flip={rootFlipParams}>
		{#if item.kind === 'folder'}
		<div
			class="category-row"
			role="group"
			class:is-dragging={draggedCategoryId === item.id}
			draggable={canReorderChannels}
			data-drop-anchor="folder"
			data-folder-id={item.id}
			on:dragstart|stopPropagation={(e) => handleCategoryFolderDragStart(e, item.id)}
			on:dragend={handleChannelDragEnd}
			on:contextmenu={(e) => handleChannelRightClick(e, item.channel)}
			use:longpress={{ onLongPress: (e) => handleChannelLongPress(e, item.channel) }}
		>
			{#snippet folderToggle()}
				<button class="category-toggle" type="button" aria-expanded={!collapsedCategories.has(item.id)} on:click={() => toggleCategory(item.id)}>
					<span class="category-chevron" aria-hidden="true"><Icon name="chevRight" size={14} /></span>
					<span class="category-folder-icon" aria-hidden="true"><Icon name="folder" size={16} /></span>
					<span class="category-name">{item.channel.name}</span>
					<span class="w-count category-count" aria-hidden="true">{item.children.length}</span>
					<span class="sr-only">, folder, {item.children.length} {item.children.length === 1 ? 'channel' : 'channels'}</span>
				</button>
			{/snippet}
			{#if isCompactSidebar}
				<Tooltip text={item.channel.name} placement="right" describe={false}>{@render folderToggle()}</Tooltip>
			{:else}
				{@render folderToggle()}
			{/if}
		</div>
		{#if !collapsedCategories.has(item.id)}
			<div
				class="category-channels"
				data-category-id={item.id}
				class:drop-target={autoExpandCategoryId === item.id}
			>
				<UnifiedChannelList channels={item.children} currentPlace={sidebarPlace} compact={isCompactSidebar} {threadChannelsByParent} {followedChannelIds} {liveWhiteboardChannelIds} {breakoutChannelsByParent} {connectedVoiceChannelIds} {runtimeActiveVoiceChannelId} {voiceDropTargetChannelId} {voicePresenceSince} {voiceDurationMode} {nowMs} reorderEnabled={canReorderChannels} {isChannelDragging} onChannelClick={handleChannelClick} onChannelButtonClick={handleChannelButtonClick} onVoiceChannelClick={handleVoiceChannelClick} onChannelRightClick={handleChannelRightClick} onChannelLongPress={handleChannelLongPress} onToggleChannelFollow={toggleChannelFollowState} onOpenChannelSettings={handleOpenChannelSettings} onShowPinnedMessages={handleShowPinnedMessages} onToggleListenChannel={handleToggleListenChannel} onOpenVoiceChannelWhiteboard={openVoiceChannelWhiteboard} {canDragVoiceMember} {canKickVoiceMember} onVoiceMemberDragStart={handleVoiceMemberDragStart} onVoiceMemberDragEnd={handleVoiceMemberDragEnd} onKickVoiceMember={handleKickVoiceMember} onVoiceChannelDragOver={handleVoiceChannelDragOver} onVoiceChannelDragLeave={handleVoiceChannelDragLeave} onVoiceChannelDrop={handleVoiceChannelDrop} onChannelDragStart={handleChannelDragStart} onChannelDragEnd={handleChannelDragEnd} />
			</div>
		{/if}
		{:else}
		<UnifiedChannelList channels={[item.channel]} currentPlace={sidebarPlace} compact={isCompactSidebar} {threadChannelsByParent} {followedChannelIds} {liveWhiteboardChannelIds} {breakoutChannelsByParent} {connectedVoiceChannelIds} {runtimeActiveVoiceChannelId} {voiceDropTargetChannelId} {voicePresenceSince} {voiceDurationMode} {nowMs} reorderEnabled={canReorderChannels} {isChannelDragging} onChannelClick={handleChannelClick} onChannelButtonClick={handleChannelButtonClick} onVoiceChannelClick={handleVoiceChannelClick} onChannelRightClick={handleChannelRightClick} onChannelLongPress={handleChannelLongPress} onToggleChannelFollow={toggleChannelFollowState} onOpenChannelSettings={handleOpenChannelSettings} onShowPinnedMessages={handleShowPinnedMessages} onToggleListenChannel={handleToggleListenChannel} onOpenVoiceChannelWhiteboard={openVoiceChannelWhiteboard} {canDragVoiceMember} {canKickVoiceMember} onVoiceMemberDragStart={handleVoiceMemberDragStart} onVoiceMemberDragEnd={handleVoiceMemberDragEnd} onKickVoiceMember={handleKickVoiceMember} onVoiceChannelDragOver={handleVoiceChannelDragOver} onVoiceChannelDragLeave={handleVoiceChannelDragLeave} onVoiceChannelDrop={handleVoiceChannelDrop} onChannelDragStart={handleChannelDragStart} onChannelDragEnd={handleChannelDragEnd} />
		{/if}
		</div>
	{/each}
		</div>
		{/if}

		<!-- VOICE: top-level rooms (a room inside a folder stays in its folder). -->
		{#if rootSections.voice.length > 0 || canCreateChannel}
			<div class="sb-sec">
				<button class="sb-sec-toggle" type="button" aria-expanded={isVoiceSectionExpanded} on:click={() => (isVoiceSectionExpanded = !isVoiceSectionExpanded)}>
					<span class="w-kicker">{$_('sidebar.voice')}</span>
					<span class="sb-sec-chevron" aria-hidden="true"><Icon name="chevDown" size={12} /></span>
				</button>
				{#if canCreateChannel}
					<button type="button" class="w-ibtn sb-sec-add" aria-label={$_('sidebar.new_voice_room')} title={$_('sidebar.new_voice_room')} on:click={() => openCreateForm('voice')}><Icon name="plus" size={14} /></button>
				{/if}
			</div>
			{#if isVoiceSectionExpanded}
				<div class="section-body voice-section" bind:this={voiceSectionEl} transition:slide={sectionSlideParams}>
					{#each rootSections.voice as item (item.id)}
						<div class="mixed-root-item" animate:flip={rootFlipParams}>
							<UnifiedChannelList channels={[item.channel]} currentPlace={sidebarPlace} compact={isCompactSidebar} {threadChannelsByParent} {followedChannelIds} {liveWhiteboardChannelIds} {breakoutChannelsByParent} {connectedVoiceChannelIds} {runtimeActiveVoiceChannelId} {voiceDropTargetChannelId} {voicePresenceSince} {voiceDurationMode} {nowMs} reorderEnabled={canReorderChannels} {isChannelDragging} onChannelClick={handleChannelClick} onChannelButtonClick={handleChannelButtonClick} onVoiceChannelClick={handleVoiceChannelClick} onChannelRightClick={handleChannelRightClick} onChannelLongPress={handleChannelLongPress} onToggleChannelFollow={toggleChannelFollowState} onOpenChannelSettings={handleOpenChannelSettings} onShowPinnedMessages={handleShowPinnedMessages} onToggleListenChannel={handleToggleListenChannel} onOpenVoiceChannelWhiteboard={openVoiceChannelWhiteboard} {canDragVoiceMember} {canKickVoiceMember} onVoiceMemberDragStart={handleVoiceMemberDragStart} onVoiceMemberDragEnd={handleVoiceMemberDragEnd} onKickVoiceMember={handleKickVoiceMember} onVoiceChannelDragOver={handleVoiceChannelDragOver} onVoiceChannelDragLeave={handleVoiceChannelDragLeave} onVoiceChannelDrop={handleVoiceChannelDrop} onChannelDragStart={handleChannelDragStart} onChannelDragEnd={handleChannelDragEnd} />
						</div>
					{/each}
				</div>
			{/if}
		{/if}

		{#if dropLine}
			<div
				class="drop-indicator-overlay"
				class:indented={dropLine.x > ROOT_LINE_X + 1}
				style="top:{dropLine.y}px; left:{dropLine.x}px;"
				aria-hidden="true"
			></div>
		{/if}
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

	<ContextMenu open={showContextMenu && !!contextMenuChannel} x={contextMenuPosition.x} y={contextMenuPosition.y} items={channelMenuItems} ariaLabel={$_('sidebar.channel_actions')} headerLabel={contextMenuChannel ? (((contextMenuChannel.type as string | undefined) === 'category' || contextMenuChannel.type === 'voice') ? contextMenuChannel.name : `#${contextMenuChannel.name}`) : null} on:close={closeContextMenu} />
	<VoiceUserCard {runtimeActiveVoiceChannelId} {voiceChannels} {voiceDurationMode} onToggleListenChannel={handleToggleListenChannel} onTransmitModeChange={handleTransmitModeChange} onSetVoiceDurationMode={setVoiceDurationMode} onLeaveVoice={handleLeaveVoice} />
	<ProfileCard {sidebarWidth} compact={isCompactSidebar} on:openProfilePopout={openOwnProfilePopout} on:openSettings={() => dispatch('openSettings')} />

	{#if glimpseChannelId && glimpseChannel}
		<div
			class="channel-glimpse-popout channel-glimpse-fixed w-pop"
			bind:this={glimpsePopover}
			style="left:{glimpsePosition.x}px; top:{glimpsePosition.y}px;"
			transition:fly={{ x: 8, duration: 140 }}
		>
			<div class="channel-glimpse-header">
				<div>
					<button
						type="button"
						class="channel-glimpse-name"
						on:click={() => handleChannelClick(glimpseChannel.id)}
						title={`Open #${glimpseChannel.name}`}
					>
						#{glimpseChannel.name}
					</button>
					<small>{glimpseChannelMessages.length > 0 ? `${glimpseChannelMessages.length} recent` : glimpseHydrated ? 'No recent' : 'Loading…'}</small>
				</div>
				<button
					type="button"
					class="channel-glimpse-follow-btn w-btn w-btn--sm"
					aria-pressed={followedChannelIds.has(glimpseChannel.id)}
					on:click|stopPropagation={(event) => toggleChannelFollowState(glimpseChannel.id, event)}
					title={followedChannelIds.has(glimpseChannel.id) ? 'Unfollow channel' : 'Follow channel'}
				>
					{followedChannelIds.has(glimpseChannel.id) ? 'Following' : 'Follow'}
				</button>
			</div>
			{#if glimpseChannelMessages.length > 0}
				<div class="channel-glimpse-messages" bind:this={glimpseMessagesEl}>
					{#each glimpseChannelMessages as message, messageIndex (message.id || message.clientMessageId || `glimpse-${messageIndex}`)}
						<div class="channel-glimpse-message">
							<div class="channel-glimpse-meta">
								<strong>{message.user}</strong>
								<span>{formatGlimpseTime(message.timestamp)}</span>
							</div>
							<p>{summarizeGlimpseMessage(message)}</p>
						</div>
					{/each}
				</div>
			{:else if !glimpseHydrated}
				<p class="channel-glimpse-empty">Loading recent messages…</p>
			{:else}
				<p class="channel-glimpse-empty">No recent messages</p>
			{/if}
		</div>
	{/if}
</nav>

{#if deleteChannelError}<div class="channel-delete-error" role="alert">{deleteChannelError}</div>{/if}
<BreakoutRoomsModal open={showBreakoutModal} channelName={breakoutTargetChannel?.name || ''} memberCount={breakoutTargetChannel ? getVoiceMembers(breakoutTargetChannel.id).length : 0} onCreate={confirmCreateBreakoutRooms} onClose={() => { showBreakoutModal = false; }} />
<ConfirmDialog
	isOpen={showDeleteConfirm}
	title={deleteCopy.title}
	message={deleteCopy.message}
	confirmText={deletingChannel ? 'Deleting…' : deleteCopy.confirm}
	secondaryText={deleteCopy.secondary}
	variant="danger"
	onConfirm={confirmDeleteChannel}
	onSecondary={() => void confirmDeleteChannelPreserveChildren()}
	onCancel={() => { if (!deletingChannel) showDeleteConfirm = false; }}
/>
<PinnedMessagesModal bind:isOpen={showPinnedModal} channelId={selectedChannelForPinned} />
<UserPopout user={$currentUser} bind:isOpen={showOwnProfilePopout} anchorElement={ownProfilePopoutAnchor} isOwnProfile={true} on:close={() => (showOwnProfilePopout = false)} on:openFullProfile={() => dispatch('openSettings')} />
{#if showChannelSettingsModal && selectedChannelForSettings}
	<ChannelSettingsModal channel={selectedChannelForSettings} {canTogglePersistMessages} {canManageWatchQueue} {canManageVoiceSettings} on:save={handleSaveChannelSettings} on:delete={handleDeleteFromSettings} on:close={() => (showChannelSettingsModal = false)} />
{/if}
