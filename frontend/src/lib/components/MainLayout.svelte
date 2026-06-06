<!-- frontend/src/lib/components/MainLayout.svelte -->
<script lang="ts">
	import { fly } from 'svelte/transition';
	import { layoutStore } from '$lib/layoutStore';
	import { get } from 'svelte/store';
	import Chat from '$lib/components/Chat.svelte';
	import ModelViewportTab from '$lib/components/ModelViewportTab.svelte';
	import ReaderTab from '$lib/components/ReaderTab.svelte';
	import MapWorkspace from '$lib/components/MapWorkspace.svelte';
	import GalleryChannel from '$lib/components/GalleryChannel.svelte';
	import ChannelSidebar from '$lib/components/ChannelSidebar.svelte';
	import FloatingPanelHost from '$lib/components/windowing/FloatingPanelHost.svelte';
	import ServerRail from '$lib/components/ServerRail.svelte';
	import ServerSwitcherPanel from '$lib/components/ServerSwitcherPanel.svelte';
	import FollowingFeed from '$lib/components/FollowingFeed.svelte';
	import RightPanel from '$lib/components/RightPanel.svelte';
	import CallModal from '$lib/components/CallModal.svelte';
	import Settings from '$lib/components/Settings.svelte';
	import AuthErrorBanner from '$lib/components/AuthErrorBanner.svelte';
	import { channelMessages, channelUnreadCounts, channels, currentChannel, currentUser, users, getSocket, leaveVoiceChannel as leaveSocketVoiceChannel, type Channel, type User } from '$lib/socket';
	import { activeCalls, activeVoiceChannel, callConnectionDiagnostics, callMode, callTransportState, connectionState, isVideoOff, toggleVideo } from '$lib/calling';
	import { mobileTabQueue } from '$lib/mobileTabQueue';
	import { onDestroy, onMount } from 'svelte';
	import { _ } from '$lib/i18n';
	import { displayEnhancementSettingsStore } from '$lib/displayEnhancements';
	import { playNotificationSound } from '$lib/notifications';
	import { MAP_ADDON_ID } from '$lib/mapWorkspace';
	import { MODEL_VIEWPORT_ADDON_ID } from '$lib/modelViewportTab';
	import { READER_ADDON_ID } from '$lib/readerWorkspace';
	import {
		getServerScopedUserKey,
		getTrackedPersonKeyForUser,
		isTrackedPersonStatusAlertsKeyEnabled,
		rememberPeople
	} from '$lib/peopleTracker';
	import { getServerUrl } from '$lib/serverUrl';
	import { openWhiteboardSurface } from '$lib/whiteboard/whiteboardSurface';
	import { savedServerRailItems } from '$lib/savedServers';
	import { startGameScreenshotPipe } from '$lib/gameScreenshotPipe';

	export let activeView: 'chat' | 'screen' | 'following' = 'chat';
	export let accountSecurityOpenRequest = 0;
	let showSettings = false;
	let requestedSettingsPaymentSurface: 'connections' | null = null;
	let requestedSettingsPasswordChangeRequest = 0;
	let lastHandledAccountSecurityOpenRequest = 0;

	$: mobileRightVisible = $layoutStore.isMobile && $layoutStore.rightPanelView !== 'none';
	$: totalUnreadDMs = Object.entries($channelUnreadCounts)
		.filter(([channelId, count]) => channelId.startsWith('dm-') && count > 0)
		.reduce((sum, [, count]) => sum + count, 0);

	let resizingChannel = false;
	let resizingRight = false;
	let showVoiceDebugDetails = false;
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
	let stopGameScreenshotPipe: (() => void) | null = null;
	const { activeTabId } = mobileTabQueue;
	const MODEL_VIEWPORT_TAB_TOKEN = mobileTabQueue.toAddonTabId(MODEL_VIEWPORT_ADDON_ID);
	const READER_TAB_TOKEN = mobileTabQueue.toAddonTabId(READER_ADDON_ID);
	const MAP_TAB_TOKEN = mobileTabQueue.toAddonTabId(MAP_ADDON_ID);
	$: isModelViewportTabActive = $activeTabId === MODEL_VIEWPORT_TAB_TOKEN;
	$: isReaderTabActive = $activeTabId === READER_TAB_TOKEN;
	$: isMapTabActive = $activeTabId === MAP_TAB_TOKEN;
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

	function openServerSwitcher(): void {
		showServerSwitcher = true;
	}

	function closeServerSwitcher(): void {
		showServerSwitcher = false;
	}

	onMount(() => {
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
		stopGameScreenshotPipe = startGameScreenshotPipe();
	});

	onDestroy(() => {
		mobileTabQueue.unregisterAddonTab(MODEL_VIEWPORT_ADDON_ID);
		mobileTabQueue.unregisterAddonTab(READER_ADDON_ID);
		mobileTabQueue.unregisterAddonTab(MAP_ADDON_ID);
		if (mobileNavIdleTimer) {
			clearTimeout(mobileNavIdleTimer);
			mobileNavIdleTimer = null;
		}
		if (unsubscribeFriendPresence) {
			unsubscribeFriendPresence();
			unsubscribeFriendPresence = null;
		}
		if (stopGameScreenshotPipe) {
			stopGameScreenshotPipe();
			stopGameScreenshotPipe = null;
		}
	});

	function getPresenceObserverKey(user: User | null | undefined, serverUrl: string): string {
		return getServerScopedUserKey(user, serverUrl);
	}

	function shouldNotifyFriendStatus(trackedPersonKey: string): boolean {
		const settings = get(displayEnhancementSettingsStore);
		if (!settings.friendNotificationsEnabled) return false;
		if (settings.friendNotificationsTrackedOnly && !isTrackedPersonStatusAlertsKeyEnabled(trackedPersonKey)) {
			return false;
		}
		if (typeof window === 'undefined') return false;
		if (!('Notification' in window)) return false;
		if (Notification.permission !== 'granted') return false;
		if (localStorage.getItem('notificationsEnabled') === 'false') return false;
		return true;
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
			// Right panel can stretch to any width — measure from right edge of viewport
			const newWidth = window.innerWidth - e.clientX;
			layoutStore.rightPanelWidth.set(Math.max(0, newWidth));
		}
	}

	function stopResize() {
		if (resizingChannel) {
			const w = get(layoutStore.channelSidebarWidth);
			if (w < 50) layoutStore.channelSidebarWidth.set(0);
		}
		if (resizingRight) {
			const w = get(layoutStore.rightPanelWidth);
			if (w < 50) layoutStore.rightPanelWidth.set(0);
			// else: keep user-set width (no snap to 220)
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

	function startRightResizeFromClosed(event: MouseEvent) {
		if ($layoutStore.isMobile) return;
		const width = window.innerWidth - event.clientX;
		layoutStore.rightPanelWidth.set(Math.max(8, Math.min(width, window.innerWidth)));
		layoutStore.isResizingRight.set(true);
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
			return;
		}
		const other = getChannelOtherUser(channel);
		if (other) {
			layoutStore.openDM(channel.id, other);
		}
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
		const usersOpen = $layoutStore.rightPanelView !== 'none';
		
		// If starting near an edge and no panel is open, prepare for edge swipe
		if (!channelsOpen && !usersOpen && (nearLeftEdge || nearRightEdge)) {
			swipePreviewTarget = nearLeftEdge ? 'channels' : 'users';
			swipePreviewActive = true;
			swipePreviewOffsetX = nearLeftEdge ? 0 : 0;
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
		const usersOpen = $layoutStore.rightPanelView !== 'none';
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
		const usersOpen = $layoutStore.rightPanelView !== 'none';

		// Edge swipe to OPEN panels from closed state
		if (!channelsOpen && !usersOpen) {
			if (swipeRight && swipePreviewTarget === 'channels') {
				// Swiped right from left edge - open channels
				layoutStore.showMobileChannels.set(true);
				layoutStore.rightPanelView.set('none');
				resetTouchSwipe();
				return;
			}
			if (swipeLeft && swipePreviewTarget === 'users') {
				// Swiped left from right edge - open users
				layoutStore.rightPanelView.set('full');
				layoutStore.showMobileChannels.set(false);
				resetTouchSwipe();
				return;
			}
		}

		// Stage navigation: Channels <-> Chat <-> Users
		if (channelsOpen && swipeLeft) {
			layoutStore.showMobileChannels.set(false);
			layoutStore.rightPanelView.set('none');
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
			layoutStore.rightPanelView.set('none');
			layoutStore.showMobileChannels.set(false);
			resetTouchSwipe();
			return;
		}

		if (!channelsOpen && !usersOpen && swipeRight) {
			layoutStore.showMobileChannels.set(true);
			layoutStore.rightPanelView.set('none');
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
		const usersOpen = $layoutStore.rightPanelView !== 'none';
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
	<!-- Mobile Bottom Navigation Bar -->
	<nav class="mobile-bottom-nav" class:visible={mobileNavVisible}>
		<button
			class:active={!$layoutStore.showMobileChannels && $layoutStore.rightPanelView === 'none'}
			on:click={() => { layoutStore.showMobileChannels.set(false); layoutStore.rightPanelView.set('none'); scheduleMobileNavIdleHide(); }}
			on:touchstart={handleMobileNavTouchStart}
			on:touchmove={handleMobileNavTouchMove}
			on:touchend={handleMobileNavTouchEnd}
		>
			<svg width="24" height="24" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
			<span>{$_('shell.mobile.chat')}</span>
		</button>
		<button
			class:active={$layoutStore.showMobileChannels}
			on:click={() => { layoutStore.toggleMobileChannels(); scheduleMobileNavIdleHide(); }}
			on:touchstart={handleMobileNavTouchStart}
			on:touchmove={handleMobileNavTouchMove}
			on:touchend={handleMobileNavTouchEnd}
		>
			<svg width="24" height="24" viewBox="0 0 24 24"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>
			<span>{$_('shell.mobile.channels')}</span>
		</button>
		<button
			class:active={$layoutStore.rightPanelView !== 'none'}
			on:click={() => { layoutStore.toggleMobileUsers(); scheduleMobileNavIdleHide(); }}
			on:touchstart={handleMobileNavTouchStart}
			on:touchmove={handleMobileNavTouchMove}
			on:touchend={handleMobileNavTouchEnd}
		>
			<svg width="24" height="24" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
			<span>{$_('shell.mobile.users')}</span>
		</button>
	</nav>
{/if}

{#if $layoutStore.isMobile && ($layoutStore.showMobileChannels || $layoutStore.rightPanelView !== 'none')}
	<!-- Mobile backdrop overlay - closes panels on tap -->
	<div class="mobile-panel-backdrop" on:click={() => { layoutStore.showMobileChannels.set(false); layoutStore.rightPanelView.set('none'); }}></div>
{/if}

<div
		class="app-container"
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
			style:left={$layoutStore.navDock !== 'right' ? `${desktopServerRailOffset}px` : null}
			style:right={$layoutStore.navDock === 'right'
				? `${desktopServerRailOffset + $layoutStore.rightPanelWidth}px`
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

	<!-- Right Panel - Desktop uses width-based, Mobile uses overlay -->
	{#if !$layoutStore.isMobile}
		<!-- Desktop Right Panel — always visible, zero-width = hidden -->
		<div
			class="right-panel-container"
			style:width="{$layoutStore.rightPanelWidth}px"
		>
			<!-- Right panel resize handle -->
			<button
				type="button"
				class="resize-handle resize-handle-right"
				aria-label="Resize right panel"
				on:mousedown|preventDefault={() => layoutStore.isResizingRight.set(true)}
			></button>
			<RightPanel on:openSettings={(event) => openSettings(event.detail?.paymentSurface ?? null)} />
		</div>
	{:else}
		<!-- Mobile Right Panel Overlay -->
		<div
			class="mobile-right-overlay"
			class:visible={$layoutStore.rightPanelView !== 'none'}
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
				{#if isModelViewportTabActive}
					<ModelViewportTab />
				{:else if isReaderTabActive}
					<ReaderTab />
				{:else if isMapTabActive}
					<MapWorkspace variant="full" />
				{:else if activeView === 'following'}
					<FollowingFeed on:openChannel={() => (activeView = 'chat')} />
				{:else if isGalleryChannel}
					<GalleryChannel />
				{:else}
					<Chat
						on:logout
						on:openSettings={(event) => openSettings(event.detail?.paymentSurface ?? null)}
					/>
				{/if}
			</div>
			<CallModal />
		</div>
	</div>

	<!-- Right panel restore rail (visible when right panel is closed) -->
	{#if !$layoutStore.isMobile && $layoutStore.rightPanelWidth === 0}
		<button
			type="button"
			class="right-reopen-rail"
			class:dock-right={$layoutStore.navDock === 'right'}
			style:right={$layoutStore.navDock === 'right'
				? `${desktopServerRailOffset + $layoutStore.channelSidebarWidth}px`
				: '0px'}
			style:left={$layoutStore.navDock !== 'right'
				? null
				: null}
			on:click={layoutStore.expandRight}
			on:mousedown|preventDefault={startRightResizeFromClosed}
			title="Open right panel"
			aria-label="Open right panel"
		>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
				{#if $layoutStore.navDock === 'right'}
					<polyline points="9 18 15 12 9 6"/>
				{:else}
					<polyline points="15 18 9 12 15 6"/>
				{/if}
			</svg>
		</button>
	{/if}

	<!-- Desktop toggle button (visible when channel sidebar is closed) -->
	{#if !$layoutStore.isMobile && $layoutStore.channelSidebarWidth === 0}
		<button
			class="user-panel-toggle"
			class:has-unread={totalUnreadDMs > 0}
			data-unread={totalUnreadDMs > 99 ? '99+' : totalUnreadDMs}
			style:right={!$layoutStore.isMobile && $layoutStore.navDock === 'right'
			? `${desktopServerRailOffset + $layoutStore.rightPanelWidth}px`
			: '0px'}
			on:click={layoutStore.toggleRightPanel}
			title={$_('shell.open_side_panel')}
		>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<polyline points="15 18 9 12 15 6"/>
			</svg>
		</button>
	{/if}

	<!-- Floating sub-window layer inside the app webview. This is the Odysseus-style panel system for Tauri/browser. -->
	<FloatingPanelHost />

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
	<Settings
		bind:isOpen={showSettings}
		requestedPaymentSurface={requestedSettingsPaymentSurface}
		requestedPasswordChangeRequest={requestedSettingsPasswordChangeRequest}
		on:logout
	/>
{/if}

