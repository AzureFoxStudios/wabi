<!-- frontend/src/lib/components/MainLayout.svelte -->
<script lang="ts">
	import GlanceHost from './GlanceHost.svelte';
	import { workspaceToolFromTab } from '$lib/workspaces/bridge';
	import WorkspaceLinkHandler from '$lib/workspaces/WorkspaceLinkHandler.svelte';
	import WorkspaceHost from '$lib/workspaces/WorkspaceHost.svelte';
	import { fly } from 'svelte/transition';
	import GamesHost from '$lib/games/GamesHost.svelte';
	import { layoutStore } from '$lib/layoutStore';
	import { get } from 'svelte/store';
	import { centerPanelView, centerDmOtherUser, centerGroupChannel, compactSidebarOpen, focusMode, isCompactShell, isNavRail } from '$lib/layoutStoreStates';
	import { armPeekDismiss, cancelPeekDismiss, peekAnimationGate, setPeekPointerInside } from '$lib/rightPeekGestures';
	import { dockCanPin, endPeek, peekHeld, peekRequested } from '$lib/layoutStoreRightPanel';
	import { DOCK_DEFAULT_PANEL, DOCK_MIN_PANEL, dockWidthFor, resizeKeyWidth } from '$lib/dockClamp';
	import { registerPluginWorkspacePanels } from '$lib/workspacePanels';
	import { fetchPluginInventory } from '$lib/addonInventory';
	import Chat from '$lib/components/Chat.svelte';
import DmConversationView from '$lib/components/DmConversationView.svelte';
import DmHub from '$lib/components/DmHub.svelte';
	import ChannelSidebar from '$lib/components/ChannelSidebar.svelte';
	import FloatingPanelHost from '$lib/components/windowing/FloatingPanelHost.svelte';
	import ServerRail from '$lib/components/ServerRail.svelte';
	import ServerSwitcherPanel from '$lib/components/ServerSwitcherPanel.svelte';
	import ServerHub from '$lib/components/ServerHub.svelte';
	import CommunityRulesNotice from '$lib/components/CommunityRulesNotice.svelte';
	import { getOpeningSurface } from '$lib/openingSurface';
	import { getAuthToken } from '$lib/authSession';
	import FollowingFeed from '$lib/components/FollowingFeed.svelte';
	import NotificationsCenter from '$lib/components/NotificationsCenter.svelte';
	import { friendships, startFriendshipSync } from '$lib/friendships';
	import { remoteFriendRequests, startRemoteFriendRequestPoller } from '$lib/crossServerFriendRequests';
	import { followUnreadCountsByServer } from '$lib/followingSnapshots';
	import { NOTIFICATIONS_ADDON_ID } from '$lib/notificationsWorkspace';
	import { getDmDirectoryKey } from '$lib/dmUserDirectory';
	import { findExistingDmChannel } from '$lib/dmConversations';
	import { currentSavedServer } from '$lib/savedServers';
	import { currentTheme } from '$lib/theme/themeStore';
	import { communityDisplayFont } from '$lib/theme/displayFonts';
	import RightStubStrip from '$lib/components/RightStubStrip.svelte';
	import VoiceLiveStrip from '$lib/components/VoiceLiveStrip.svelte';
	import { voiceViewOpen } from '$lib/voiceView';
	import { activeWorkspaceView, selectWorkspaceView } from '$lib/workspaceNavigationState';
	import type { WorkspaceViewKey } from './chat/types';
	import AuthErrorBanner from '$lib/components/AuthErrorBanner.svelte';
	import { channelUnreadCounts, channels, currentChannel, currentUser, users, createDM, getSocket, leaveVoiceChannel as leaveSocketVoiceChannel, joinChannel, type User } from '$lib/socket';
	import { activeCalls, activeVoiceChannel, callMode, connectionState, incomingCall, outgoingCall, isInCall, activeGroupCall, groupCallRingingTargets, isVideoOff, toggleVideo, channelCallPanelOpen, callOfflineNotice } from '$lib/calling';
	import { connectionWords, cornerBar, dockCallPanel } from '$lib/callShell';
	import Icon from '$lib/components/ui/Icon.svelte';
	import { mobileTabQueue } from '$lib/mobileTabQueue';
	import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
import { _ } from '$lib/i18n';
import { displayEnhancementSettingsStore } from '$lib/displayEnhancements';
	import { playNotificationSound } from '$lib/notifications';
	import { MAP_ADDON_ID } from '$lib/mapWorkspace';
	import { MODEL_VIEWPORT_ADDON_ID } from '$lib/modelViewportTab';
	import { READER_ADDON_ID } from '$lib/readerWorkspace';
	import { MEDIA_ALBUMS_ADDON_ID } from '$lib/mediaAlbumsWorkspace';
	import { PLANNER_ADDON_ID } from '$lib/plannerWorkspace';
	import { NOTES_ADDON_ID } from '$lib/notesWorkspace';
	import StageBar from '$lib/components/StageBar.svelte';
	import {
		getServerScopedUserKey,
		getTrackedPersonKeyForUser,
		isTrackedPersonStatusAlertsKeyEnabled,
		rememberPeople
	} from '$lib/peopleTracker';
	import { getServerUrl, normalizeServerUrl, resolveServerUrl } from '$lib/serverUrl';
	import { savedServerRailItems } from '$lib/savedServers';
	import { desktopServerRailPinned } from '$lib/serverNavigationPreference';
	import { isDesktopTauri } from '$lib/tauri-platform';
	// N1: floating QuickScratchpad
	import { quickScratchpadOpen, closeQuickScratchpad } from '$lib/notesStore';
	import QuickScratchpad from '$lib/components/QuickScratchpad.svelte';
	import InstallAppBanner from '$lib/components/pwa/InstallAppBanner.svelte';
	import {
		formatMobileUnreadBadge,
		mobileNavDestination,
		nextMobileBackSurface,
		reconcileMobileSurfaceStack,
		shouldRenderMobileNavigation,
		sidebarFlowWidth,
		sumUnreadCommunityCount,
		sumUnreadConversationCount,
		type MobileBackSurface,
		type MobileNavDestination,
		type MobileSurfaceState,
		type YouSettingsPage
	} from '$lib/mobileShellModel';
	import MobileNav from '$lib/components/MobileNav.svelte';
	import YouPage from '$lib/components/YouPage.svelte';
	import type { SettingsRequest } from '$lib/components/settings/settingsFrame';
	import { showToast } from '$lib/toast';
	import { workspaceViewSelect, workspaceActivityBadge } from '$lib/workspaceViewBridge';

	// Phase 4 boot optimization: non-first-paint surfaces load on first
	// activation. Only .svelte components go lazy; utility-module imports
	// above (stores and navigation) stay static.
	let ModelViewportTabCmp: typeof import('./ModelViewportTab.svelte').default | null = null;
	let ReaderTabCmp: typeof import('./ReaderTab.svelte').default | null = null;
	let MapWorkspaceCmp: typeof import('./MapWorkspace.svelte').default | null = null;
	let MediaAlbumsTabCmp: typeof import('./MediaAlbumsTab.svelte').default | null = null;
	let GalleryChannelCmp: typeof import('./GalleryChannel.svelte').default | null = null;
	let CallModalCmp: typeof import('./CallModal.svelte').default | null = null;
	let VoiceViewCmp: typeof import('./VoiceView.svelte').default | null = null;
	let SettingsCmp: typeof import('./Settings.svelte').default | null = null;
	let AdminCenterStageCmp: typeof import('./AdminCenterStage.svelte').default | null = null;
	let KeepNotesViewCmp: typeof import('./KeepNotesView.svelte').default | null = null;
	let PlannerWorkspaceCmp: typeof import('./business/PlannerWorkspace.svelte').default | null = null;
	let CallDebugPanelCmp: typeof import('./CallDebugPanel.svelte').default | null = null;
	let RightPanelCmp: typeof import('./RightPanel.svelte').default | null = null;

	export let newlyRegistered = false;
	export let activeView: 'chat' | 'business' | 'screen' | 'following' | 'dm' | 'server' = newlyRegistered || getOpeningSurface() === 'server' ? 'server' : getOpeningSurface() === 'messages' ? 'dm' : 'chat';
	export let accountSecurityOpenRequest = 0;
	let showSettings = false;
	let requestedSettingsPaymentSurface: 'connections' | null = null;
	// Settings resolves any page id (resolveSettingsRequest); the You page also opens Appearance and
	// Privacy & security directly.
	let requestedSettingsTab: SettingsRequest | YouSettingsPage | null = null;
	let activityActionError = '';
	let requestedSettingsPasswordChangeRequest = 0;
	let lastHandledAccountSecurityOpenRequest = 0;
	// N1: overlay reactive
	$: showQuickScratchpad = $quickScratchpadOpen;

	$: totalUnreadDMs = sumUnreadConversationCount($channelUnreadCounts, $channels);
	$: communityUnread = sumUnreadCommunityCount($channelUnreadCounts, $channels);
	let hubRequestSequence = 0;
	let friendsOpenRequest = 0;
	let messagesOpenRequest = 0;
	let dmHubActiveTab: 'messages' | 'friends' = 'messages';
	let unsubscribeFriendshipSync: (() => void) | null = null;
	let unsubscribeFriendRequestNotices: (() => void) | null = null;
	let knownIncomingRequestIds: Set<string> | null = null;
	$: activityCount = $friendships.incoming.length + Object.values($remoteFriendRequests).reduce((sum, entry) => sum + entry.requests.length, 0) + Object.values($followUnreadCountsByServer).reduce((sum, count) => sum + count, 0) + totalUnreadDMs;
	$: activityBadge = formatMobileUnreadBadge(activityCount);

	let resizingChannel = false;
	let resizingRight = false;
	let showCallDebugPanel = false;
	// The floating calling-diagnostics toggle is a developer instrument (§9.4): CallDebugPanel
	// renders only in dev builds, so the toggle and its overlay exist only there too. Members reach
	// Connection details (ping, loss, route) from the call's Call options and the Calls page.
	const callDebugPanelEnabled = import.meta.env.DEV;
	let showServerSwitcher = false;
	let serverHubReturnView: typeof activeView = 'chat';
	let serverHubWelcome = newlyRegistered;
	const dispatch = createEventDispatcher<{ logout: void }>();
	// Root navigation is structural chrome (§8.12): present whenever the phone shell is, never
	// behind a reveal gesture. The keyboard (CSS, data-keyboard-open) and a call are the only
	// takeovers. Under 600px it is the bottom nav; from 600 to 768px a 72px left rail.
	$: mobileNavShown = shouldRenderMobileNavigation({ isMobile: $layoutStore.isMobile, isInCall: $layoutStore.isInCall });
	$: bottomNavShown = mobileNavShown && !$isNavRail;
	$: navRailShown = mobileNavShown && $isNavRail;
	// The You page (§8.12): a page in the phone stage; the nav stays.
	let mobileYouOpen = false;
	$: youPageShown = mobileYouOpen && $layoutStore.isMobile;
	let touchStartX = 0;
	let touchStartY = 0;
	let touchStartTime = 0;
	let touchGestureEnabled = false;
	let touchMovedEnough = false;
	let swipePreviewActive = false;
	let swipePreviewTarget: 'none' | 'channels' | 'users' = 'none';
	let swipePreviewOffsetX = 0;
	let mobileSurfaceStack: MobileBackSurface[] = [];
	// Right-panel peek retract: when the panel leaves the screen, keep the zone mounted
	// briefly to play the slide-out instead of yanking it from the DOM.
	// (Legacy reactivity — this file is not runes-mode.)
	let peekClosing = false;
	let peekClosingTimer: ReturnType<typeof setTimeout> | null = null;
	let prevZoneOpenForExit = false;
	// Center-stage guard (§8.4, dockClamp.ts): a companion pins in flow only while the stage keeps
	// 600px. A panel opened when there is no room is a peek over the stage with the scrim; a pin that
	// loses its room is stowed (kept, off screen) until the room comes back. The stage width never
	// changes for a peek. Widths are measured here and the verdict is published for the rail.
	let viewportWidth = typeof window === 'undefined' ? 1536 : window.innerWidth;
	let railWidth = 44;
	function measureRailWidth(): void {
		if (typeof window === 'undefined') return;
		const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--w-rail-w'));
		if (Number.isFinite(value) && value > 0) railWidth = value;
	}
	$: dockRail = !$layoutStore.isMobile && !$focusMode ? railWidth : 0;
	// The sidebar's width in flow: the stored desktop width, or the 60px compact rail in the
	// 769–1023px band (§8.13), where the full column opens over the stage instead.
	$: compactShell = !$layoutStore.isMobile && $isCompactShell;
	$: sidebarColumnWidth = $layoutStore.isMobile ? 0 : sidebarFlowWidth($layoutStore.channelSidebarWidth, compactShell);
	$: dockSidebar = $layoutStore.isMobile ? 0 : sidebarColumnWidth + desktopServerRailOffset;

	// The compact band's drawer: the full sidebar over the stage, with a scrim; the stage keeps its
	// width. Escape, the scrim, the toggle or choosing a place (a channel, DMs, a workspace) close it.
	let sidebarContainer: HTMLElement | null = null;
	let compactToggle: HTMLButtonElement | null = null;
	$: compactDrawerOpen = compactShell && $compactSidebarOpen;
	$: if (!compactShell && $compactSidebarOpen) compactSidebarOpen.set(false);
	let compactDrawerPlace = '';
	function openCompactSidebar(): void {
		compactDrawerPlace = stagePlace;
		compactSidebarOpen.set(true);
		void tick().then(() => {
			const here = sidebarContainer?.querySelector<HTMLElement>('.channel-sidebar [aria-current="page"]');
			(here ?? sidebarContainer?.querySelector<HTMLElement>('.channel-sidebar button'))?.focus({ preventScroll: true });
		});
	}
	function closeCompactSidebar(returnFocus: boolean): void {
		if (!get(compactSidebarOpen)) return;
		compactSidebarOpen.set(false);
		if (returnFocus) void tick().then(() => compactToggle?.focus({ preventScroll: true }));
	}
	function toggleCompactSidebar(): void {
		if (get(compactSidebarOpen)) closeCompactSidebar(false);
		else openCompactSidebar();
	}
	$: if (compactDrawerOpen && stagePlace !== compactDrawerPlace) closeCompactSidebar(false);
	function handleCompactDrawerKeydown(event: KeyboardEvent): void {
		if (!compactDrawerOpen || event.key !== 'Escape' || event.defaultPrevented) return;
		if (event.target instanceof Element && event.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
		event.preventDefault();
		closeCompactSidebar(true);
	}
	$: dock = dockWidthFor({ viewport: viewportWidth, sidebar: dockSidebar, rail: dockRail, requested: $layoutStore.rightPanelWidth });
	$: dockCanPin.set(dock.mode === 'pin');
	$: dockPinned = !$layoutStore.isMobile && $layoutStore.rightPanelMode === 'pinned' && dock.mode === 'pin';
	// The layout store's pinStowed(): pinned, no room. Off screen unless a held peek shows a panel over it.
	$: dockStowed = !$layoutStore.isMobile && $layoutStore.rightPanelMode === 'pinned' && dock.mode === 'peek';
	$: dockPeeking = !$layoutStore.isMobile && ($layoutStore.rightPanelMode === 'peek' || (dockStowed && $peekHeld));
	$: zoneOpen = $layoutStore.rightPanelMode !== 'none' && !(dockStowed && !$peekHeld);
	$: trackZoneOpen(zoneOpen);
	// A stowed pin keeps its zone mounted, hidden and inert, so the panel's own state (search text,
	// a channel picked inside it, a loaded viewer, scroll) survives a resize. Only a close unmounts it.
	$: zoneMounted = $layoutStore.rightPanelMode !== 'none';
	$: zoneHidden = !zoneOpen && !peekClosing;
	// A peek the person asked for gets the full scrim; a click on it ends the peek (§8.4, D11). A peek
	// the app opened on its own (the Calls peek on joining a call) never dims the stage. A peek opened
	// on purpose also takes the covered stage out of keyboard reach; a hover glance never touches focus.
	$: stageScrim = dockPeeking && ($peekHeld || $peekRequested);
	$: stageInert = dockPeeking && $peekHeld;
	// A closing peek keeps its place, edge and shadow while it leaves.
	let zoneWasPeek = false;
	$: if (zoneOpen) zoneWasPeek = dockPeeking;
	$: zoneFloats = dockPeeking || (peekClosing && zoneWasPeek);
	// The scrim stays through the peek's exit animation, then goes.
	let scrimVisible = false;
	$: updateScrimVisible(stageScrim, peekClosing);
	function updateScrimVisible(scrim: boolean, closing: boolean): void {
		scrimVisible = scrim || (scrimVisible && closing);
	}
	onMount(measureRailWidth);
	// The scrim covers exactly the stage (everything between the sidebar and the rail), and a peek
	// hangs over the stage's edge on the rail side: past the sidebar when both share that side.
	$: navOnStubSide = ($layoutStore.navDock === 'right') === ($layoutStore.stubSide !== 'left');
	$: peekInset = dockRail + (navOnStubSide ? dockSidebar : 0);
	$: scrimLeft = ($layoutStore.stubSide === 'left' ? dockRail : 0) + ($layoutStore.navDock === 'right' ? 0 : dockSidebar);
	$: scrimRight = ($layoutStore.stubSide === 'left' ? 0 : dockRail) + ($layoutStore.navDock === 'right' ? dockSidebar : 0);

	// Under a held peek's scrim the covered stage (masthead, surface, voice strip) is out of
	// reach for the pointer, so it is inert for the keyboard too. The covered parts stay direct
	// children of .chat-stack and each gets `inert` (coverStage), so no wrapper sits between the
	// stage container and its parts.
	// The embedded call and the minimized call foot are stage parts as well: they paint under the
	// scrim and are inert with the stage. CallModal sets that inert itself (followStageInert mirrors
	// .chat-surface's), because it alone knows when the shell turns into full window, which covers
	// the whole app and is never under the scrim. They are listed here (CALL_STAGE_PARTS) so focus
	// in them moves into the peek and comes back like focus on the rest of the stage. The incoming
	// and outgoing call dialogs are not stage parts: they sit above the scrim and stay live, so a
	// call can always be answered.
	const STAGE_PARTS = '.stage-bar, .chat-surface, .voice-live-strip';
	const CALL_STAGE_PARTS = '.call-shell.mode-embedded, .docked-bar';
	let chatStack: HTMLElement | null = null;
	function inCoveredStage(element: Element): boolean {
		return Array.from(chatStack?.children ?? []).some((part) => (part.matches(STAGE_PARTS) || part.matches(CALL_STAGE_PARTS)) && part.contains(element));
	}
	/** Svelte action for .chat-stack: makes its stage parts inert while covered, including parts mounted meanwhile. */
	function coverStage(node: HTMLElement, covered: boolean) {
		const madeInert = new Set<Element>();
		let observer: MutationObserver | null = null;
		const apply = () => {
			for (const part of Array.from(node.children)) {
				if (!part.matches(STAGE_PARTS) || part.hasAttribute('inert')) continue;
				part.setAttribute('inert', '');
				madeInert.add(part);
			}
		};
		const release = () => {
			observer?.disconnect();
			observer = null;
			for (const part of madeInert) part.removeAttribute('inert');
			madeInert.clear();
		};
		const update = (next: boolean) => {
			if (!next) {
				release();
				return;
			}
			apply();
			if (!observer && typeof MutationObserver !== 'undefined') {
				observer = new MutationObserver(apply);
				observer.observe(node, { childList: true });
			}
		};
		update(covered);
		return { update, destroy: release };
	}

	// Focus that was on the covered stage moves into the peek and returns when the scrim clears.
	// Focus stranded on the zone, or inside a panel that leaves the screen, goes back to the stage
	// element it came from or to the panel's stub. Focus the person put anywhere else stays put.
	// Focus inside a pin that gets stowed waits on the panel's stub and goes back to where it was
	// once the pin is in flow again, unless the person has moved it in the meantime.
	let companionZone: HTMLElement | null = null;
	let stageFocusReturn: HTMLElement | null = null;
	let stowedFocus: { target: HTMLElement; parking: Element | null } | null = null;
	let shownPanelId: string = $layoutStore.activeRightTab;
	$: if (zoneOpen) shownPanelId = $layoutStore.activeRightTab;
	let prevStageInert = false;
	let prevZoneOpenForFocus = false;
	let prevInFlowForFocus = false;
	$: guardCompanionFocus(stageInert, zoneOpen, dockPinned, zoneMounted);
	function guardCompanionFocus(inert: boolean, open: boolean, inFlow: boolean, mounted: boolean): void {
		if (typeof document === 'undefined') return;
		const inertChanged = inert !== prevStageInert;
		const openChanged = open !== prevZoneOpenForFocus;
		const wasInFlow = prevInFlowForFocus;
		prevStageInert = inert;
		prevZoneOpenForFocus = open;
		prevInFlowForFocus = inFlow;
		if (!inertChanged && !openChanged) return;
		if (open && openChanged) {
			// Back on screen. A pin back in flow gets the focus it had when it was stowed.
			const kept = stowedFocus;
			stowedFocus = null;
			if (kept && inFlow && !inert) {
				void tick().then(() => {
					const active = document.activeElement;
					const untouched = !active || active === document.body || active === kept.parking;
					if (untouched && kept.target.isConnected && companionZone?.contains(kept.target) && !kept.target.closest('[inert]')) {
						kept.target.focus({ preventScroll: true });
					}
				});
			}
		}
		if (inert) {
			if (!inertChanged) return;
			const active = document.activeElement;
			if (active instanceof HTMLElement && inCoveredStage(active)) {
				stageFocusReturn = active;
				void tick().then(() => companionZone?.focus({ preventScroll: true }));
			}
			return;
		}
		// The scrim cleared (the peek closed or pinned) or the panel left the screen (closed or stowed).
		const opener = stageFocusReturn;
		stageFocusReturn = null;
		const panelId = shownPanelId;
		const current = document.activeElement;
		if (!opener && !(current && companionZone?.contains(current))) return;
		// A pin in flow that was just stowed stays mounted: remember the control that had focus in it.
		const keep = !open && mounted && wasInFlow && current instanceof HTMLElement && current !== companionZone && Boolean(companionZone?.contains(current));
		void tick().then(() => {
			const active = document.activeElement;
			const stranded = !active || active === document.body || active === companionZone || (!open && Boolean(companionZone?.contains(active)));
			if (!stranded) return;
			if (opener?.isConnected && !opener.closest('[inert]')) {
				opener.focus({ preventScroll: true });
			} else {
				document.querySelector<HTMLElement>(`.rail .stub[data-panel-id="${CSS.escape(panelId)}"]`)?.focus({ preventScroll: true });
			}
			if (keep) stowedFocus = { target: current as HTMLElement, parking: document.activeElement };
		});
	}

	// While a pin is stowed, the focus it had is only kept until the person acts somewhere else: a
	// press or focus outside the zone (stage text, the sidebar, the stub) drops it, so the room
	// coming back never pulls focus into the panel out from under them.
	onMount(() => {
		const dropStowedFocus = (event: Event) => {
			if (!stowedFocus) return;
			const target = event.target;
			if (target instanceof Node && companionZone?.contains(target)) return;
			stowedFocus = null;
		};
		document.addEventListener('pointerdown', dropStowedFocus, true);
		document.addEventListener('focusin', dropStowedFocus, true);
		return () => {
			document.removeEventListener('pointerdown', dropStowedFocus, true);
			document.removeEventListener('focusin', dropStowedFocus, true);
		};
	});

	// Escape ends a peek and nothing else: it never unpins (endPeek). Menus and dialogs own it first.
	function handleStagePeekKeydown(event: KeyboardEvent): void {
		if (!dockPeeking || event.key !== 'Escape' || event.defaultPrevented) return;
		if (event.target instanceof Element && event.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
		if (endPeek()) event.preventDefault();
	}

	/** Width from the pointer to the rail edge the panel hangs from, clamped to what fits. */
	function dockWidthAtPointer(clientX: number): number {
		const fromEdge = $layoutStore.stubSide === 'left' ? clientX : window.innerWidth - clientX;
		return Math.min(Math.max(DOCK_MIN_PANEL, dock.max), Math.max(DOCK_MIN_PANEL, Math.round(fromEdge - dockRail)));
	}

	function handleDockSeparatorKeydown(event: KeyboardEvent): void {
		const next = resizeKeyWidth(event.key, dock.width, {
			shift: event.shiftKey,
			towardStage: $layoutStore.stubSide === 'left' ? 'ArrowRight' : 'ArrowLeft',
			max: dock.max
		});
		if (next === null) return;
		event.preventDefault();
		layoutStore.rightPanelWidth.set(next);
	}

	function resetDockWidth(): void {
		layoutStore.rightPanelWidth.set(DOCK_DEFAULT_PANEL);
	}
	function trackZoneOpen(open: boolean) {
		if (open) {
			if (peekClosingTimer) {
				clearTimeout(peekClosingTimer);
				peekClosingTimer = null;
			}
			peekClosing = false;
		} else if (prevZoneOpenForExit) {
			peekClosing = true;
			// Matches the exit animation in main-layout-part1.css (0.75 x --w-dur-3).
			peekClosingTimer = setTimeout(() => {
				peekClosingTimer = null;
				peekClosing = false;
			}, 190);
		}
		prevZoneOpenForExit = open;
	}
	type FriendPresenceSnapshot = {
		status: User['status'];
		username: string;
		isSelf: boolean;
		trackedPersonKey: string;
	};
	let friendPresenceByKey = new Map<string, FriendPresenceSnapshot>();
	let friendPresenceObserverReady = false;
	let friendPresenceObserverServerUrl = '';
	let unsubscribeFriendPresence: (() => void) | null = null;
	
	const { activeTabId } = mobileTabQueue;
	const MODEL_VIEWPORT_TAB_TOKEN = mobileTabQueue.toAddonTabId(MODEL_VIEWPORT_ADDON_ID);
	const READER_TAB_TOKEN = mobileTabQueue.toAddonTabId(READER_ADDON_ID);
	const MAP_TAB_TOKEN = mobileTabQueue.toAddonTabId(MAP_ADDON_ID);
	const MEDIA_ALBUMS_TAB_TOKEN = mobileTabQueue.toAddonTabId(MEDIA_ALBUMS_ADDON_ID);
	const PLANNER_TAB_TOKEN = mobileTabQueue.toAddonTabId(PLANNER_ADDON_ID);
	$: isModelViewportTabActive = $activeTabId === MODEL_VIEWPORT_TAB_TOKEN;
	$: isReaderTabActive = $activeTabId === READER_TAB_TOKEN;
	$: isMapTabActive = $activeTabId === MAP_TAB_TOKEN;
	$: isMediaAlbumsTabActive = $activeTabId === MEDIA_ALBUMS_TAB_TOKEN;
	$: isPlannerTabActive = $activeTabId === PLANNER_TAB_TOKEN;
	const NOTES_TAB_TOKEN = mobileTabQueue.toAddonTabId(NOTES_ADDON_ID);
	$: isNotesTabActive = $activeTabId === NOTES_TAB_TOKEN;

	// Lazy loaders — kick off on first activation (assignment to the let is
	// what makes the template gate re-render).
	$: if (isModelViewportTabActive && !ModelViewportTabCmp) void import('./ModelViewportTab.svelte').then((m) => (ModelViewportTabCmp = m.default));
	$: if (isReaderTabActive && !ReaderTabCmp) void import('./ReaderTab.svelte').then((m) => (ReaderTabCmp = m.default));
	$: if (isMapTabActive && !MapWorkspaceCmp) void import('./MapWorkspace.svelte').then((m) => (MapWorkspaceCmp = m.default));
	$: if (isMediaAlbumsTabActive && !MediaAlbumsTabCmp) void import('./MediaAlbumsTab.svelte').then((m) => (MediaAlbumsTabCmp = m.default));
	$: if (isPlannerTabActive && !PlannerWorkspaceCmp) void import('./business/PlannerWorkspace.svelte').then((m) => (PlannerWorkspaceCmp = m.default));
	$: if (isNotesTabActive && !KeepNotesViewCmp) void import('./KeepNotesView.svelte').then((m) => (KeepNotesViewCmp = m.default));
	$: if ($voiceViewOpen && !VoiceViewCmp) void import('./VoiceView.svelte').then((m) => (VoiceViewCmp = m.default));
	$: if ($centerPanelView === 'admin' && !AdminCenterStageCmp) void import('./AdminCenterStage.svelte').then((m) => (AdminCenterStageCmp = m.default));
	$: if (isGalleryChannel && !GalleryChannelCmp) void import('./GalleryChannel.svelte').then((m) => (GalleryChannelCmp = m.default));
	$: if (showSettings && !SettingsCmp) void import('./Settings.svelte').then((m) => (SettingsCmp = m.default));
	$: if (showCallDebugPanel && !CallDebugPanelCmp) void import('./CallDebugPanel.svelte').then((m) => (CallDebugPanelCmp = m.default));
	// CallModal renders whenever any call surface could be visible.
	// 2026-08-27: joining a CHANNEL call must not throw a translucent modal
	// over the chat. 2026-09-07 (Round 9 view contract): the channel call's
	// EMBEDDED panel lives in this layer too — the sidebar's second click
	// flips channelCallPanelOpen, so channel calls load the modal again
	// (excluding them here is why the second click rendered nothing).
	$: callUiActive = Boolean(
		$callOfflineNotice ||
		$incomingCall ||
			$outgoingCall ||
			$activeGroupCall ||
			$groupCallRingingTargets?.length ||
			$activeCalls?.length ||
			$isInCall ||
			$channelCallPanelOpen
	);
	$: if (callUiActive && !CallModalCmp) void import('./CallModal.svelte').then((m) => (CallModalCmp = m.default));
	$: if (($layoutStore.rightPanelMode !== 'none' || peekClosing || ($layoutStore.isMobile && swipePreviewActive && swipePreviewTarget === 'users')) && !RightPanelCmp) void import('./RightPanel.svelte').then((m) => (RightPanelCmp = m.default));

	// Center stage owns the selected workspace (layout contract): a call that covers the stage
	// (embedded below the masthead, or full window) docks whenever navigation picks what the stage
	// shows, so the stage always shows what the folio or the sidebar now names. CallModal does this
	// for the changes it can see (workspace view, channel, center-stage DM); these are the ones only
	// this layout sees: its own activeView (Server home, the DM hub, the following feed) and choosing
	// the folio word, DMs or Server home that is already current. Navigation docks with a plain
	// close, like the sidebar's text-channel click, not the person's Minimize, so a later remote
	// screen share can still bring the call back (dockCallPanel in $lib/callShell).
	function dockCallForNavigation(): void {
		if (!get(channelCallPanelOpen)) return;
		dockCallPanel('navigation', { close: () => channelCallPanelOpen.set(false) });
	}
	let viewUnderCall = activeView;
	$: if (activeView !== viewUnderCall) {
		viewUnderCall = activeView;
		dockCallForNavigation();
	}

	function handleWorkspaceViewSelect(view: WorkspaceViewKey): void {
		dockCallForNavigation();
		activeView = 'chat';
		// The picker owns the center only; keep docked DM conversations intact.
		layoutStore.closeCenterDm();
		selectWorkspaceView(view);
	}

	workspaceViewSelect.set(handleWorkspaceViewSelect);
	$: workspaceActivityBadge.set(activityBadge);
	onDestroy(() => workspaceViewSelect.set(null));

	async function openFriendConversation(user: User): Promise<void> {
		activityActionError = '';
		const existing = findExistingDmChannel($channels, user);
		if (existing) {
			selectWorkspaceView('messages');
			activeView = 'dm';
			layoutStore.openCenterDm(existing.id, user);
			void joinChannel(existing.id);
			return;
		}
		const result = await createDM(getDmDirectoryKey(user));
		const channelId = result.channelId || (result.ok ? result.channel?.id : null);
		if (!channelId) {
			activityActionError = result.ok === false ? result.error : 'Could not open the conversation.';
			return;
		}
		selectWorkspaceView('messages');
		activeView = 'dm';
		layoutStore.openCenterDm(channelId, user);
		void joinChannel(channelId);
	}

	function openActivityChannel(channelId: string): void {
		activeView = 'chat';
		layoutStore.closeCenterDm();
		selectWorkspaceView('messages');
		currentChannel.set(channelId);
		void joinChannel(channelId);
	}
	const MOBILE_EDGE_SWIPE_MIN_X_PX = 56;
	const MOBILE_EDGE_SWIPE_MAX_Y_PX = 72;
	const MOBILE_EDGE_SWIPE_MAX_MS = 700;
	const SERVER_RAIL_WIDTH = 92;
	$: desktopServerRailVisible =
		!$layoutStore.isMobile &&
		$layoutStore.channelSidebarWidth > 0 &&
		$savedServerRailItems.length > 1 &&
		(!isDesktopTauri() || $desktopServerRailPinned);
	$: desktopServerRailOffset = desktopServerRailVisible ? SERVER_RAIL_WIDTH : 0;
	$: currentChannelData = $channels.find(ch => ch.id === $currentChannel);
	$: isGalleryChannel = currentChannelData?.type === 'gallery';

	layoutStore.isResizingChannel.subscribe(v => resizingChannel = v);
	layoutStore.isResizingRight.subscribe(v => resizingRight = v);
	$: if (!showSettings) {
		requestedSettingsPaymentSurface = null;
		requestedSettingsTab = null;
	}
	$: if (accountSecurityOpenRequest > lastHandledAccountSecurityOpenRequest) {
		lastHandledAccountSecurityOpenRequest = accountSecurityOpenRequest;
		requestedSettingsPasswordChangeRequest = accountSecurityOpenRequest;
		openSettings();
	}

	onMount(() => {
		const openDesktopSettings = (event: Event) => {
			openSettings();
			const tab = (event as CustomEvent<{ tab?: string }>).detail?.tab;
			if (tab === 'profile' || tab === 'audio' || tab === 'addons' || tab === 'admin') requestedSettingsTab = tab;
		};
		const openDesktopServers = () => {
			openServerSwitcher();
			requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.server-switcher-overlay .switcher-close')?.focus());
		};
		window.addEventListener('wabi:open-settings', openDesktopSettings);
		window.addEventListener('wabi:open-server-switcher', openDesktopServers);
		return () => {
			window.removeEventListener('wabi:open-settings', openDesktopSettings);
			window.removeEventListener('wabi:open-server-switcher', openDesktopServers);
		};
	});
	onMount(startRemoteFriendRequestPoller);
	onMount(() => {
		const target = sessionStorage.getItem('wabi.pendingActivityServer');
		if (!target || target !== (normalizeServerUrl(resolveServerUrl().url) || resolveServerUrl().url)) return;
		sessionStorage.removeItem('wabi.pendingActivityServer');
		activeView = 'chat';
		layoutStore.closeCenterDm();
		selectWorkspaceView('notifications');
	});
	function syncMobileSurfaceStack(state: MobileSurfaceState): void {
		const previous = mobileSurfaceStack;
		const next = reconcileMobileSurfaceStack(previous, state);
		if (next === previous) return;
		mobileSurfaceStack = next;

		const nextTop = nextMobileBackSurface(next);
		if (nextTop !== 'root' && !previous.includes(nextTop)) {
			try {
				history.pushState({ wabiMobileSurface: nextTop }, '');
			} catch {
				/* History is best-effort; the in-app stack remains authoritative. */
			}
		}
	}

	$: if ($layoutStore.isMobile) {
		syncMobileSurfaceStack({
			workspaceOpen: $activeWorkspaceView !== 'messages',
			conversationOpen: Boolean($layoutStore.centerDmChannelId),
			youOpen: youPageShown,
			browseOpen: $layoutStore.showMobileChannels,
			rightOverlayOpen: $layoutStore.rightPanelMode !== 'none',
			serverSwitcherOpen: showServerSwitcher,
			settingsOpen: showSettings
		});
	} else if (mobileSurfaceStack.length) {
		mobileSurfaceStack = [];
	}

	function openSettings(paymentSurface: 'connections' | null = null): void {
		requestedSettingsPaymentSurface = paymentSurface;
		requestedSettingsTab = null;
		showSettings = true;
	}

	function openServerSettings(): void {
		requestedSettingsPaymentSurface = null;
		requestedSettingsTab = 'server';
		showSettings = true;
	}

	function openNotificationSettings(): void {
		requestedSettingsPaymentSurface = null;
		requestedSettingsTab = 'notifications';
		showSettings = true;
	}

	/** Settings on one page (the You page's rows), or on its list of pages. */
	function openSettingsPage(page: YouSettingsPage | null): void {
		requestedSettingsPaymentSurface = null;
		requestedSettingsTab = page;
		showSettings = true;
	}

	// ---------------------------------------------------------------- phone root navigation (§8.12)
	// Each destination puts its place on screen and closes what covered the stage. The nav marks
	// the destination from what is actually showing (mobileNavDestination), not from the last tap.
	$: mobileNavActive = mobileNavDestination({
		channelsOpen: $layoutStore.showMobileChannels,
		youOpen: youPageShown,
		settingsOpen: showSettings,
		activeView,
		workspaceView: $activeWorkspaceView,
		conversationOpen: Boolean($layoutStore.centerDmChannelId)
	});
	$: mobileNavCounts = {
		channelsUnread: communityUnread,
		dmsUnread: totalUnreadDMs,
		friendRequests: $friendships.incoming.length,
		activity: activityCount
	};

	function selectMobileDestination(destination: MobileNavDestination): void {
		if (destination === 'chat') openMobileChat();
		// Channels opens the drawer; a second tap closes it again (Back does too).
		else if (destination === 'channels') {
			if ($layoutStore.showMobileChannels) layoutStore.showMobileChannels.set(false);
			else openMobileBrowse();
		}
		else if (destination === 'dms') openMobileMessages();
		else if (destination === 'activity') openMobileActivity();
		else openMobileYou();
	}

	function closeMobileYou(): void {
		mobileYouOpen = false;
	}

	function openMobileChat(): void {
		dockCallForNavigation();
		closeMobileYou();
		layoutStore.showMobileChannels.set(false);
		layoutStore.closeRightPanel();
		activeView = 'chat';
		layoutStore.closeDM();
		selectWorkspaceView('messages');
		mobileSurfaceStack = [];
	}

	function openMobileBrowse(): void {
		// The drawer opens over the stage's root (the channel), so it never returns to You.
		closeMobileYou();
		layoutStore.closeRightPanel();
		layoutStore.showMobileChannels.set(true);
	}

	function selectMessagesHub(closeConversation = false): void {
		dockCallForNavigation();
		// The DM hub is center stage only under the 'messages' view: without this, opening DMs from
		// another workspace (e.g. Calls) marked DMs in the sidebar but left that workspace on stage.
		selectWorkspaceView('messages');
		layoutStore.showMobileChannels.set(false);
		layoutStore.closeRightPanel();
		if (closeConversation) layoutStore.closeCenterDm();
		activeView = 'dm';
		dmHubActiveTab = 'messages';
		messagesOpenRequest = ++hubRequestSequence;
	}

	// Friends is a segment of the DM hub (Conversations | Friends, §8.10); the sidebar's Friends
	// entry and a friend-request toast land here.
	function openFriendsHub(): void {
		dockCallForNavigation();
		selectWorkspaceView('messages');
		layoutStore.showMobileChannels.set(false);
		layoutStore.closeRightPanel();
		layoutStore.closeCenterDm();
		activeView = 'dm';
		dmHubActiveTab = 'friends';
		friendsOpenRequest = ++hubRequestSequence;
	}

	function openMobileMessages(): void {
		closeMobileYou();
		layoutStore.closeDM();
		selectMessagesHub(true);
		// Back from the DM hub returns to Chat (handleMobilePopState's root case).
		try {
			history.pushState({ wabiMobileSheet: 'messages' }, '');
		} catch {
			/* History is best-effort; the nav still reaches every destination. */
		}
	}

	function openMobileActivity(): void {
		dockCallForNavigation();
		closeMobileYou();
		layoutStore.showMobileChannels.set(false);
		layoutStore.closeRightPanel();
		layoutStore.closeCenterDm();
		activeView = 'chat';
		selectWorkspaceView('notifications');
	}

	function openMobileYou(): void {
		layoutStore.showMobileChannels.set(false);
		layoutStore.closeRightPanel();
		youPlace = stagePlace;
		mobileYouOpen = true;
	}

	// The You page covers the stage until the stage is asked for something else: any navigation
	// that changes the place (a channel, a workspace, a DM, Server home) closes it, wherever it
	// came from (a notification, a link, the drawer).
	$: stagePlace = [activeView, $activeWorkspaceView, $currentChannel ?? '', $layoutStore.centerDmChannelId ?? '', $activeTabId ?? ''].join('|');
	let youPlace = '';
	$: if (mobileYouOpen && stagePlace !== youPlace) closeMobileYou();
	$: if (mobileYouOpen && !$layoutStore.isMobile) closeMobileYou();

	function signOutFromYou(): void {
		closeMobileYou();
		dispatch('logout');
	}

	function handleWabiNavigate(event: Event): void {
		const detail = (event as CustomEvent).detail || {};
		if (detail.view === 'chat') {
			activeView = 'chat';
			layoutStore.showMobileChannels.set(false);
			if (detail.preserveRightPanel !== true) layoutStore.closeRightPanel();
			if (typeof detail.channelId === 'string' && detail.channelId) {
				currentChannel.set(detail.channelId);
				void joinChannel(detail.channelId);
			}
			return;
		}
		if (detail.view === 'dm' || detail.view === 'messages') {
			activeView = 'dm';
			layoutStore.showMobileChannels.set(false);
			if (detail.preserveRightPanel !== true) layoutStore.closeRightPanel();
			if (typeof detail.channelId === 'string' && detail.channelId) {
				layoutStore.openCenterDm(detail.channelId, null);
				void joinChannel(detail.channelId);
			}
			return;
		}
		if (detail.view === 'friends') {
			openFriendsHub();
			return;
		}
		if (detail.view === 'settings') openSettings();
		if (detail.view === 'notifications' || detail.view === 'activity') handleWorkspaceViewSelect('notifications');
	}

	function handleMobilePopState(): void {
		if (!$layoutStore.isMobile) return;
		const surface = nextMobileBackSurface(mobileSurfaceStack);

		switch (surface) {
			case 'settings':
				showSettings = false;
				return;
			case 'you':
				closeMobileYou();
				return;
			case 'server-switcher':
				closeServerSwitcher();
				return;
			case 'browse':
				layoutStore.showMobileChannels.set(false);
				return;
			case 'overlay':
				layoutStore.closeRightPanel();
				return;
			case 'conversation':
				layoutStore.closeCenterDm();
				activeView = 'dm';
				return;
			case 'workspace':
				selectWorkspaceView('messages');
				return;
			case 'root':
			default:
				if (activeOfficeTool) {
					selectWorkspaceView('messages');
					if ($currentChannel) mobileTabQueue.setActiveChannel($currentChannel);
					else mobileTabQueue.activeTabId.set(null);
					return;
				}
				if (activeView === 'dm') activeView = 'chat';
		}
	}

	function openServerSwitcher(): void {
		showServerSwitcher = true;
	}

	function openServerHub(): void {
		dockCallForNavigation();
		showServerSwitcher = false;
		serverHubWelcome = false;
		if (activeView !== 'server') serverHubReturnView = activeView;
		activeView = 'server';
	}

	onMount(() => {
		const server = getServerUrl();
		const token = getAuthToken(server);
		if (!token) return;
		const entryView = activeView;
		void fetch(`${server}/api/server-center/reception`, {
			headers: { Authorization: `Bearer ${token}` }, credentials: 'include'
		}).then(async response => {
			if (!response.ok) return;
			const guide = await response.json();
			if (guide.welcomePending && getServerUrl() === server && getAuthToken(server) === token && activeView === entryView) {
				serverHubWelcome = true;
				activeView = 'server';
			}
		}).catch(() => { /* Desk remains manually reachable when offline. */ });
	});

	function completeServerWelcome(): void {
		serverHubWelcome = false;
		const server = getServerUrl();
		const token = getAuthToken(server);
		if (!token) return;
		void fetch(`${server}/api/server-center/reception/complete`, {
			method: 'POST', headers: { Authorization: `Bearer ${token}` }, credentials: 'include'
		}).then(response => {
			if (!response.ok) showToast('Could not save welcome progress. The guide may reappear next time.', 'error');
		}).catch(() => showToast('Could not save welcome progress. The guide may reappear next time.', 'error'));
	}

	function returnFromServerHub(): void {
		serverHubWelcome = false;
		activeView = serverHubReturnView === 'server' ? 'chat' : serverHubReturnView;
	}

	function closeServerSwitcher(): void {
		showServerSwitcher = false;
	}

	onMount(() => {
		unsubscribeFriendshipSync = startFriendshipSync();
		unsubscribeFriendRequestNotices = friendships.subscribe((state) => {
			if (!state.ready) {
				knownIncomingRequestIds = null;
				return;
			}
			const nextIds = new Set(state.incoming.map((request) => request.id));
			if (knownIncomingRequestIds !== null) {
				const newRequests = state.incoming.filter((request) => !knownIncomingRequestIds?.has(request.id));
				if (newRequests.length === 1) {
					const person = newRequests[0];
					showToast(`Friend request from ${person.handle ? `@${person.handle}` : person.username}. Open Friends to respond.`, 'info', 8000);
				} else if (newRequests.length > 1) {
					showToast(`${newRequests.length} new friend requests. Open Friends to respond.`, 'info', 8000);
				}
			}
			knownIncomingRequestIds = nextIds;
		});

		mobileTabQueue.registerAddonTab({
			id: MODEL_VIEWPORT_ADDON_ID,
			label: '3D Viewport',
			shortLabel: '3D View'
		});
		mobileTabQueue.registerAddonTab({
			id: READER_ADDON_ID,
			label: 'Reader',
			shortLabel: 'Read'
		});
		mobileTabQueue.registerAddonTab({
			id: MAP_ADDON_ID,
			label: 'Maps',
			shortLabel: 'Map'
		});
		mobileTabQueue.registerAddonTab({
			id: MEDIA_ALBUMS_ADDON_ID,
			label: 'Media Albums',
			shortLabel: 'Albums'
		});
		mobileTabQueue.registerAddonTab({
			id: PLANNER_ADDON_ID,
			label: 'Planner',
			shortLabel: 'Planner'
		});
		mobileTabQueue.registerAddonTab({
			id: NOTES_ADDON_ID,
			label: 'Notes',
			shortLabel: 'Notes'
		});
		mobileTabQueue.registerAddonTab({ id: NOTIFICATIONS_ADDON_ID, label: 'Activity', shortLabel: 'Activity' });

		// Plugin workspace panels were previously registered from RightPanel's
		// mount; the stub strip never mounts a panel body, so registration
		// lives here (runs on mobile too, where the strip is hidden).
		void fetchPluginInventory().then((plugins) => {
			if (!plugins) return;
			registerPluginWorkspacePanels(plugins);
		});

		// Optional deep-link: #admin opens the full dashboard for staff.
		if (typeof window !== 'undefined') {
			const tryOpenAdmin = () => {
				if (window.location.hash !== '#admin') return;
				const role = get(currentUser)?.highestRole;
				if (role === 'owner' || role === 'admin' || role === 'mod') {
					layoutStore.showAdminCenterStage();
				}
			};
			tryOpenAdmin();
			window.addEventListener('hashchange', tryOpenAdmin);
			// Auth may resolve after mount; retry briefly once the user is known.
			const unsub = currentUser.subscribe(() => {});
			setTimeout(() => {
				tryOpenAdmin();
				unsub();
			}, 1500);
		}

		unsubscribeFriendPresence = users.subscribe((nextUsers) => {
			const serverUrl = getServerUrl();
			if (friendPresenceObserverServerUrl !== serverUrl) {
				friendPresenceObserverServerUrl = serverUrl;
				friendPresenceByKey = new Map();
				friendPresenceObserverReady = false;
			}

			rememberPeople(nextUsers, serverUrl);

			const me = get(currentUser);
			const selfKeys = new Set<string>();
			const selfKey = getPresenceObserverKey(me, serverUrl);
			if (selfKey) selfKeys.add(selfKey);

			const nextSnapshot = new Map<string, FriendPresenceSnapshot>();
			for (const user of nextUsers) {
				const key = getPresenceObserverKey(user, serverUrl);
				if (!key) continue;
				const isSelf = selfKeys.has(key);
				const nextEntry: FriendPresenceSnapshot = {
					status: user.status,
					username: user.username,
					isSelf,
					trackedPersonKey: getTrackedPersonKeyForUser(user, serverUrl)
				};
				nextSnapshot.set(key, nextEntry);

				if (!friendPresenceObserverReady || isSelf) continue;
				const previous = friendPresenceByKey.get(key);
				if (!previous) continue;
				if (previous.status === user.status) continue;
				notifyFriendStatusChange(
					nextEntry.trackedPersonKey,
					user.username,
					previous.status,
					user.status
				);
			}

			if (friendPresenceObserverReady) {
				for (const [key, previous] of friendPresenceByKey.entries()) {
					if (previous.isSelf) continue;
					if (nextSnapshot.has(key)) continue;
					notifyFriendStatusChange(
						previous.trackedPersonKey,
						previous.username,
						previous.status,
						'offline'
					);
				}
			}

			friendPresenceByKey = nextSnapshot;
			friendPresenceObserverReady = true;
		});

		if (typeof window !== 'undefined') {
			window.addEventListener('keydown', handleQuickScratchpadKeydown);
			// Resize drag tracking for channel sidebar + right panel. Without these
			// window-level listeners the handles set the resizing flag but nothing
			// ever tracks the pointer, so neither panel can be dragged or drag-closed.
			window.addEventListener('mousemove', handleMouseMove);
			window.addEventListener('mouseup', stopResize);
			window.addEventListener('wabi:navigate', handleWabiNavigate as EventListener);
			window.addEventListener('popstate', handleMobilePopState);
		}
	});

	onDestroy(() => {
		unsubscribeFriendRequestNotices?.();
		unsubscribeFriendRequestNotices = null;
		unsubscribeFriendshipSync?.();
		unsubscribeFriendshipSync = null;
		mobileTabQueue.unregisterAddonTab(MODEL_VIEWPORT_ADDON_ID);
		mobileTabQueue.unregisterAddonTab(READER_ADDON_ID);
		mobileTabQueue.unregisterAddonTab(MAP_ADDON_ID);
		mobileTabQueue.unregisterAddonTab(MEDIA_ALBUMS_ADDON_ID);
		mobileTabQueue.unregisterAddonTab(PLANNER_ADDON_ID);
		mobileTabQueue.unregisterAddonTab(NOTES_ADDON_ID);
		mobileTabQueue.unregisterAddonTab(NOTIFICATIONS_ADDON_ID);
		if (unsubscribeFriendPresence) {
			unsubscribeFriendPresence();
			unsubscribeFriendPresence = null;
		}
		window.removeEventListener('keydown', handleQuickScratchpadKeydown);
		window.removeEventListener('mousemove', handleMouseMove);
		window.removeEventListener('mouseup', stopResize);
		window.removeEventListener('wabi:navigate', handleWabiNavigate as EventListener);
		window.removeEventListener('popstate', handleMobilePopState);
	});

	function getPresenceObserverKey(user: User | null | undefined, serverUrl: string): string {
		return getServerScopedUserKey(user, serverUrl);
	}

	function shouldNotifyFriendStatus(trackedPersonKey: string): boolean {
		const settings = get(displayEnhancementSettingsStore);
		if (!settings.friendNotificationsEnabled) return false;
		if (settings.friendNotificationsTrackedOnly && !isTrackedPersonStatusAlertsKeyEnabled(trackedPersonKey)) return false;
		if (typeof window === 'undefined') return false;
		if (!('Notification' in window)) return false;
		if (Notification.permission !== 'granted') return false;
		if (localStorage.getItem('notificationsEnabled') === 'false') return false;
		return true;
	}

	// N1: global hotkey Ctrl/Cmd+Shift+N toggles floating QuickScratchpad
	function handleQuickScratchpadKeydown(event: KeyboardEvent): void {
		if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'n') {
			event.preventDefault();
			quickScratchpadOpen.update((v) => !v);
		}
	}

	function formatPresenceStatus(status: User['status'] | 'offline'): string {
		if (status === 'active') return 'Online';
		if (status === 'away') return 'Away';
		if (status === 'busy') return 'Do Not Disturb';
		return 'Offline';
	}

	function notifyFriendStatusChange(
		trackedPersonKey: string,
		username: string,
		previousStatus: User['status'] | 'offline',
		nextStatus: User['status'] | 'offline'
	): void {
		if (!shouldNotifyFriendStatus(trackedPersonKey)) return;
		try {
			playNotificationSound();
			const notification = new Notification(`${username} is now ${formatPresenceStatus(nextStatus)}`, {
				body: `Status changed from ${formatPresenceStatus(previousStatus)}.`
			});
			setTimeout(() => notification.close(), 6000);
		} catch {
			// no-op
		}
	}

	function handleMouseMove(e: MouseEvent) {
		if (resizingChannel) {
			const isRightDock = !$layoutStore.isMobile && $layoutStore.navDock === 'right';
			const width = isRightDock ? window.innerWidth - e.clientX : e.clientX;
			layoutStore.channelSidebarWidth.set(Math.max(0, Math.min(width, window.innerWidth)));
		}
		if (resizingRight) {
			// Measured from the rail edge the panel hangs from (stub-side-aware), and clamped so
			// the stored width is the width you see: 240px up to what leaves the stage 600px.
			layoutStore.rightPanelWidth.set(dockWidthAtPointer(e.clientX));
		}
	}

	function stopResize() {
		if (resizingChannel) {
			const w = get(layoutStore.channelSidebarWidth);
			if (w < 50) layoutStore.channelSidebarWidth.set(0);
		}
		if (resizingRight) {
			// Spec invariant: rightPanelWidth never zeroes (no close-by-drag).
		}
		layoutStore.isResizingChannel.set(false);
		layoutStore.isResizingRight.set(false);
	}

	function startChannelResizeFromClosed(event: MouseEvent) {
		if ($layoutStore.isMobile) return;
		const isRightDock = $layoutStore.navDock === 'right';
		const width = isRightDock ? window.innerWidth - event.clientX : event.clientX;
		layoutStore.channelSidebarWidth.set(Math.max(8, Math.min(width, window.innerWidth)));
		layoutStore.isResizingChannel.set(true);
	}

	function handleLeaveVoiceChannel() {
		const channel = get(activeVoiceChannel);
		if (!channel) return;
		void leaveSocketVoiceChannel(channel.id);
	}

	async function handleToggleVideoFromStrip() {
		await toggleVideo(getSocket() || undefined);
	}

	function handleOpenVoiceWhiteboard(): void {
		const channel = get(activeVoiceChannel);
		if (!channel) return;
		currentChannel.set(channel.id);
		handleWorkspaceViewSelect('whiteboard');
	}

	// Connection trouble in plain words on the phone strip, never the lifecycle enum (§9.4).
	$: stripConnectionWords = connectionWords($connectionState);

	function resetTouchSwipe(): void {
		touchStartX = 0;
		touchStartY = 0;
		touchStartTime = 0;
		touchGestureEnabled = false;
		touchMovedEnough = false;
		swipePreviewActive = false;
		swipePreviewTarget = 'none';
		swipePreviewOffsetX = 0;
	}

	// A gesture can be interrupted by resizing before touchend/touchcancel.
	// Never carry its preview opacity or disabled transition into the desktop dock.
	$: if (!$layoutStore.isMobile) resetTouchSwipe();

	function handleTouchStart(event: TouchEvent): void {
		if (!$layoutStore.isMobile || event.touches.length !== 1) {
			resetTouchSwipe();
			return;
		}

		const target = event.target as HTMLElement | null;
		// Don't hijack gestures inside horizontally-draggable rails or form controls.
		if (
			target?.closest('.tab-rail-viewport') ||
			target?.closest('textarea, input, select, button, a, [contenteditable="true"]')
		) {
			resetTouchSwipe();
			return;
		}

		const touch = event.touches[0];
		touchStartX = touch.clientX;
		touchStartY = touch.clientY;
		touchStartTime = Date.now();
		touchGestureEnabled = true;
		touchMovedEnough = false;
		
		// Check if touch started near left or right edge for panel opening
		const nearLeftEdge = touchStartX <= MOBILE_EDGE_SWIPE_MIN_X_PX;
		const nearRightEdge = touchStartX >= window.innerWidth - MOBILE_EDGE_SWIPE_MIN_X_PX;
		const channelsOpen = $layoutStore.showMobileChannels;
		const usersOpen = $layoutStore.rightPanelMode !== 'none';
		
		// If starting near an edge and no panel is open, prepare for edge swipe
		if (!channelsOpen && !usersOpen && (nearLeftEdge || nearRightEdge)) {
			swipePreviewTarget = nearLeftEdge ? 'channels' : 'users';
			swipePreviewActive = true;
			swipePreviewOffsetX = 0;
		}
	}

	function handleTouchMove(event: TouchEvent): void {
		if (!$layoutStore.isMobile || !touchGestureEnabled || event.touches.length === 0) return;
		const touch = event.touches[0];
		const deltaX = touch.clientX - touchStartX;
		const deltaY = touch.clientY - touchStartY;
		// Ignore taps and tiny jitter.
		if (Math.hypot(deltaX, deltaY) >= 14) {
			touchMovedEnough = true;
		}

		const mostlyHorizontal = Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) >= 18;
		if (!mostlyHorizontal) {
			swipePreviewActive = false;
			swipePreviewTarget = 'none';
			swipePreviewOffsetX = 0;
			return;
		}

		const channelsOpen = $layoutStore.showMobileChannels;
		const usersOpen = $layoutStore.rightPanelMode !== 'none';
		const width = Math.max(window.innerWidth, 1);

		// Edge swipe to OPEN panels (from closed state)
		if (!channelsOpen && !usersOpen && swipePreviewActive && swipePreviewTarget !== 'none') {
			if (swipePreviewTarget === 'channels' && deltaX > 0) {
				// Swiping right from left edge - preview channels panel
				swipePreviewOffsetX = Math.max(0, Math.min(width, deltaX));
				return;
			}
			if (swipePreviewTarget === 'users' && deltaX < 0) {
				// Swiping left from right edge - preview users panel
				swipePreviewOffsetX = Math.max(-width, Math.min(0, deltaX));
				return;
			}
		}

		if (channelsOpen) {
			// Drag left to close channels back to chat.
			swipePreviewTarget = 'channels';
			swipePreviewOffsetX = Math.max(-width, Math.min(0, deltaX));
			swipePreviewActive = true;
			return;
		}

		if (usersOpen) {
			// Drag right to close users back to chat.
			swipePreviewTarget = 'users';
			swipePreviewOffsetX = Math.max(0, Math.min(width, deltaX));
			swipePreviewActive = true;
			return;
		}

		// Opening side panels is edge-only. Central horizontal drags belong to chat content.
	}

	function handleTouchEnd(event: TouchEvent): void {
		if (!$layoutStore.isMobile || !touchGestureEnabled || !touchMovedEnough || event.changedTouches.length === 0) {
			resetTouchSwipe();
			return;
		}

		const touch = event.changedTouches[0];
		const deltaX = touch.clientX - touchStartX;
		const deltaY = touch.clientY - touchStartY;
		const elapsedMs = Date.now() - touchStartTime;
		const horizontalMin = Math.max(96, Math.floor(window.innerWidth * 0.22));
		const isHorizontalSwipe =
			Math.abs(deltaX) >= Math.max(MOBILE_EDGE_SWIPE_MIN_X_PX, horizontalMin) &&
			Math.abs(deltaY) <= MOBILE_EDGE_SWIPE_MAX_Y_PX &&
			Math.abs(deltaX) > Math.abs(deltaY) &&
			elapsedMs <= MOBILE_EDGE_SWIPE_MAX_MS;

		if (!isHorizontalSwipe) {
			resetTouchSwipe();
			return;
		}

		const swipeLeft = deltaX < 0;
		const swipeRight = deltaX > 0;
		const channelsOpen = $layoutStore.showMobileChannels;
		const usersOpen = $layoutStore.rightPanelMode !== 'none';

		// Edge swipe to OPEN panels from closed state
		if (!channelsOpen && !usersOpen) {
			if (swipeRight && swipePreviewTarget === 'channels') {
				// Swiped right from left edge - open channels
				layoutStore.showMobileChannels.set(true);
				layoutStore.closeRightPanel();
				resetTouchSwipe();
				return;
			}
			if (swipeLeft && swipePreviewTarget === 'users') {
				// Swiped left from right edge - open users
				layoutStore.openRightPanel('users');
				layoutStore.showMobileChannels.set(false);
				resetTouchSwipe();
				return;
			}
		}

		// Stage navigation: Channels <-> Chat <-> Users
		if (channelsOpen && swipeLeft) {
			layoutStore.showMobileChannels.set(false);
			layoutStore.closeRightPanel();
			resetTouchSwipe();
			return;
		}

		if (usersOpen && swipeRight) {
			layoutStore.closeRightPanel();
			layoutStore.showMobileChannels.set(false);
			resetTouchSwipe();
			return;
		}

		resetTouchSwipe();
	}

	// Pass panel and gesture state explicitly so Svelte updates these inline
	// styles when a sheet opens, closes, or follows a swipe.
	function getChannelPreviewTransform(mobile: boolean, channelsOpen: boolean, previewActive: boolean, previewTarget: string, offsetX: number): string | undefined {
		if (!mobile) return undefined;
		if (!previewActive || previewTarget !== 'channels') {
			// When channels is open normally (not preview), no transform
			if (channelsOpen) return 'translateX(0)';
			return 'translateX(-100%)';
		}
		if (channelsOpen) {
			// Dragging to close - panel moves left with negative offset
			return `translateX(${offsetX}px)`;
		}
		// Edge swipe to open - panel slides in from left
		return `translateX(calc(-100% + ${Math.max(0, offsetX)}px))`;
	}

	function getUsersPreviewTransform(usersOpen: boolean, previewActive: boolean, previewTarget: string, offsetX: number): string {
		if (!previewActive || previewTarget !== 'users') {
			// When users panel is open normally, no transform
			if (usersOpen) return 'translateX(0)';
			return 'translateX(100%)';
		}
		if (usersOpen) {
			// Dragging to close - panel moves right with positive offset
			return `translateX(${Math.max(0, offsetX)}px)`;
		}
		// Edge swipe to open - panel slides in from right
		return `translateX(calc(100% + ${Math.min(0, offsetX)}px))`;
	}

	function getPreviewOpacity(previewActive: boolean, previewTarget: string, offsetX: number): number {
		if (!previewActive || previewTarget === 'none') return 1;
		const width = Math.max(window.innerWidth, 1);
		const p = Math.min(1, Math.abs(offsetX) / (width * 0.34));
		return 0.35 + (p * 0.65);
	}

	$: activeOfficeTool = workspaceToolFromTab($activeTabId);
</script>

<GlanceHost />

<svelte:window
	bind:innerWidth={viewportWidth}
	on:resize={measureRailWidth}
	on:keydown={handleStagePeekKeydown}
	on:keydown={handleCompactDrawerKeydown}
	on:mousemove={handleMouseMove}
	on:mouseup={stopResize}
	on:touchstart={handleTouchStart}
	on:touchmove={handleTouchMove}
	on:touchend={handleTouchEnd}
	on:touchcancel={resetTouchSwipe}
/>

<AuthErrorBanner />
	<WorkspaceLinkHandler />

{#if $centerPanelView === 'admin'}
	{#if AdminCenterStageCmp}
		<svelte:component this={AdminCenterStageCmp} />
	{:else}
		<div class="lazy-panel-placeholder" aria-busy="true"><span class="w-loadline" role="progressbar" aria-label="Loading"></span></div>
	{/if}
{:else}
{#if mobileNavShown}
	<!-- Root navigation (§8.12): the bottom nav under 600px, a 72px left rail from 600 to 768px. -->
	<MobileNav active={mobileNavActive} counts={mobileNavCounts} onselect={selectMobileDestination} />
{/if}

{#if $layoutStore.isMobile && ($layoutStore.showMobileChannels || $layoutStore.rightPanelMode !== 'none')}
	<!-- The scrim over the stage while a drawer is open; a tap closes it (the drawer's own close
	     button and Back cover the keyboard). -->
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="mobile-panel-backdrop" aria-hidden="true" on:click={() => { layoutStore.showMobileChannels.set(false); layoutStore.closeRightPanel(); }}></div>
{/if}

<div
		class="app-container"
		class:focus-mode={$focusMode}
		class:resizing={$layoutStore.isResizing}
		class:in-call={$layoutStore.isMobile && $layoutStore.isInCall}
		class:mobile-nav-visible={bottomNavShown}
		class:nav-rail={navRailShown}
		class:compact-shell={compactShell}
		class:nav-right={!$layoutStore.isMobile && $layoutStore.navDock === 'right'}
		class:obvious-grab-rails={$layoutStore.obviousGrabRails}
		class:rail-on={!$layoutStore.isMobile && !$focusMode}
		class:dock-pinned={dockPinned}
		class:rail-left={$layoutStore.stubSide === 'left'}
		style:--w-sig={$currentSavedServer?.frontendMetadata?.accentColor || null}
		style:--w-serif={communityDisplayFont($currentSavedServer?.frontendMetadata?.displayFont, $currentTheme?.character)}
		style:--w-dock-w={dockPinned ? `${dock.width}px` : '0px'}
	>
	{#if !$layoutStore.isMobile && $layoutStore.channelSidebarWidth === 0}
		<button
			type="button"
			class="nav-reopen-rail"
			class:dock-right={$layoutStore.navDock === 'right'}
			style:left={$layoutStore.navDock !== 'right'
				? `${desktopServerRailOffset}px`
				: null}
			style:right={$layoutStore.navDock === 'right'
				? `${desktopServerRailOffset}px`
				: null}
			on:click={layoutStore.expandNav}
			on:mousedown|preventDefault={startChannelResizeFromClosed}
			title="Open channel sidebar"
			aria-label="Open channel sidebar"
		>
			<Icon name={$layoutStore.navDock === 'right' ? 'chevLeft' : 'chevRight'} size={14} />
		</button>
	{/if}

	{#if desktopServerRailVisible}
		<div class="server-rail-container">
			<ServerRail on:manage={openServerSwitcher} />
		</div>
	{/if}

	<!-- Channel Sidebar (Left) - Mobile uses overlay -->
	<div
		class="channel-sidebar-container"
		bind:this={sidebarContainer}
		style:width={$layoutStore.isMobile ? null : `${sidebarColumnWidth}px`}
		class:mobile-visible={$layoutStore.showMobileChannels}
		class:compact-drawer={compactDrawerOpen}
		class:preview-visible={$layoutStore.isMobile && swipePreviewActive && swipePreviewTarget === 'channels'}
		class:dock-right={!$layoutStore.isMobile && $layoutStore.navDock === 'right'}
		style:transform={getChannelPreviewTransform($layoutStore.isMobile, $layoutStore.showMobileChannels, swipePreviewActive, swipePreviewTarget, swipePreviewOffsetX)}
		style:opacity={getPreviewOpacity(swipePreviewActive, swipePreviewTarget, swipePreviewOffsetX)}
		style:transition={swipePreviewActive ? 'none' : undefined}
	>
		<ChannelSidebar
			on:close={() => { layoutStore.showMobileChannels.set(false); closeCompactSidebar(false); }}
			on:openMessages={() => selectMessagesHub(true)}
			on:openFriends={openFriendsHub}
			on:openServerSwitcher={openServerSwitcher}
			on:openServerHub={openServerHub}
			bind:activeView
			dmHubTab={dmHubActiveTab}
			friendRequestCount={$friendships.incoming.length}
			on:logout
			on:openSettings={() => openSettings()}
		/>
		<!-- Channel resize handle (not in the compact band: the band owns the column's width there) -->
		{#if !compactShell}
			<button
				type="button"
				class="resize-handle resize-handle-channel"
				aria-label="Resize channel sidebar"
				on:mousedown|preventDefault={() => layoutStore.isResizingChannel.set(true)}
			></button>
		{:else if sidebarColumnWidth > 0}
			<!-- 769–1023px (§8.13): the 60px rail opens the full sidebar over the stage. -->
			<button
				type="button"
				class="compact-sidebar-toggle"
				bind:this={compactToggle}
				aria-expanded={$compactSidebarOpen}
				aria-label={$compactSidebarOpen ? 'Close channel list' : 'Show channel list'}
				title={$compactSidebarOpen ? 'Close channel list' : 'Show channel list'}
				on:click={toggleCompactSidebar}
			><Icon name={$compactSidebarOpen ? 'chevLeft' : 'chevRight'} size={14} /></button>
		{/if}
	</div>

	{#if compactDrawerOpen}
		<!-- Pointer-only affordance: Escape, the toggle and choosing a place cover the keyboard. -->
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div class="compact-scrim" aria-hidden="true" on:click={() => closeCompactSidebar(false)}></div>
	{/if}

	{#if showServerSwitcher}
		<div
			class="server-switcher-overlay"
			class:mobile={$layoutStore.isMobile}
			class:dock-right={!$layoutStore.isMobile && $layoutStore.navDock === 'right'}
			style:width={!$layoutStore.isMobile ? `${desktopServerRailOffset + Math.max($layoutStore.channelSidebarWidth, 320)}px` : null}
		>
			<ServerSwitcherPanel mobile={$layoutStore.isMobile} dockSide={$layoutStore.navDock} on:close={closeServerSwitcher} />
		</div>
	{/if}

	<!-- Right Panel — one mode-driven node for pin and peek, so the panel never remounts when it
	       switches between them. Pinned: in flow beside the stage (.app-container reserves
	       --w-dock-w), clamped so the stage keeps 600px; with no room it is stowed (mounted, hidden
	       and inert) until the room comes back. Peek: floats over the stage's edge; a peek the
	       person asked for has the scrim under it. -->
	{#if !$layoutStore.isMobile}
		{#if scrimVisible}
			<!-- Pointer-only affordance: Escape, the stub and the panel's own close button cover the keyboard. -->
			<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
			<div
				class="stage-scrim"
				class:closing={!stageScrim}
				style:left="{scrimLeft}px"
				style:right="{scrimRight}px"
				aria-hidden="true"
				on:click={() => endPeek()}
			></div>
		{/if}
		{#if zoneMounted || peekClosing}
			<!-- Pointer moving anywhere inside the zone cancels a pending
			     dismissal: stub mouseleave arms it, and the zone's mouseenter
			     will not re-fire for a pointer that never left the zone. -->
			<div
				bind:this={companionZone}
				class="right-panel-zone"
				class:pinned={dockPinned}
				class:peek={zoneFloats}
				class:closing={peekClosing && !zoneOpen}
				class:stowed={zoneHidden}
				class:stub-right={$layoutStore.stubSide === 'right'}
				class:stub-left={$layoutStore.stubSide === 'left'}
				role="complementary"
				aria-label="Side panel"
				tabindex="-1"
				inert={zoneHidden}
				style:width="{dock.width}px"
				style:right={zoneFloats && $layoutStore.stubSide !== 'left' ? `${peekInset}px` : null}
				style:left={zoneFloats && $layoutStore.stubSide === 'left' ? `${peekInset}px` : null}
				use:peekAnimationGate
				on:mouseenter={() => setPeekPointerInside(true)}
				on:mouseleave={() => { setPeekPointerInside(false); armPeekDismiss(); }}
				on:pointermove={cancelPeekDismiss}
			>
				{#if dockPinned}
					<!-- The resize edge straddles the panel's inner hairline, outside the clipped body.
					     A focusable separator is an interactive widget (WAI-ARIA window splitter). -->
					<!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
					<div
						class="resize-handle resize-handle-right"
						class:dragging={resizingRight}
						role="separator"
						tabindex="0"
						aria-orientation="vertical"
						aria-label="Resize side panel"
						aria-controls="companion-panel-body"
						aria-valuenow={dock.width}
						aria-valuemin={DOCK_MIN_PANEL}
						aria-valuemax={Math.max(DOCK_MIN_PANEL, dock.max)}
						on:mousedown|preventDefault={() => layoutStore.isResizingRight.set(true)}
						on:dblclick={resetDockWidth}
						on:keydown={handleDockSeparatorKeydown}
					></div>
				{/if}
				<div class="right-panel-body" id="companion-panel-body">
					{#if RightPanelCmp}
						<svelte:component this={RightPanelCmp} on:openSettings={(event) => openSettings(event.detail?.paymentSurface ?? null)} />
					{:else}
						<!-- First open loads the panel lazily: a real loading state, never a blank sheet (§7.16). -->
						<div class="companion-loading" aria-busy="true">
							<span class="w-loadline" role="progressbar" aria-label="Loading panel"></span>
							<div class="companion-loading-rows" aria-hidden="true">
								{#each [0, 1, 2, 3, 4] as row (row)}
									<div class="w-skel-row"><span class="w-skel w-skel--disc"></span><span class="w-skel-stack"><span class="w-skel"></span><span class="w-skel"></span></span></div>
								{/each}
							</div>
						</div>
					{/if}
				</div>
			</div>
		{/if}
		<RightStubStrip />
	{:else}
		<!-- Mobile Right Panel Overlay -->
		<div
			class="mobile-right-overlay"
			class:visible={$layoutStore.rightPanelMode !== 'none'}
			class:preview-visible={$layoutStore.isMobile && swipePreviewActive && swipePreviewTarget === 'users'}
			style:transform={getUsersPreviewTransform($layoutStore.rightPanelMode !== 'none', swipePreviewActive, swipePreviewTarget, swipePreviewOffsetX)}
			style:opacity={getPreviewOpacity(swipePreviewActive, swipePreviewTarget, swipePreviewOffsetX)}
			style:transition={swipePreviewActive ? 'none' : undefined}
		>
			{#if RightPanelCmp}
				<svelte:component this={RightPanelCmp} on:openSettings={(event) => openSettings(event.detail?.paymentSurface ?? null)} />
			{/if}
		</div>
	{/if}

	<!-- Main Content. Under a held peek's scrim the stage parts (masthead, surface, voice strip)
	     are inert (coverStage); they stay direct children of .chat-stack. The embedded call and the
	     call foot that CallModal renders below them are inert with the stage too (its
	     followStageInert); the incoming and outgoing call dialogs sit above the scrim and stay live.
	     The masthead (StageBar, §7.23 / §8.2) is mounted once above every center-stage workspace,
	     so switching workspaces never moves or unmounts the folio. Server home and the DM hub have
	     their own headers. -->
	<div class="main-content">
		<div class="chat-stack" bind:this={chatStack} use:coverStage={stageInert || compactDrawerOpen}>
			{#if !youPageShown && activeView !== 'server' && ((!$layoutStore.centerDmChannelId && activeView !== 'dm' && activeView !== 'following') || $activeWorkspaceView !== 'messages')}
				<StageBar {activityBadge} onSelectView={handleWorkspaceViewSelect} />
			{/if}
			<div class="chat-surface">
				{#if youPageShown}
					<YouPage onopensettings={openSettingsPage} onopenservers={openServerSwitcher} onsignout={signOutFromYou} />
				{:else if activeView === 'server'}
					<ServerHub on:profileSettings={() => showSettings = true} welcome={serverHubWelcome} on:complete={completeServerWelcome} on:back={returnFromServerHub} on:browse={() => { serverHubWelcome = false; selectWorkspaceView('messages'); activeView = 'chat'; }} on:openRoom={() => { serverHubWelcome = false; selectWorkspaceView('messages'); activeView = 'chat'; }} on:messages={() => { serverHubWelcome = false; selectWorkspaceView('messages'); activeView = 'dm'; }} on:members={() => layoutStore.openRightPanel('users')} on:settings={openServerSettings} on:manage={() => layoutStore.showAdminCenterStage()} />
				{:else if activeOfficeTool}
					<WorkspaceHost tool={activeOfficeTool} />
				{:else if isModelViewportTabActive}
					{#if ModelViewportTabCmp}
						<svelte:component this={ModelViewportTabCmp} />
					{:else}
						<div class="lazy-panel-placeholder" aria-busy="true"><span class="w-loadline" role="progressbar" aria-label="Loading"></span></div>
					{/if}
				{:else if isReaderTabActive}
					{#if ReaderTabCmp}
						<svelte:component this={ReaderTabCmp} />
					{:else}
						<div class="lazy-panel-placeholder" aria-busy="true"><span class="w-loadline" role="progressbar" aria-label="Loading"></span></div>
					{/if}
				{:else if isMediaAlbumsTabActive}
					{#if MediaAlbumsTabCmp}
						<svelte:component this={MediaAlbumsTabCmp} variant="full" />
					{:else}
						<div class="lazy-panel-placeholder" aria-busy="true"><span class="w-loadline" role="progressbar" aria-label="Loading"></span></div>
					{/if}
				{:else if isMapTabActive}
					{#if MapWorkspaceCmp}
						<svelte:component this={MapWorkspaceCmp} variant="full" />
					{:else}
						<div class="lazy-panel-placeholder" aria-busy="true"><span class="w-loadline" role="progressbar" aria-label="Loading"></span></div>
					{/if}
				{:else if isPlannerTabActive}
					{#if PlannerWorkspaceCmp}
						<svelte:component this={PlannerWorkspaceCmp} variant="full" />
					{:else}
						<div class="lazy-panel-placeholder" aria-busy="true"><span class="w-loadline" role="progressbar" aria-label="Loading"></span></div>
					{/if}
				{:else if isNotesTabActive}
					{#if KeepNotesViewCmp}
						<svelte:component this={KeepNotesViewCmp} />
					{:else}
						<div class="lazy-panel-placeholder" aria-busy="true"><span class="w-loadline" role="progressbar" aria-label="Loading"></span></div>
					{/if}
				{:else if $activeWorkspaceView === 'lore'}
					{#await import('./ProjectWorkspace.svelte')}
						<div class="lazy-panel-placeholder" role="status">Loading Project…</div>
					{:then module}
						<svelte:component this={module.default} />
					{:catch}
						<p role="alert">Couldn't load Project. Try reloading Wabi.</p>
					{/await}
				{:else if $activeWorkspaceView === 'files'}
					{#await import('./FilesWorkspace.svelte')}
						<div class="lazy-panel-placeholder" role="status">Loading Files…</div>
					{:then module}
						<svelte:component this={module.default} />
					{:catch}
						<p role="alert">Couldn't load Files. Try reloading Wabi.</p>
					{/await}
				{:else if $activeWorkspaceView === 'voice'}
					{#if VoiceViewCmp}
						<svelte:component this={VoiceViewCmp} />
					{:else}
						<div class="lazy-panel-placeholder" aria-busy="true"><span class="w-loadline" role="progressbar" aria-label="Loading"></span></div>
					{/if}
				{:else if $activeWorkspaceView === 'notifications'}
					<NotificationsCenter error={activityActionError} on:openDm={(event) => { selectWorkspaceView('messages'); activeView = 'dm'; layoutStore.openCenterDm(event.detail.channelId, null); void joinChannel(event.detail.channelId); }}
						on:message={(event) => { void openFriendConversation(event.detail); }}
						on:openChannel={(event) => openActivityChannel(event.detail.channelId)}
						on:settings={openNotificationSettings} />
				{:else if ($layoutStore.centerDmChannelId || activeView === 'dm') && $activeWorkspaceView !== 'whiteboard'}
					<div class="center-dm-layout" class:friends-directory={dmHubActiveTab === 'friends' && !$layoutStore.centerDmChannelId}>
						<div class="center-dm-list">
							<DmHub {friendsOpenRequest} {messagesOpenRequest} on:serverHome={openServerHub} on:tabChange={(event) => (dmHubActiveTab = event.detail.tab)} />
						</div>
						<div class="center-dm-thread">
							{#if $layoutStore.centerDmChannelId}
								<DmConversationView context="center" channelIdProp={$layoutStore.centerDmChannelId} otherUserProp={$centerDmOtherUser} channelProp={$centerGroupChannel} />
							{:else}
								<div class="center-dm-empty">
									<Icon name="dm" size={28} />
									<span>Select a conversation</span>
								</div>
							{/if}
						</div>
					</div>
				{:else if activeView === 'following' && $activeWorkspaceView !== 'whiteboard'}
					<FollowingFeed on:openChannel={() => (activeView = 'chat')} />
				{:else if isGalleryChannel && $activeWorkspaceView !== 'whiteboard'}
					{#if GalleryChannelCmp}
						<svelte:component this={GalleryChannelCmp} />
					{:else}
						<div class="lazy-panel-placeholder" aria-busy="true"><span class="w-loadline" role="progressbar" aria-label="Loading"></span></div>
					{/if}
				{:else}
					<Chat
						on:logout
						on:openSettings={(event) => openSettings(event.detail?.paymentSurface ?? null)}
					/>
				{/if}
			</div>
			<VoiceLiveStrip />
			{#if CallModalCmp}
				<svelte:component this={CallModalCmp} />
			{:else if callUiActive}
				<div class="lazy-panel-placeholder" aria-busy="true"><span class="w-loadline" role="progressbar" aria-label="Loading"></span></div>
			{/if}
		</div>
	</div>

	<!-- Floating sub-window layer inside the app webview. This is the Odysseus-style panel system for Tauri/browser. -->
	<FloatingPanelHost />
	<CommunityRulesNotice autoOpen={!serverHubWelcome} />

	{#if callDebugPanelEnabled && (callUiActive || showCallDebugPanel)}
		<button
			type="button"
			class="call-debug-toggle"
			class:active={showCallDebugPanel}
			on:click={() => (showCallDebugPanel = !showCallDebugPanel)}
			title="Toggle calling diagnostics"
			aria-label="Toggle calling diagnostics"
			aria-expanded={showCallDebugPanel}
		>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
			</svg>
		</button>
		{#if showCallDebugPanel}
			<div class="call-debug-overlay">
				{#if CallDebugPanelCmp}
					<svelte:component this={CallDebugPanelCmp} open title="Calling Debug" />
				{:else}
					<div class="lazy-panel-placeholder" aria-busy="true"><span class="w-loadline" role="progressbar" aria-label="Loading"></span></div>
				{/if}
				<button
					type="button"
					class="call-debug-close"
					on:click={() => (showCallDebugPanel = false)}
					aria-label="Close calling diagnostics"
					title="Close calling diagnostics"
				><Icon name="x" size={14} /></button>
			</div>
		{/if}
	{/if}

	<!-- The phone channel-call strip, while the room is minimized. When the call is open in the
	     stage its dock is the only action bar (§8.12), so the strip steps aside. Connection details
	     live on the Calls page (§8.5), not in a toggle on this header (§9.4). -->
	{#if $layoutStore.isMobile && $callMode === 'channel' && $activeVoiceChannel && !$channelCallPanelOpen}
		<div class="voice-channel-strip" role="group" aria-label={$_('shell.call.voice_connected')} use:cornerBar transition:fly={{ y: 8, duration: 180 }}>
			<span class="voice-strip__dot" aria-hidden="true"></span>
			<!-- The words are the live region; the keys beside them are not re-announced. -->
			<span class="voice-strip__text" role="status" aria-live="polite">
				<strong class="voice-strip__room"><span class="sr-only">{$_('shell.call.in_voice')} </span>{$activeVoiceChannel.name}</strong>
				<small class="voice-strip__state">{stripConnectionWords || $_('shell.call.voice_connected')}</small>
			</span>
			<div class="voice-channel-actions">
				<button type="button" class="w-ibtn" on:click={handleOpenVoiceWhiteboard} title="Open whiteboard for this voice channel" aria-label="Open whiteboard for this voice channel">
					<Icon name="whiteboard" size={20} />
				</button>
				<button type="button" class="w-ibtn" aria-pressed={!$isVideoOff} on:click={handleToggleVideoFromStrip} title={$isVideoOff ? $_('shell.call.turn_on_camera') : $_('shell.call.turn_off_camera')} aria-label={$isVideoOff ? $_('shell.call.turn_on_camera') : $_('shell.call.turn_off_camera')}>
					<Icon name={$isVideoOff ? 'videoOff' : 'video'} size={20} />
				</button>
				<button type="button" class="w-ibtn leave" on:click={handleLeaveVoiceChannel} title={$_('shell.call.leave_voice')} aria-label={$_('shell.call.leave_voice')}>
					<Icon name="phoneOff" size={20} />
				</button>
			</div>
		</div>
	{/if}


</div>

{#if showSettings}
	{#if SettingsCmp}
		<svelte:component
			this={SettingsCmp}
			bind:isOpen={showSettings}
			requestedPaymentSurface={requestedSettingsPaymentSurface}
			requestedTab={requestedSettingsTab as SettingsRequest | null}
			requestedPasswordChangeRequest={requestedSettingsPasswordChangeRequest}
			on:logout
		/>
	{:else}
		<div class="lazy-panel-placeholder" aria-busy="true"><span class="w-loadline" role="progressbar" aria-label="Loading"></span></div>
	{/if}
{/if}
{/if}

<InstallAppBanner />

<!-- N1: floating QuickScratchpad overlay -->
{#if showQuickScratchpad}
	<div
		class="quick-scratchpad-overlay"
		on:click|self={closeQuickScratchpad}
		on:keydown|self={(e) => {
			if ((e as KeyboardEvent).key === 'Escape') closeQuickScratchpad();
		}}
		role="dialog"
		aria-modal="true"
		aria-label="Scratchpad"
		tabindex="-1"
	>
		<QuickScratchpad />
	</div>
{/if}

<GamesHost />

<style>
	/* A lazily loaded surface (Phase 4 boot optimization) while its chunk arrives: the kit load
	   line where the surface will be (§7.16), never a shimmering box. */
	.lazy-panel-placeholder {
		height: 100%;
		min-height: 8rem;
		color: var(--w-faint);
		font: var(--w-t-small);
	}

	.center-dm-layout {
		display: flex;
		container: center-dm / inline-size;
		height: 100%;
		min-height: 0;
		overflow: hidden;
	}
	.center-dm-layout.friends-directory {
		grid-template-columns: minmax(0, 1fr);
	}
	.center-dm-layout.friends-directory .center-dm-thread {
		display: none;
	}
	.center-dm-layout.friends-directory .center-dm-list {
		border-right: 0;
	}

	.center-dm-list {
		flex: 0 0 300px;
		min-width: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		border-right: var(--w-bw) solid var(--w-line);
	}

	.center-dm-thread {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.center-dm-empty {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		color: var(--w-faint);
		font: var(--w-t-ui);
	}

	/* Docked panels reduce available space independently of the viewport. */
	@container center-dm (max-width: 720px) {
		.center-dm-list {
			flex-basis: 100%;
			border-right: 0;
		}
		.center-dm-list:has(+ .center-dm-thread :global(.dm-conversation)),
		.center-dm-thread:not(:has(:global(.dm-conversation))) {
			display: none;
		}
	}

	/* N1: floating QuickScratchpad overlay */
	.quick-scratchpad-overlay {
		position: fixed;
		inset: 0;
		z-index: var(--z-modal, 1500);
		display: flex;
		align-items: flex-end;
		justify-content: flex-end;
		padding: 16px;
		background: var(--w-scrim);
	}

	.quick-scratchpad-overlay > :global(*) {
		width: min(420px, 92vw);
		max-height: min(380px, 72dvh);
		border-radius: var(--radius-lg);
		overflow: hidden;
		box-shadow: var(--w-shadow);
	}

	/* Dev-only calling-diagnostics overlay (callDebugPanelEnabled = import.meta.env.DEV). */
	.call-debug-toggle {
		position: fixed;
		left: 8px;
		bottom: 8px;
		z-index: var(--z-sticky, 100);
		width: 32px;
		height: 32px;
		border-radius: var(--radius-md);
		border: var(--w-bw) solid var(--w-line);
		background: var(--w-bg2);
		color: var(--w-mute);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		transition: background-color var(--w-dur-1) var(--w-ease), color var(--w-dur-1) var(--w-ease), opacity var(--w-dur-1) var(--w-ease);
		opacity: 0.5;
	}

	.call-debug-toggle:hover,
	.call-debug-toggle.active {
		opacity: 1;
		background: var(--w-raise);
		color: var(--w-text);
		border-color: var(--w-line-strong);
	}

	.call-debug-overlay {
		position: fixed;
		left: 8px;
		bottom: 48px;
		z-index: var(--z-sticky, 100);
	}

	.call-debug-overlay > :global(.call-debug-panel) {
		max-height: min(70dvh, 480px);
		overflow: auto;
	}

	.call-debug-close {
		position: absolute;
		top: 6px;
		right: 6px;
		width: 24px;
		height: 24px;
		padding: 0;
		border-radius: var(--radius-inner);
		border: var(--w-bw) solid var(--w-line);
		background: var(--w-bg2);
		color: var(--w-mute);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.call-debug-close:hover {
		background: var(--w-raise);
		color: var(--w-text);
	}

	.call-debug-toggle:focus-visible,
	.call-debug-close:focus-visible {
		outline: 2px solid var(--w-accent);
		outline-offset: 2px;
	}

	@media (max-width: 768px) {
		.call-debug-toggle {
			bottom: calc(var(--mobile-nav-height, 56px) + 8px);
		}

		.call-debug-overlay {
			bottom: calc(var(--mobile-nav-height, 56px) + 48px);
		}
	}

</style>
