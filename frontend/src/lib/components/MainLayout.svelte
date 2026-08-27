<!-- frontend/src/lib/components/MainLayout.svelte -->
<script lang="ts">
	import { fly } from 'svelte/transition';
	import { layoutStore } from '$lib/layoutStore';
	import { get } from 'svelte/store';
	import { centerPanelView, dmOtherUser, focusMode } from '$lib/layoutStoreStates';
	import { armPeekDismiss, cancelPeekDismiss } from '$lib/rightPeekGestures';
	import { registerPluginWorkspacePanels } from '$lib/workspacePanels';
	import { fetchPluginInventory } from '$lib/addonInventory';
	import Chat from '$lib/components/Chat.svelte';
import DmConversationView from '$lib/components/DmConversationView.svelte';
import DmHub from '$lib/components/DmHub.svelte';
	import ChannelSidebar from '$lib/components/ChannelSidebar.svelte';
	import FloatingPanelHost from '$lib/components/windowing/FloatingPanelHost.svelte';
	import ServerRail from '$lib/components/ServerRail.svelte';
	import ServerSwitcherPanel from '$lib/components/ServerSwitcherPanel.svelte';
	import FollowingFeed from '$lib/components/FollowingFeed.svelte';
	import RightPanel from '$lib/components/RightPanel.svelte';
	import RightStubStrip from '$lib/components/RightStubStrip.svelte';
	import VoiceLiveStrip from '$lib/components/VoiceLiveStrip.svelte';
	import { voiceViewOpen, openVoiceView } from '$lib/voiceView';
	import AuthErrorBanner from '$lib/components/AuthErrorBanner.svelte';
	import { channelMessages, channelUnreadCounts, channels, currentChannel, currentUser, users, getSocket, leaveVoiceChannel as leaveSocketVoiceChannel, joinChannel, type Channel, type User } from '$lib/socket';
	import { activeCalls, activeVoiceChannel, callConnectionDiagnostics, callMode, callTransportState, connectionState, incomingCall, outgoingCall, isInCall, activeGroupCall, groupCallRingingTargets, isVideoOff, toggleVideo } from '$lib/calling';
	import { mobileTabQueue } from '$lib/mobileTabQueue';
	import { onDestroy, onMount } from 'svelte';
import { _ } from '$lib/i18n';
import { displayEnhancementSettingsStore } from '$lib/displayEnhancements';
	import { playNotificationSound } from '$lib/notifications';
	import { MAP_ADDON_ID } from '$lib/mapWorkspace';
	import { MODEL_VIEWPORT_ADDON_ID } from '$lib/modelViewportTab';
	import { READER_ADDON_ID } from '$lib/readerWorkspace';
	import { MEDIA_ALBUMS_ADDON_ID } from '$lib/mediaAlbumsWorkspace';
	import { PLANNER_ADDON_ID } from '$lib/plannerWorkspace';
	import { NOTES_ADDON_ID } from '$lib/notesWorkspace';
	import WorkspaceViewBar from '$lib/components/WorkspaceViewBar.svelte';
	import {
		getServerScopedUserKey,
		getTrackedPersonKeyForUser,
		isTrackedPersonStatusAlertsKeyEnabled,
		rememberPeople
	} from '$lib/peopleTracker';
	import { getServerUrl } from '$lib/serverUrl';
	import { openWhiteboardSurface } from '$lib/whiteboard/whiteboardSurface';
	import { savedServerRailItems } from '$lib/savedServers';
	// N1: floating QuickScratchpad
	import { quickScratchpadOpen, closeQuickScratchpad } from '$lib/notesStore';
	import QuickScratchpad from '$lib/components/QuickScratchpad.svelte';
	import InstallAppBanner from '$lib/components/pwa/InstallAppBanner.svelte';

	// Phase 4 boot optimization: non-first-paint surfaces load on first
	// activation. Only .svelte components go lazy; utility-module imports
	// above (stores, constants, openWhiteboardSurface) stay static.
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

	export let activeView: 'chat' | 'business' | 'screen' | 'following' | 'dm' = 'chat';
	export let accountSecurityOpenRequest = 0;
	let showSettings = false;
	let requestedSettingsPaymentSurface: 'connections' | null = null;
	let requestedSettingsPasswordChangeRequest = 0;
	let lastHandledAccountSecurityOpenRequest = 0;
	// N1: overlay reactive
	$: showQuickScratchpad = $quickScratchpadOpen;

	$: totalUnreadDMs = 0; // DM-strip: was Object.entries($channelUnreadCounts) for DM channels. Stubbed to 0.

	let resizingChannel = false;
	let resizingRight = false;
	let showVoiceDebugDetails = false;
	let showCallDebugPanel = false;
	// Dev-only gate: the floating calling-diagnostics overlay must never ship to regular users.
	// 2026-08-27: the diagnostics overlay was DEV-only, so real users could
	// never see ping/loss/bitrate during field tests. Always compiled in; the
	// floating toggle only MOUNTS while a call surface is active.
	const callDebugPanelEnabled = true;
	let showServerSwitcher = false;
	let mobileNavVisible = false;
	let mobileNavIdleTimer: ReturnType<typeof setTimeout> | null = null;
	let navTouchStartY = 0;
	let navTouchDragging = false;
	let touchStartX = 0;
	let touchStartY = 0;
	let touchStartTime = 0;
	let touchGestureEnabled = false;
	let touchMovedEnough = false;
	let swipePreviewActive = false;
	let swipePreviewTarget: 'none' | 'channels' | 'users' = 'none';
	let swipePreviewOffsetX = 0;
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
	$: callUiActive = Boolean($incomingCall || $outgoingCall || $isInCall || $activeGroupCall || $groupCallRingingTargets?.length || $activeCalls?.length);
	$: if (callUiActive && !CallModalCmp) void import('./CallModal.svelte').then((m) => (CallModalCmp = m.default));

	$: workspaceActiveView = (() => {
		if (isModelViewportTabActive) return 'model' as const;
		if (isReaderTabActive) return 'reader' as const;
		if (isMediaAlbumsTabActive) return 'media' as const;
		if (isMapTabActive) return 'map' as const;
		if (isPlannerTabActive) return 'planner' as const;
		if (isNotesTabActive) return 'notes' as const;
		if ($voiceViewOpen) return 'voice' as const;
		return 'messages' as const;
	})();

	function closeAllAddonTabs(): void {
		mobileTabQueue.closeAddonTab(READER_ADDON_ID);
		mobileTabQueue.closeAddonTab(MODEL_VIEWPORT_ADDON_ID);
		mobileTabQueue.closeAddonTab(MAP_ADDON_ID);
		mobileTabQueue.closeAddonTab(MEDIA_ALBUMS_ADDON_ID);
		mobileTabQueue.closeAddonTab(PLANNER_ADDON_ID);
		mobileTabQueue.closeAddonTab(NOTES_ADDON_ID);
	}

	function handleWorkspaceViewSelect(view: string): void {
		switch (view) {
			case 'messages':
			case 'whiteboard':
				closeAllAddonTabs();
				voiceViewOpen.set(false);
				break;
			case 'voice':
				openVoiceView();
				break;
			case 'reader':
				mobileTabQueue.openAddonTab(READER_ADDON_ID);
				break;
			case 'model':
				mobileTabQueue.openAddonTab(MODEL_VIEWPORT_ADDON_ID);
				break;
			case 'map':
				mobileTabQueue.openAddonTab(MAP_ADDON_ID);
				break;
			case 'media':
				mobileTabQueue.openAddonTab(MEDIA_ALBUMS_ADDON_ID);
				break;
			case 'planner':
				mobileTabQueue.openAddonTab(PLANNER_ADDON_ID);
				break;
			case 'notes':
				mobileTabQueue.openAddonTab(NOTES_ADDON_ID);
				break;
		}
	}
	const MOBILE_EDGE_SWIPE_MIN_X_PX = 56;
	const MOBILE_EDGE_SWIPE_MAX_Y_PX = 72;
	const MOBILE_EDGE_SWIPE_MAX_MS = 700;
	const MOBILE_NAV_REVEAL_ZONE_PX = 88;
	const MOBILE_NAV_SWIPE_MIN_Y_PX = 46;
	const MOBILE_NAV_IDLE_HIDE_MS = 2200;
	const MOBILE_NAV_PULL_DOWN_HIDE_PX = 26;
	const SERVER_RAIL_WIDTH = 92;
	$: desktopServerRailVisible =
		!$layoutStore.isMobile &&
		$layoutStore.channelSidebarWidth > 0 &&
		$savedServerRailItems.length > 1;
	$: desktopServerRailOffset = desktopServerRailVisible ? SERVER_RAIL_WIDTH : 0;
	$: currentChannelData = $channels.find(ch => ch.id === $currentChannel);
	$: isGalleryChannel = currentChannelData?.type === 'gallery';

	layoutStore.isResizingChannel.subscribe(v => resizingChannel = v);
	layoutStore.isResizingRight.subscribe(v => resizingRight = v);
	$: if (!showSettings) {
		requestedSettingsPaymentSurface = null;
	}
	$: if (accountSecurityOpenRequest > lastHandledAccountSecurityOpenRequest) {
		lastHandledAccountSecurityOpenRequest = accountSecurityOpenRequest;
		requestedSettingsPasswordChangeRequest = accountSecurityOpenRequest;
		openSettings();
	}

	function openSettings(paymentSurface: 'connections' | null = null): void {
		requestedSettingsPaymentSurface = paymentSurface;
		showSettings = true;
	}

	function openMobileChat(): void {
		layoutStore.showMobileChannels.set(false);
		layoutStore.closeRightPanel();
		activeView = 'chat';
		layoutStore.closeDM();
		scheduleMobileNavIdleHide();
	}

	function openMobileBrowse(): void {
		layoutStore.closeRightPanel();
		layoutStore.showMobileChannels.set(true);
		try {
			history.pushState({ wabiMobileSheet: 'browse' }, '');
		} catch {
			/* ignore */
		}
		scheduleMobileNavIdleHide();
	}

	function openMobileMessages(): void {
		layoutStore.showMobileChannels.set(false);
		layoutStore.closeRightPanel();
		layoutStore.closeDM();
		activeView = 'dm';
		try {
			history.pushState({ wabiMobileSheet: 'messages' }, '');
		} catch {
			/* ignore */
		}
		scheduleMobileNavIdleHide();
	}

	function openMobileYou(): void {
		layoutStore.showMobileChannels.set(false);
		layoutStore.closeRightPanel();
		openSettings();
		try {
			history.pushState({ wabiMobileSheet: 'you' }, '');
		} catch {
			/* ignore */
		}
		scheduleMobileNavIdleHide();
	}

	function handleWabiNavigate(event: Event): void {
		const detail = (event as CustomEvent).detail || {};
		if (detail.view === 'chat') {
			activeView = 'chat';
			layoutStore.showMobileChannels.set(false);
			layoutStore.closeRightPanel();
			if (typeof detail.channelId === 'string' && detail.channelId) {
				currentChannel.set(detail.channelId);
				void joinChannel(detail.channelId);
			}
			return;
		}
		if (detail.view === 'dm' || detail.view === 'messages') {
			activeView = 'dm';
			layoutStore.showMobileChannels.set(false);
			layoutStore.closeRightPanel();
			if (typeof detail.channelId === 'string' && detail.channelId) {
				layoutStore.openCenterDm(detail.channelId, null);
				void joinChannel(detail.channelId);
			}
			return;
		}
		if (detail.view === 'settings') openSettings();
	}

	function handleMobilePopState(): void {
		if (!$layoutStore.isMobile) return;
		if (showSettings) {
			showSettings = false;
			return;
		}
		if ($layoutStore.showMobileChannels) {
			layoutStore.showMobileChannels.set(false);
			return;
		}
		if ($layoutStore.rightPanelMode !== 'none') {
			layoutStore.closeRightPanel();
			return;
		}
		if (activeView === 'dm') activeView = 'chat';
	}

	function openServerSwitcher(): void {
		showServerSwitcher = true;
	}

	function closeServerSwitcher(): void {
		showServerSwitcher = false;
	}

	onMount(() => {
		// P3: on mobile the bottom nav starts visible, then auto-hides after
		// the idle timeout and reappears on interaction (grabber, swipe, touch).
		if ($layoutStore.isMobile && !$layoutStore.isInCall) {
			mobileNavVisible = true;
			scheduleMobileNavIdleHide();
		}

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
		mobileTabQueue.unregisterAddonTab(MODEL_VIEWPORT_ADDON_ID);
		mobileTabQueue.unregisterAddonTab(READER_ADDON_ID);
		mobileTabQueue.unregisterAddonTab(MAP_ADDON_ID);
		mobileTabQueue.unregisterAddonTab(MEDIA_ALBUMS_ADDON_ID);
		mobileTabQueue.unregisterAddonTab(PLANNER_ADDON_ID);
		mobileTabQueue.unregisterAddonTab(NOTES_ADDON_ID);
		if (mobileNavIdleTimer) {
			clearTimeout(mobileNavIdleTimer);
			mobileNavIdleTimer = null;
		}
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
			// Measure from the viewport edge the strip sits on (spec: stub-side-aware).
			const onLeft = $layoutStore.stubSide === 'left';
			const newWidth = onLeft ? e.clientX : window.innerWidth - e.clientX;
			layoutStore.rightPanelWidth.set(Math.max(0, newWidth));
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

	function getLastMessageTimestamp(channelId: string): number {
		const messages = $channelMessages[channelId] || [];
		return messages.length > 0 ? messages[messages.length - 1].timestamp : 0;
	}

	function getChannelOtherUser(channel: Channel): User | null {
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

	function openUnreadDM(channel: Channel) {
		if (channel.type === 'group') {
			layoutStore.openGroupDM(channel.id, channel);
		} else {
			const other = getChannelOtherUser(channel);
			if (other) {
				layoutStore.openDM(channel.id, other);
			}
		}
		joinChannel(channel.id);
	}

	function formatUnreadBadge(count: number): string {
		if (count > 99) return '99+';
		return `${count}`;
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
		openWhiteboardSurface(channel.id);
		activeView = 'chat';
	}

	function formatDiag(value: number | null, unit = ''): string {
		if (value == null || Number.isNaN(value)) return '--';
		return `${value}${unit}`;
	}

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
			swipePreviewOffsetX = nearLeftEdge ? 0 : 0;
		}

		// P3: reappear on interaction — touching the content brings the hidden
		// bottom nav back (it then auto-hides again after the idle timeout).
		// Touches on buttons (incl. the grabber) were already bailed out above.
		if (!mobileNavVisible && !$layoutStore.isInCall) {
			showMobileNav();
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

		// Chat stage: preview opening whichever side user drags toward.
		if (deltaX > 0) {
			swipePreviewTarget = 'channels';
			swipePreviewOffsetX = Math.max(0, Math.min(width, deltaX));
			swipePreviewActive = true;
			return;
		}

		if (deltaX < 0) {
			swipePreviewTarget = 'users';
			swipePreviewOffsetX = Math.max(-width, Math.min(0, deltaX));
			swipePreviewActive = true;
			return;
		}
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
		const verticalMin = Math.max(78, Math.floor(window.innerHeight * 0.09));
		const isVerticalSwipe =
			Math.abs(deltaY) >= Math.max(MOBILE_NAV_SWIPE_MIN_Y_PX, verticalMin) &&
			Math.abs(deltaY) > Math.abs(deltaX) &&
			elapsedMs <= MOBILE_EDGE_SWIPE_MAX_MS;

		if (isVerticalSwipe) {
			const startedNearBottom = touchStartY >= window.innerHeight - MOBILE_NAV_REVEAL_ZONE_PX;
			const swipeUp = deltaY < 0;
			const swipeDown = deltaY > 0;

			if (!mobileNavVisible && startedNearBottom && swipeUp) {
				mobileNavVisible = true;
				resetTouchSwipe();
				return;
			}

			if (mobileNavVisible && swipeDown) {
				mobileNavVisible = false;
				resetTouchSwipe();
				return;
			}
		}

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

		if (!channelsOpen && !usersOpen && swipeLeft) {
			layoutStore.showUsersTab();
			layoutStore.showMobileChannels.set(false);
			resetTouchSwipe();
			return;
		}

		if (usersOpen && swipeRight) {
			layoutStore.closeRightPanel();
			layoutStore.showMobileChannels.set(false);
			resetTouchSwipe();
			return;
		}

		if (!channelsOpen && !usersOpen && swipeRight) {
			layoutStore.showMobileChannels.set(true);
			layoutStore.closeRightPanel();
			resetTouchSwipe();
			return;
		}

		resetTouchSwipe();
	}

	function showMobileNav(): void {
		if (!$layoutStore.isMobile) return;
		mobileNavVisible = true;
		scheduleMobileNavIdleHide();
	}

	function scheduleMobileNavIdleHide(): void {
		if (!$layoutStore.isMobile || !mobileNavVisible || $layoutStore.isInCall) return;
		if (mobileNavIdleTimer) clearTimeout(mobileNavIdleTimer);
		mobileNavIdleTimer = setTimeout(() => {
			mobileNavVisible = false;
			mobileNavIdleTimer = null;
		}, MOBILE_NAV_IDLE_HIDE_MS);
	}

	function hideMobileNavNow(): void {
		mobileNavVisible = false;
		if (mobileNavIdleTimer) {
			clearTimeout(mobileNavIdleTimer);
			mobileNavIdleTimer = null;
		}
	}

	function handleMobileNavTouchStart(event: TouchEvent): void {
		if (!$layoutStore.isMobile || !mobileNavVisible || event.touches.length !== 1) return;
		navTouchStartY = event.touches[0].clientY;
		navTouchDragging = true;
		scheduleMobileNavIdleHide();
	}

	function handleMobileNavTouchMove(event: TouchEvent): void {
		if (!navTouchDragging || event.touches.length !== 1) return;
		const deltaY = event.touches[0].clientY - navTouchStartY;
		if (deltaY >= MOBILE_NAV_PULL_DOWN_HIDE_PX) {
			hideMobileNavNow();
			navTouchDragging = false;
		}
	}

	function handleMobileNavTouchEnd(): void {
		navTouchDragging = false;
		if (mobileNavVisible) scheduleMobileNavIdleHide();
	}

	function getChannelPreviewTransform(): string | undefined {
		if (!$layoutStore.isMobile) return undefined;
		const channelsOpen = $layoutStore.showMobileChannels;
		if (!swipePreviewActive || swipePreviewTarget !== 'channels') {
			// When channels is open normally (not preview), no transform
			if (channelsOpen) return 'translateX(0)';
			return 'translateX(-100%)';
		}
		if (channelsOpen) {
			// Dragging to close - panel moves left with negative offset
			return `translateX(${swipePreviewOffsetX}px)`;
		}
		// Edge swipe to open - panel slides in from left
		return `translateX(calc(-100% + ${Math.max(0, swipePreviewOffsetX)}px))`;
	}

	function getUsersPreviewTransform(): string {
		const usersOpen = $layoutStore.rightPanelMode !== 'none';
		if (!swipePreviewActive || swipePreviewTarget !== 'users') {
			// When users panel is open normally, no transform
			if (usersOpen) return 'translateX(0)';
			return 'translateX(100%)';
		}
		if (usersOpen) {
			// Dragging to close - panel moves right with positive offset
			return `translateX(${Math.max(0, swipePreviewOffsetX)}px)`;
		}
		// Edge swipe to open - panel slides in from right
		return `translateX(calc(100% + ${Math.min(0, swipePreviewOffsetX)}px))`;
	}

	function getPreviewOpacity(): number {
		if (!swipePreviewActive || swipePreviewTarget === 'none') return 1;
		const width = Math.max(window.innerWidth, 1);
		const p = Math.min(1, Math.abs(swipePreviewOffsetX) / (width * 0.34));
		return 0.35 + (p * 0.65);
	}

	$: if ($callMode !== 'channel' || !$activeVoiceChannel) {
		showVoiceDebugDetails = false;
	}

	$: if (!$layoutStore.isMobile || $layoutStore.isInCall) {
		mobileNavVisible = false;
		if (mobileNavIdleTimer) {
			clearTimeout(mobileNavIdleTimer);
			mobileNavIdleTimer = null;
		}
	}

	$: if (mobileNavVisible && $layoutStore.isMobile && !$layoutStore.isInCall) {
		scheduleMobileNavIdleHide();
	}
</script>

<svelte:window
	on:mousemove={handleMouseMove}
	on:mouseup={stopResize}
	on:touchstart={handleTouchStart}
	on:touchmove={handleTouchMove}
	on:touchend={handleTouchEnd}
	on:touchcancel={resetTouchSwipe}
/>

<AuthErrorBanner />

{#if $centerPanelView === 'admin'}
	{#if AdminCenterStageCmp}
		<svelte:component this={AdminCenterStageCmp} />
	{:else}
		<div class="lazy-panel-placeholder" aria-busy="true"></div>
	{/if}
{:else}
{#if $layoutStore.isMobile && !$layoutStore.isInCall}
	{#if !mobileNavVisible}
		<button
			type="button"
			class="mobile-nav-grabber"
			on:click={showMobileNav}
			aria-label="Show mobile menu"
			title="Swipe up for menu"
		>
			<span></span>
		</button>
	{/if}
	<!-- Mobile Bottom Navigation Bar — Chat · Browse · Messages · You -->
	<nav class="mobile-bottom-nav" class:visible={mobileNavVisible}>
		<button
			type="button"
			class:active={
				!$layoutStore.showMobileChannels &&
				$layoutStore.rightPanelMode === 'none' &&
				activeView !== 'dm' &&
				!showSettings
			}
			on:click={openMobileChat}
			on:touchstart={handleMobileNavTouchStart}
			on:touchmove={handleMobileNavTouchMove}
			on:touchend={handleMobileNavTouchEnd}
		>
			<svg width="24" height="24" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
			<span>{$_('shell.mobile.chat')}</span>
		</button>
		<button
			type="button"
			class:active={$layoutStore.showMobileChannels}
			on:click={openMobileBrowse}
			on:touchstart={handleMobileNavTouchStart}
			on:touchmove={handleMobileNavTouchMove}
			on:touchend={handleMobileNavTouchEnd}
		>
			<svg width="24" height="24" viewBox="0 0 24 24"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>
			<span>{$_('shell.mobile.browse')}</span>
		</button>
		<button
			type="button"
			class:active={activeView === 'dm' && !$layoutStore.showMobileChannels}
			on:click={openMobileMessages}
			on:touchstart={handleMobileNavTouchStart}
			on:touchmove={handleMobileNavTouchMove}
			on:touchend={handleMobileNavTouchEnd}
		>
			<svg width="24" height="24" viewBox="0 0 24 24"><path d="M4 4h16v12H5.17L4 17.17V4z"/><path d="M8 8h8M8 12h5"/></svg>
			<span>{$_('shell.mobile.messages')}</span>
		</button>
		<button
			type="button"
			class:active={showSettings}
			on:click={openMobileYou}
			on:touchstart={handleMobileNavTouchStart}
			on:touchmove={handleMobileNavTouchMove}
			on:touchend={handleMobileNavTouchEnd}
		>
			<svg width="24" height="24" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
			<span>{$_('shell.mobile.you')}</span>
		</button>
	</nav>
{/if}

{#if $layoutStore.isMobile && ($layoutStore.showMobileChannels || $layoutStore.rightPanelMode !== 'none')}
	<!-- Mobile backdrop overlay - closes panels on tap -->
	<div class="mobile-panel-backdrop" on:click={() => { layoutStore.showMobileChannels.set(false); layoutStore.closeRightPanel(); }}></div>
{/if}

<div
		class="app-container"
		class:focus-mode={$focusMode}
		class:resizing={$layoutStore.isResizing}
		class:in-call={$layoutStore.isMobile && $layoutStore.isInCall}
		class:mobile-nav-visible={mobileNavVisible && $layoutStore.isMobile && !$layoutStore.isInCall}
		class:nav-right={!$layoutStore.isMobile && $layoutStore.navDock === 'right'}
		class:obvious-grab-rails={$layoutStore.obviousGrabRails}
	>
	{#if !$layoutStore.isMobile && $layoutStore.channelSidebarWidth === 0}
		<button
			type="button"
			class="nav-reopen-rail"
			class:dock-right={$layoutStore.navDock === 'right'}
			style:left={$layoutStore.navDock !== 'right'
				? `${desktopServerRailOffset + ($layoutStore.stubSide === 'left' && $layoutStore.rightPanelMode === 'pinned' ? $layoutStore.rightPanelWidth : 0)}px`
				: null}
			style:right={$layoutStore.navDock === 'right'
				? `${desktopServerRailOffset + ($layoutStore.stubSide === 'right' && $layoutStore.rightPanelMode === 'pinned' ? $layoutStore.rightPanelWidth : 0)}px`
				: null}
			on:click={layoutStore.expandNav}
			on:mousedown|preventDefault={startChannelResizeFromClosed}
			title="Open channel sidebar"
			aria-label="Open channel sidebar"
		>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
				{#if $layoutStore.navDock === 'right'}
					<polyline points="15 18 9 12 15 6"/>
				{:else}
					<polyline points="9 18 15 12 9 6"/>
				{/if}
			</svg>
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
		style:width="{$layoutStore.channelSidebarWidth}px"
		class:mobile-visible={$layoutStore.showMobileChannels}
		class:preview-visible={$layoutStore.isMobile && swipePreviewActive && swipePreviewTarget === 'channels'}
		class:dock-right={!$layoutStore.isMobile && $layoutStore.navDock === 'right'}
		style:transform={getChannelPreviewTransform()}
		style:opacity={getPreviewOpacity()}
		style:transition={swipePreviewActive ? 'none' : undefined}
	>
		<ChannelSidebar
			on:close={() => layoutStore.showMobileChannels.set(false)}
			on:openServerSwitcher={openServerSwitcher}
			bind:activeView
			on:logout
			on:openSettings={() => openSettings()}
		/>
		<!-- Channel resize handle -->
		<button
			type="button"
			class="resize-handle resize-handle-channel"
			aria-label="Resize channel sidebar"
			on:mousedown|preventDefault={() => layoutStore.isResizingChannel.set(true)}
		></button>
	</div>

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

	<!-- Right Panel — single mode-driven node (peek = fixed overlay, pinned = flex child).
	       One DOM node for both modes so the panel never remounts on peek↔pin (spec §6).
	       The stub strip mounts INSIDE the zone so the stubs ride the panel like folder
	       tabs (peek slide-in carries them with it); a standalone strip serves the
	       closed (mode = none) cabinet state. -->
	{#if !$layoutStore.isMobile}
		{#if $layoutStore.rightPanelMode !== 'none'}
			<div
				class="right-panel-zone"
				class:peek={$layoutStore.rightPanelMode === 'peek'}
				class:stub-right={$layoutStore.stubSide === 'right'}
				class:stub-left={$layoutStore.stubSide === 'left'}
				style:width="{$layoutStore.rightPanelWidth}px"
				style:flex-basis="{$layoutStore.rightPanelWidth}px"
				style:max-width="min(744px, 55vw)"
				on:mouseenter={cancelPeekDismiss}
				on:mouseleave={armPeekDismiss}
			>
				<div class="right-panel-body">
					{#if $layoutStore.rightPanelMode === 'pinned'}
						<button
							type="button"
							class="resize-handle resize-handle-right"
							aria-label="Resize right panel"
							on:mousedown|preventDefault={() => layoutStore.isResizingRight.set(true)}
						></button>
					{/if}
					<RightPanel on:openSettings={(event) => openSettings(event.detail?.paymentSurface ?? null)} />
				</div>
				<RightStubStrip floating />
			</div>
		{:else}
			<RightStubStrip />
		{/if}
	{:else}
		<!-- Mobile Right Panel Overlay -->
		<div
			class="mobile-right-overlay"
			class:visible={$layoutStore.rightPanelMode !== 'none'}
			class:preview-visible={$layoutStore.isMobile && swipePreviewActive && swipePreviewTarget === 'users'}
			style:transform={getUsersPreviewTransform()}
			style:opacity={getPreviewOpacity()}
			style:transition={swipePreviewActive ? 'none' : undefined}
		>
			<RightPanel on:openSettings={(event) => openSettings(event.detail?.paymentSurface ?? null)} />
		</div>
	{/if}

	<!-- Main Content -->
	<div class="main-content">
		<div class="chat-stack">
			<div class="chat-surface">
				{#if isModelViewportTabActive || isReaderTabActive || isMediaAlbumsTabActive || isMapTabActive || isPlannerTabActive || isNotesTabActive || $voiceViewOpen}
					<WorkspaceViewBar activeView={workspaceActiveView} onSelectView={handleWorkspaceViewSelect} />
				{/if}
				{#if isModelViewportTabActive}
					{#if ModelViewportTabCmp}
						<svelte:component this={ModelViewportTabCmp} />
					{:else}
						<div class="lazy-panel-placeholder" aria-busy="true"></div>
					{/if}
				{:else if isReaderTabActive}
					{#if ReaderTabCmp}
						<svelte:component this={ReaderTabCmp} />
					{:else}
						<div class="lazy-panel-placeholder" aria-busy="true"></div>
					{/if}
				{:else if isMediaAlbumsTabActive}
					{#if MediaAlbumsTabCmp}
						<svelte:component this={MediaAlbumsTabCmp} variant="full" />
					{:else}
						<div class="lazy-panel-placeholder" aria-busy="true"></div>
					{/if}
				{:else if isMapTabActive}
					{#if MapWorkspaceCmp}
						<svelte:component this={MapWorkspaceCmp} variant="full" />
					{:else}
						<div class="lazy-panel-placeholder" aria-busy="true"></div>
					{/if}
				{:else if isPlannerTabActive}
					{#if PlannerWorkspaceCmp}
						<svelte:component this={PlannerWorkspaceCmp} variant="full" />
					{:else}
						<div class="lazy-panel-placeholder" aria-busy="true"></div>
					{/if}
				{:else if isNotesTabActive}
					{#if KeepNotesViewCmp}
						<svelte:component this={KeepNotesViewCmp} />
					{:else}
						<div class="lazy-panel-placeholder" aria-busy="true"></div>
					{/if}
				{:else if $voiceViewOpen}
					{#if VoiceViewCmp}
						<svelte:component this={VoiceViewCmp} />
					{:else}
						<div class="lazy-panel-placeholder" aria-busy="true"></div>
					{/if}
				{:else if $layoutStore.centerDmChannelId || activeView === 'dm'}
					<div class="center-dm-layout">
						<div class="center-dm-list">
							<DmHub />
						</div>
						<div class="center-dm-thread">
							{#if $layoutStore.centerDmChannelId}
								<DmConversationView context="center" channelIdProp={$layoutStore.centerDmChannelId} otherUserProp={$dmOtherUser} />
							{:else}
								<div class="center-dm-empty">
									<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
										<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
									</svg>
									<span>Select a conversation</span>
								</div>
							{/if}
						</div>
					</div>
				{:else if activeView === 'following'}
					<FollowingFeed on:openChannel={() => (activeView = 'chat')} />
				{:else if isGalleryChannel}
					{#if GalleryChannelCmp}
						<svelte:component this={GalleryChannelCmp} />
					{:else}
						<div class="lazy-panel-placeholder" aria-busy="true"></div>
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
				<div class="lazy-panel-placeholder" aria-busy="true"></div>
			{/if}
		</div>
	</div>

	<!-- Floating sub-window layer inside the app webview. This is the Odysseus-style panel system for Tauri/browser. -->
	<FloatingPanelHost />

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
					<div class="lazy-panel-placeholder" aria-busy="true"></div>
				{/if}
				<button
					type="button"
					class="call-debug-close"
					on:click={() => (showCallDebugPanel = false)}
					aria-label="Close calling diagnostics"
					title="Close calling diagnostics"
				>
					×
				</button>
			</div>
		{/if}
	{/if}

	{#if $layoutStore.isMobile && $callMode === 'channel' && $activeVoiceChannel}
		<div class="voice-channel-strip" role="status" aria-live="polite" transition:fly={{ y: 20, duration: 220 }}>
			<button
				class="voice-status-header"
				type="button"
				on:click={() => (showVoiceDebugDetails = !showVoiceDebugDetails)}
				aria-expanded={showVoiceDebugDetails}
				title={$_('shell.call.toggle_diagnostics')}
			>
				<span class="status-leading">
					<span class="dot"></span>
					<span class="voice-status-text">
						<strong>{$_('shell.call.voice_connected')}</strong>
						<small>{$activeVoiceChannel.name} / {$connectionState}</small>
					</span>
				</span>
				<span class="status-chevron">{showVoiceDebugDetails ? 'v' : '>'}</span>
			</button>

			{#if showVoiceDebugDetails}
				<div class="voice-debug-grid">
					<div class="debug-item"><span>Ping</span><strong>{formatDiag($callConnectionDiagnostics.pingMs, 'ms')}</strong></div>
					<div class="debug-item"><span>Jitter</span><strong>{formatDiag($callConnectionDiagnostics.jitterMs, 'ms')}</strong></div>
					<div class="debug-item"><span>Inbound Loss</span><strong>{formatDiag($callConnectionDiagnostics.inboundPacketLossPct, '%')}</strong></div>
					<div class="debug-item"><span>Outbound Loss</span><strong>{formatDiag($callConnectionDiagnostics.outboundPacketLossPct, '%')}</strong></div>
					<div class="debug-item"><span>Inbound Rate</span><strong>{formatDiag($callConnectionDiagnostics.inboundKbps, 'kbps')}</strong></div>
					<div class="debug-item"><span>Outbound Rate</span><strong>{formatDiag($callConnectionDiagnostics.outboundKbps, 'kbps')}</strong></div>
					<div class="debug-item"><span>Transport</span><strong>{$callTransportState.activeTransport.toUpperCase()}</strong></div>
					<div class="debug-item"><span>Participants</span><strong>{1 + $activeCalls.length}</strong></div>
				</div>
			{/if}

			<div class="voice-channel-meta">
				<span class="voice-channel-name-label">{$_('shell.call.in_voice')}</span>
				<strong>{$activeVoiceChannel.name}</strong>
			</div>
			<div class="voice-channel-actions">
				<button on:click={handleOpenVoiceWhiteboard} title="Open whiteboard for this voice channel" aria-label="Open whiteboard for this voice channel">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
						<rect x="3" y="4" width="18" height="14" rx="2"></rect>
						<path d="M7 8h10"></path>
						<path d="M7 12h6"></path>
						<path d="M8 20h8"></path>
					</svg>
				</button>
				<button class:active={!$isVideoOff} on:click={handleToggleVideoFromStrip} title={$isVideoOff ? $_('shell.call.turn_on_camera') : $_('shell.call.turn_off_camera')} aria-label={$isVideoOff ? $_('shell.call.turn_on_camera') : $_('shell.call.turn_off_camera')}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
						<path d="M23 7l-7 5 7 5V7z"></path>
						<rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
					</svg>
				</button>
				<button class="leave icon-only" on:click={handleLeaveVoiceChannel} title={$_('shell.call.leave_voice')} aria-label={$_('shell.call.leave_voice')}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
						<path d="M14 3h7v18h-7"></path>
						<path d="M10 17l5-5-5-5"></path>
						<path d="M15 12H3"></path>
					</svg>
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
			requestedPasswordChangeRequest={requestedSettingsPasswordChangeRequest}
			on:logout
		/>
	{:else}
		<div class="lazy-panel-placeholder" aria-busy="true"></div>
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
		aria-label="Quick Scratchpad"
	>
		<QuickScratchpad />
	</div>
{/if}

<style>
	/* Uniform placeholder for lazily-loaded panels (Phase 4 boot optimization). */
	.lazy-panel-placeholder {
		height: 100%;
		min-height: 8rem;
		border-radius: var(--radius-md, 8px);
		background: linear-gradient(
			100deg,
			rgba(255, 255, 255, 0.04) 40%,
			rgba(255, 255, 255, 0.09) 50%,
			rgba(255, 255, 255, 0.04) 60%
		);
		background-size: 200% 100%;
		animation: lazy-shimmer 1.2s ease-in-out infinite;
	}
	@keyframes lazy-shimmer {
		to {
			background-position: -200% 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.lazy-panel-placeholder {
			animation: none;
		}
	}

	.center-dm-layout {
		display: grid;
		grid-template-columns: 300px minmax(0, 1fr);
		height: 100%;
		min-height: 0;
		overflow: hidden;
	}

	.center-dm-list {
		min-width: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		border-right: 1px solid var(--color-border-primary, #302b63);
	}

	.center-dm-thread {
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
		gap: 0.75rem;
		color: var(--text-muted, #9999ff);
		font-size: 0.95rem;
	}

	@media (max-width: 768px) {
		.center-dm-layout {
			grid-template-columns: 1fr;
		}
		.center-dm-list {
			display: none;
		}
		.center-dm-layout:not(:has(.center-dm-thread .dm-conversation)) .center-dm-list {
			display: flex;
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
		padding: 1rem;
		background: rgba(0, 0, 0, 0.35);
	}

	.quick-scratchpad-overlay > :global(*) {
		width: min(420px, 92vw);
		max-height: min(380px, 72vh);
		border-radius: 12px;
		overflow: hidden;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
	}

	/* Dev-only calling-diagnostics overlay (gated by import.meta.env.DEV) */
	.call-debug-toggle {
		position: fixed;
		left: 8px;
		bottom: 8px;
		z-index: var(--z-sticky, 100);
		width: 32px;
		height: 32px;
		border-radius: 8px;
		border: 1px solid var(--border-subtle);
		background: var(--surface-base, #24243e);
		color: var(--text-secondary, #b3b3ff);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		transition: all 0.18s ease;
		opacity: 0.5;
	}

	.call-debug-toggle:hover,
	.call-debug-toggle.active {
		opacity: 1;
		background: var(--accent-primary-color);
		color: var(--text-inverse, #fff);
		border-color: var(--accent-primary-color);
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
		width: 22px;
		height: 22px;
		line-height: 1;
		border-radius: 999px;
		border: 1px solid var(--border-subtle);
		background: var(--surface-base, #24243e);
		color: var(--text-secondary, #b3b3ff);
		font-size: 1rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.call-debug-close:hover {
		background: var(--accent-danger-soft, rgba(239, 68, 68, 0.2));
		color: var(--color-danger, #ef4444);
		border-color: rgba(var(--color-danger-rgb, 239, 68, 68), 0.5);
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
