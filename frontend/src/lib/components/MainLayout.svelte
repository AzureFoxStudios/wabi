<!-- frontend/src/lib/components/MainLayout.svelte -->
<script lang="ts">
	import { fly } from 'svelte/transition';
	import { layoutStore } from '$lib/layoutStore';
	import { get } from 'svelte/store';
	import Chat from '$lib/components/Chat.svelte';
	import ModelViewportTab from '$lib/components/ModelViewportTab.svelte';
	import MapWorkspace from '$lib/components/MapWorkspace.svelte';
	import ChannelSidebar from '$lib/components/ChannelSidebar.svelte';
	import ServerRail from '$lib/components/ServerRail.svelte';
	import ServerSwitcherPanel from '$lib/components/ServerSwitcherPanel.svelte';
	import FollowingFeed from '$lib/components/FollowingFeed.svelte';
	import RightPanel from '$lib/components/RightPanel.svelte';
	import CallModal from '$lib/components/CallModal.svelte';
	import Settings from '$lib/components/Settings.svelte';
	import AuthErrorBanner from '$lib/components/AuthErrorBanner.svelte';
	import { channelMessages, channelUnreadCounts, channels, currentUser, users, getSocket, leaveVoiceChannel as leaveSocketVoiceChannel, type Channel, type User } from '$lib/socket';
	import { activeCalls, activeVoiceChannel, callConnectionDiagnostics, callMode, callTransportState, connectionState, isVideoOff, toggleVideo } from '$lib/calling';
	import { mobileTabQueue } from '$lib/mobileTabQueue';
	import { onDestroy, onMount } from 'svelte';
	import { _ } from '$lib/i18n';
	import { displayEnhancementSettingsStore } from '$lib/displayEnhancements';
	import { playNotificationSound } from '$lib/notifications';
	import { MAP_ADDON_ID } from '$lib/mapWorkspace';

	export let activeView: 'chat' | 'screen' | 'following' = 'chat';
	export let accountSecurityOpenRequest = 0;
	let showSettings = false;
	let requestedSettingsPaymentSurface: 'connections' | null = null;
	let requestedSettingsPasswordChangeRequest = 0;
	let lastHandledAccountSecurityOpenRequest = 0;

	$: mobileRightVisible = $layoutStore.isMobile && $layoutStore.rightPanelView !== 'none';
	$: showDesktopNotificationRail = !$layoutStore.isMobile && !$layoutStore.showRightPanel;
	$: totalUnreadDMs = Object.entries($channelUnreadCounts)
		.filter(([channelId, count]) => channelId.startsWith('dm-') && count > 0)
		.reduce((sum, [, count]) => sum + count, 0);
	$: unreadDMChannels = $channels
		.filter(channel => {
			if (channel.type !== 'dm' && channel.type !== 'group') return false;
			return ($channelUnreadCounts[channel.id] || 0) > 0;
		})
		.sort((a, b) => getLastMessageTimestamp(b.id) - getLastMessageTimestamp(a.id))
		.slice(0, 6);

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
	};
	let friendPresenceByKey = new Map<string, FriendPresenceSnapshot>();
	let friendPresenceObserverReady = false;
	let unsubscribeFriendPresence: (() => void) | null = null;
	const { activeTabId } = mobileTabQueue;
	const MODEL_VIEWPORT_TAB_ID = 'model-viewport';
	const MODEL_VIEWPORT_TAB_TOKEN = mobileTabQueue.toAddonTabId(MODEL_VIEWPORT_TAB_ID);
	const MAP_TAB_TOKEN = mobileTabQueue.toAddonTabId(MAP_ADDON_ID);
	$: isModelViewportTabActive = $activeTabId === MODEL_VIEWPORT_TAB_TOKEN;
	$: isMapTabActive = $activeTabId === MAP_TAB_TOKEN;
	const MOBILE_EDGE_SWIPE_MIN_X_PX = 56;
	const MOBILE_EDGE_SWIPE_MAX_Y_PX = 72;
	const MOBILE_EDGE_SWIPE_MAX_MS = 700;
	const MOBILE_NAV_REVEAL_ZONE_PX = 88;
	const MOBILE_NAV_SWIPE_MIN_Y_PX = 46;
	const MOBILE_NAV_IDLE_HIDE_MS = 2200;
	const MOBILE_NAV_PULL_DOWN_HIDE_PX = 26;
	const SERVER_RAIL_WIDTH = 76;

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
			id: MODEL_VIEWPORT_TAB_ID,
			label: '3D Viewport',
			shortLabel: '3D View'
		});
		mobileTabQueue.registerAddonTab({
			id: MAP_ADDON_ID,
			label: 'Maps',
			shortLabel: 'Map'
		});

		unsubscribeFriendPresence = users.subscribe((nextUsers) => {
			const me = get(currentUser);
			const selfKeys = new Set<string>();
			if (me?.id) selfKeys.add(me.id);
			if (me?.dbUserId) selfKeys.add(`user-${me.dbUserId}`);

			const nextSnapshot = new Map<string, FriendPresenceSnapshot>();
			for (const user of nextUsers) {
				const key = getFriendTrackKey(user);
				const isSelf = selfKeys.has(key);
				const nextEntry: FriendPresenceSnapshot = {
					status: user.status,
					username: user.username,
					isSelf
				};
				nextSnapshot.set(key, nextEntry);

				if (!friendPresenceObserverReady || isSelf) continue;
				const previous = friendPresenceByKey.get(key);
				if (!previous) continue;
				if (previous.status === user.status) continue;
				notifyFriendStatusChange(key, user.username, previous.status, user.status);
			}

			if (friendPresenceObserverReady) {
				for (const [key, previous] of friendPresenceByKey.entries()) {
					if (previous.isSelf) continue;
					if (nextSnapshot.has(key)) continue;
					notifyFriendStatusChange(key, previous.username, previous.status, 'offline');
				}
			}

			friendPresenceByKey = nextSnapshot;
			friendPresenceObserverReady = true;
		});
	});

	onDestroy(() => {
		mobileTabQueue.unregisterAddonTab(MODEL_VIEWPORT_TAB_ID);
		mobileTabQueue.unregisterAddonTab(MAP_ADDON_ID);
		if (mobileNavIdleTimer) {
			clearTimeout(mobileNavIdleTimer);
			mobileNavIdleTimer = null;
		}
		if (unsubscribeFriendPresence) {
			unsubscribeFriendPresence();
			unsubscribeFriendPresence = null;
		}
	});

	function getFriendTrackKey(user: User): string {
		if (user.dbUserId) return `user-${user.dbUserId}`;
		return user.id;
	}

	function shouldNotifyFriendStatus(trackKey: string): boolean {
		const settings = get(displayEnhancementSettingsStore);
		if (!settings.friendNotificationsEnabled) return false;
		if (
			settings.friendNotificationsTrackedOnly &&
			!settings.friendNotificationTrackedUserIds.includes(trackKey)
		) {
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
		trackKey: string,
		username: string,
		previousStatus: User['status'] | 'offline',
		nextStatus: User['status'] | 'offline'
	): void {
		if (!shouldNotifyFriendStatus(trackKey)) return;
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
			layoutStore.channelSidebarWidth.set(Math.max(0, Math.min(width, 400)));
		}
		if (resizingRight) {
			const navOffset = !$layoutStore.isMobile && $layoutStore.navDock === 'right'
				? $layoutStore.channelSidebarWidth
				: 0;
			const rightEdge = window.innerWidth - navOffset;
			const newWidth = Math.max(0, Math.min(rightEdge - e.clientX, 500));
			layoutStore.rightPanelWidth.set(newWidth);
		}
	}

	function stopResize() {
		if (resizingChannel) {
			const w = get(layoutStore.channelSidebarWidth);
			if (w < 30) layoutStore.channelSidebarWidth.set(0);
			else if (w < 170) layoutStore.channelSidebarWidth.set(60);
			else layoutStore.channelSidebarWidth.set(280);
		}
		if (resizingRight) {
			const w = get(layoutStore.rightPanelWidth);
			if (w < 30) {
				layoutStore.rightPanelWidth.set(0);
				layoutStore.rightPanelView.set('none');
			} else if (w < 200) {
				layoutStore.rightPanelWidth.set(250);
			}
		}
		layoutStore.isResizingChannel.set(false);
		layoutStore.isResizingRight.set(false);
	}

	function startChannelResizeFromClosed(event: MouseEvent) {
		if ($layoutStore.isMobile) return;
		const isRightDock = $layoutStore.navDock === 'right';
		const width = isRightDock ? window.innerWidth - event.clientX : event.clientX;
		layoutStore.channelSidebarWidth.set(Math.max(8, Math.min(width, 400)));
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

	function getChannelPreviewTransform(): string {
		const channelsOpen = $layoutStore.showMobileChannels;
		if (!swipePreviewActive || swipePreviewTarget !== 'channels') return 'translateX(0)';
		if (channelsOpen) {
			return `translateX(${swipePreviewOffsetX}px)`;
		}
		return `translateX(calc(-100% + ${Math.max(0, swipePreviewOffsetX)}px))`;
	}

	function getUsersPreviewTransform(): string {
		const usersOpen = $layoutStore.rightPanelView !== 'none';
		if (!swipePreviewActive || swipePreviewTarget !== 'users') return 'translateX(0)';
		if (usersOpen) {
			return `translateX(${Math.max(0, swipePreviewOffsetX)}px)`;
		}
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
			style:left={$layoutStore.navDock !== 'right' ? `${SERVER_RAIL_WIDTH}px` : null}
			style:right={$layoutStore.navDock === 'right'
				? `${SERVER_RAIL_WIDTH + ($layoutStore.showRightPanel ? $layoutStore.rightPanelWidth : 0)}px`
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

	{#if !$layoutStore.isMobile}
		<div class="server-rail-container">
			<ServerRail on:manage={openServerSwitcher} />
		</div>
	{/if}

	<!-- Channel Sidebar (Left) -->
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
		<div
			class="resize-handle resize-handle-channel"
			on:mousedown|preventDefault={() => layoutStore.isResizingChannel.set(true)}
		></div>
	</div>

	{#if showServerSwitcher}
		<div
			class="server-switcher-overlay"
			class:mobile={$layoutStore.isMobile}
			class:dock-right={!$layoutStore.isMobile && $layoutStore.navDock === 'right'}
			style:width={!$layoutStore.isMobile ? `${SERVER_RAIL_WIDTH + Math.max($layoutStore.channelSidebarWidth, 320)}px` : null}
			style:right={!$layoutStore.isMobile && $layoutStore.navDock === 'right' && $layoutStore.showRightPanel ? `${$layoutStore.rightPanelWidth}px` : null}
		>
			<ServerSwitcherPanel mobile={$layoutStore.isMobile} on:close={closeServerSwitcher} />
		</div>
	{/if}

	<!-- Mobile Right Panel Overlay -->
	{#if mobileRightVisible || ($layoutStore.isMobile && swipePreviewActive && swipePreviewTarget === 'users')}
		<div
			class="mobile-right-overlay"
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
				{:else if isMapTabActive}
					<MapWorkspace variant="full" />
				{:else if activeView === 'following'}
					<FollowingFeed on:openChannel={() => (activeView = 'chat')} />
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

	<!-- Desktop Right Panel -->
	{#if $layoutStore.showRightPanel}
		<div
			class="right-panel-container"
			style:width="{$layoutStore.rightPanelWidth}px"
		>
			<!-- Right panel resize handle -->
			<div
				class="resize-handle resize-handle-right"
				on:mousedown|preventDefault={() => layoutStore.isResizingRight.set(true)}
			></div>
			<RightPanel on:openSettings={(event) => openSettings(event.detail?.paymentSurface ?? null)} />
		</div>
	{/if}

	<!-- Desktop toggle button (visible when panel is closed) -->
	{#if !$layoutStore.isMobile && !$layoutStore.showRightPanel}
		<button
			class="user-panel-toggle"
			class:has-unread={totalUnreadDMs > 0}
			data-unread={totalUnreadDMs > 99 ? '99+' : totalUnreadDMs}
			style:right={!$layoutStore.isMobile && $layoutStore.navDock === 'right' ? `${$layoutStore.channelSidebarWidth + SERVER_RAIL_WIDTH}px` : '0px'}
			on:click={layoutStore.toggleRightPanel}
			title={$_('shell.open_side_panel')}
		>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<polyline points="15 18 9 12 15 6"/>
			</svg>
		</button>

		{#if showDesktopNotificationRail && unreadDMChannels.length > 0}
			<div
				class="dm-notification-rail"
				style:right={!$layoutStore.isMobile && $layoutStore.navDock === 'right' ? `${$layoutStore.channelSidebarWidth + SERVER_RAIL_WIDTH}px` : '0px'}
				aria-label={$_('shell.unread_dms')}
			>
				{#each unreadDMChannels as channel, index (channel.id)}
					<button
						class="dm-notification-stub"
						style={`animation-delay: ${index * 0.04}s`}
						on:click={() => openUnreadDM(channel)}
						title={channel.type === 'group'
							? $_('shell.open_group', { values: { name: channel.name } })
							: $_('shell.open_dm_with', { values: { user: getChannelOtherUser(channel)?.username || $_('shell.user_fallback') } })}
					>
						{#if channel.type === 'group'}
							{#if channel.avatar}
								<img src={channel.avatar} alt={channel.name} class="dm-stub-avatar" />
							{:else}
								<div class="dm-stub-avatar dm-stub-fallback">{channel.name.charAt(0).toUpperCase()}</div>
							{/if}
						{:else}
							{@const other = getChannelOtherUser(channel)}
							{#if other?.profilePicture}
								<img src={other.profilePicture} alt={other.username} class="dm-stub-avatar" />
							{:else}
								<div class="dm-stub-avatar dm-stub-fallback" style="background-color: {other?.roleColor || other?.color || 'var(--text-secondary)'}">
									{other?.username?.charAt(0).toUpperCase() || '?'}
								</div>
							{/if}
						{/if}
						<span class="dm-stub-count">{formatUnreadBadge($channelUnreadCounts[channel.id] || 0)}</span>
					</button>
				{/each}
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

<style>
	:global(body) {
		overflow: hidden;
	}

	:global(:root) {
		--dm-rail-top: calc(env(safe-area-inset-top, 0px) + 86px);
		--mobile-nav-height: calc(56px + env(safe-area-inset-bottom, 0px));
	}
	.app-container {
		display: flex;
		height: 100vh;
		height: 100dvh;
		overflow: hidden;
		position: relative;
	}

	.app-container.in-call {
		height: 100vh;
		height: 100dvh;
	}

	.app-container.resizing {
		cursor: col-resize;
		user-select: none;
	}

	.main-content {
		flex: 1;
		min-width: 0;
		position: relative;
		min-height: 0;
	}

	.chat-stack {
		height: 100%;
		width: 100%;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.chat-surface {
		flex: 1;
		min-height: 0;
	}
	.hidden { display: none !important; }

	.server-rail-container {
		flex-shrink: 0;
		position: relative;
	}

	.channel-sidebar-container {
		flex-shrink: 0;
		position: relative;
		border-right: 1px solid rgba(var(--border-rgb), var(--opacity-light));
	}

	.app-container.nav-right .server-rail-container {
		order: 4;
	}

	.app-container.nav-right .channel-sidebar-container {
		order: 3;
		border-right: none;
		border-left: 1px solid rgba(var(--border-rgb), var(--opacity-light));
	}

	.app-container.nav-right .main-content {
		order: 1;
	}

	.app-container.nav-right .right-panel-container {
		order: 2;
	}

	.server-rail-container :global(.server-rail) {
		height: 100vh;
		height: 100dvh;
	}

	.app-container.nav-right .server-rail-container :global(.server-rail) {
		border-right: none;
		border-left: 1px solid rgba(var(--border-rgb), var(--opacity-light));
	}

	/* Hide border when sidebar is collapsed */
	.channel-sidebar-container[style*="width: 0px"],
	.channel-sidebar-container[style*="width:0px"] {
		border-right: none;
	}

	.app-container.nav-right .channel-sidebar-container[style*="width: 0px"],
	.app-container.nav-right .channel-sidebar-container[style*="width:0px"] {
		border-left: none;
	}

	/* Desktop Right Panel */
	.right-panel-container {
		flex-shrink: 0;
		position: relative;
		height: 100vh;
		height: 100dvh;
		background: var(--bg-secondary);
		border-left: 1px solid rgba(var(--border-rgb), var(--opacity-light));
	}

	/* Resize handles */
	.resize-handle {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 6px;
		cursor: col-resize;
		z-index: var(--z-sticky);
		transition: background 0.2s;
	}
	.resize-handle:hover { background: var(--accent); opacity: 0.5; }
	.resize-handle-channel { right: -3px; }
	.resize-handle-right { left: -3px; }

	.app-container.obvious-grab-rails .resize-handle {
		background: rgba(255, 176, 32, 0.35);
		outline: 1px solid rgba(255, 176, 32, 0.95);
		outline-offset: 0;
		box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.45);
		opacity: 1;
	}

	.app-container.obvious-grab-rails .resize-handle::after {
		content: '6px grab';
		position: absolute;
		top: 10px;
		left: 50%;
		transform: translateX(-50%) rotate(90deg);
		transform-origin: center;
		padding: 2px 5px;
		border-radius: 4px;
		font-size: 10px;
		line-height: 1;
		font-weight: 700;
		letter-spacing: 0.03em;
		color: #2f2200;
		background: rgba(255, 222, 122, 0.95);
		white-space: nowrap;
		pointer-events: none;
	}

	.app-container.nav-right .resize-handle-channel {
		right: auto;
		left: -3px;
	}

	.server-switcher-overlay {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		z-index: calc(var(--z-modal, 1200) - 2);
	}

	.server-switcher-overlay.dock-right {
		left: auto;
		right: 0;
	}

	.server-switcher-overlay.mobile {
		position: fixed;
		inset: 0;
		width: 100% !important;
		z-index: var(--z-modal, 1200);
	}

	/* Toggle button on right edge */
	.user-panel-toggle {
		position: absolute;
		top: 50%;
		right: 0;
		transform: translateY(-50%);
		width: 24px;
		height: 64px;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-right: none;
		border-radius: var(--radius-md) 0 0 var(--radius-md);
		cursor: pointer;
		color: var(--text-secondary);
		transition: all 0.2s ease;
		z-index: var(--z-sticky);
		opacity: 0.3;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.user-panel-toggle.has-unread::after {
		content: attr(data-unread);
		position: absolute;
		top: 6px;
		left: 4px;
		min-width: 16px;
		height: 16px;
		padding: 0 4px;
		border-radius: 999px;
		background: #ef4444;
		color: #fff;
		font-size: 0.68rem;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
		line-height: 1;
	}

	.dm-notification-rail {
		position: absolute;
		right: 0;
		top: var(--dm-rail-top);
		max-height: calc(100% - var(--dm-rail-top) - 84px);
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 8px;
		z-index: var(--z-sticky);
		opacity: 0;
		transform: translateX(22px);
		pointer-events: none;
		transition: opacity 0.2s ease, transform 0.2s ease;
	}

	.app-container:hover .dm-notification-rail,
	.dm-notification-rail:hover {
		opacity: 1;
		transform: translateX(0);
		pointer-events: auto;
	}

	.dm-notification-stub {
		position: relative;
		width: 40px;
		height: 40px;
		padding: 0;
		border: 1px solid rgba(var(--border-rgb), var(--opacity-light));
		border-right: none;
		border-radius: 12px 0 0 12px;
		background: var(--bg-secondary);
		cursor: pointer;
		overflow: hidden;
		animation: stub-slide-in 0.22s ease both;
	}

	.dm-notification-stub:hover {
		transform: translateX(-4px);
		border-color: var(--accent);
	}

	.dm-stub-avatar {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.dm-stub-fallback {
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 700;
		color: #fff;
		background: var(--text-secondary);
	}

	.dm-stub-count {
		position: absolute;
		top: -4px;
		right: -4px;
		min-width: 18px;
		height: 18px;
		padding: 0 4px;
		border-radius: 999px;
		background: #ef4444;
		color: #fff;
		font-size: 0.65rem;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 2px solid var(--bg-primary);
	}

	@keyframes stub-slide-in {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	.user-panel-toggle:hover {
		opacity: 1;
		background: var(--accent);
		color: white;
	}

	.nav-reopen-rail {
		position: absolute;
		top: 50%;
		left: 0;
		transform: translateY(-50%);
		width: 18px;
		height: 84px;
		background: color-mix(in srgb, var(--bg-secondary) 86%, black 14%);
		border: 1px solid var(--border);
		border-left: none;
		border-radius: 0 var(--radius-md) var(--radius-md) 0;
		color: var(--text-secondary);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: col-resize;
		z-index: var(--z-sticky);
		opacity: 0.75;
		transition: opacity 0.18s ease, background 0.18s ease, color 0.18s ease;
	}

	.nav-reopen-rail:hover {
		opacity: 1;
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.nav-reopen-rail.dock-right {
		left: auto;
		right: 0;
		border-left: 1px solid var(--border);
		border-right: none;
		border-radius: var(--radius-md) 0 0 var(--radius-md);
	}

	/* --- Mobile Styles --- */
	.mobile-bottom-nav { display: none; }
	.mobile-right-overlay { display: none; }
	.mobile-nav-grabber { display: none; }

	@media (max-width: 768px) {
		.app-container {
			height: 100vh;
			height: 100dvh;
		}
		.app-container.mobile-nav-visible {
			height: calc(100vh - var(--mobile-nav-height));
			height: calc(100dvh - var(--mobile-nav-height));
		}
		.app-container.in-call {
			height: 100vh;
			height: 100dvh;
		}
		.user-panel-toggle, .resize-handle { display: none; }
		.nav-reopen-rail { display: none; }
		.dm-notification-rail { display: none; }
		.server-rail-container { display: none; }

		.channel-sidebar-container,
		.right-panel-container {
			display: none;
			position: fixed;
			top: 0;
			left: 0;
			width: 100% !important;
			height: calc(100vh - var(--mobile-nav-height));
			height: calc(100dvh - var(--mobile-nav-height));
			z-index: var(--z-modal);
			background: var(--bg-primary);
		}

		.channel-sidebar-container.mobile-visible {
			display: block;
		}

		.channel-sidebar-container.preview-visible {
			display: block;
			pointer-events: none;
		}

		.mobile-right-overlay {
			display: flex;
			flex-direction: column;
			position: fixed;
			top: 0;
			left: 0;
			width: 100%;
			height: calc(100vh - var(--mobile-nav-height));
			height: calc(100dvh - var(--mobile-nav-height));
			z-index: var(--z-modal);
			background: var(--bg-primary);
			-ms-overflow-style: none;
			scrollbar-width: none;
		}

		.mobile-right-overlay.preview-visible {
			display: flex;
			pointer-events: none;
		}

		.mobile-right-overlay::-webkit-scrollbar {
			display: none;
			width: 0;
			height: 0;
		}

		.mobile-bottom-nav {
			display: flex;
			justify-content: space-around;
			align-items: center;
			position: fixed;
			bottom: 0;
			left: 0;
			right: 0;
			height: var(--mobile-nav-height);
			background: color-mix(in srgb, var(--bg-tertiary) 88%, black 12%);
			border-top: 1px solid var(--border);
			z-index: var(--z-toast);
			padding: 0;
			padding-bottom: env(safe-area-inset-bottom, 0);
			transform: translateY(100%);
			opacity: 0;
			pointer-events: none;
			transition: transform 0.2s ease, opacity 0.2s ease;
		}
		.mobile-bottom-nav.visible {
			transform: translateY(0);
			opacity: 1;
			pointer-events: auto;
		}
		.mobile-bottom-nav button {
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			flex: 1;
			gap: 0.125rem;
			background: transparent;
			border: none;
			color: var(--text-secondary);
			font-size: 0.62rem;
			padding: 0.34rem 0.45rem;
			transition: color 0.15s;
		}
		.mobile-bottom-nav button:hover { color: var(--text-primary); }
		.mobile-bottom-nav button.active { color: var(--accent); }
		.mobile-bottom-nav svg { width: 19px; height: 19px; stroke: currentColor; fill: none; stroke-width: 2; }

		.mobile-nav-grabber {
			display: flex;
			position: fixed;
			right: 8px;
			top: calc(env(safe-area-inset-top, 0) + 56px);
			width: 34px;
			height: 34px;
			border: none;
			border-radius: 10px;
			background: color-mix(in srgb, var(--bg-tertiary) 88%, black 12%);
			box-shadow: 0 4px 14px rgba(0, 0, 0, 0.24);
			align-items: center;
			justify-content: center;
			z-index: var(--z-toast);
			opacity: 0.88;
		}

		.mobile-nav-grabber span {
			display: block;
			width: 14px;
			height: 14px;
			border-radius: 999px;
			background: color-mix(in srgb, var(--text-secondary) 78%, white 22%);
			mask: linear-gradient(135deg, transparent 42%, #000 42% 58%, transparent 58%) center / 90% 90% no-repeat;
		}
	}

	@media (max-width: 1280px) {
		:global(:root) {
			--dm-rail-top: calc(env(safe-area-inset-top, 0px) + 96px);
		}
	}

	.voice-channel-strip {
		position: absolute;
		left: 16px;
		bottom: 12px;
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
		padding: 0.7rem;
		border-radius: 12px;
		min-width: 340px;
		background: rgba(0, 0, 0, 0.72);
		border: 1px solid rgba(var(--border-rgb), var(--opacity-medium));
		z-index: var(--z-toast);
		backdrop-filter: blur(8px);
	}

	.voice-status-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		background: transparent;
		border: none;
		color: var(--text-primary);
		padding: 0;
		cursor: pointer;
	}

	.status-leading {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.voice-status-text {
		display: inline-flex;
		flex-direction: column;
		line-height: 1.15;
		text-align: left;
	}

	.voice-status-text small {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.status-chevron {
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.voice-debug-grid {
		width: 100%;
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.45rem 0.7rem;
		padding: 0.5rem 0.55rem;
		border-radius: 9px;
		background: rgba(255, 255, 255, 0.06);
	}

	.debug-item {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		font-size: 0.72rem;
	}

	.debug-item span {
		color: var(--text-secondary);
	}

	.debug-item strong {
		color: var(--text-primary);
		font-size: 0.74rem;
	}

	.voice-channel-meta {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		color: var(--text-primary);
		font-size: 0.85rem;
		width: 100%;
	}

	.voice-channel-name-label {
		color: var(--text-secondary);
		font-size: 0.8rem;
	}

	.voice-channel-meta .dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #22c55e;
		box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.2);
	}


	.voice-channel-actions {
		display: flex;
		gap: 0.4rem;
		width: 100%;
		flex-wrap: wrap;
	}

	.voice-channel-actions button {
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.18);
		color: var(--text-primary);
		border-radius: 999px;
		padding: 0.25rem 0.55rem;
		font-size: 0.75rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		flex: 1 1 auto;
	}

	.voice-channel-actions button svg {
		width: 14px;
		height: 14px;
		display: block;
	}

	.voice-channel-actions button.active {
		background: rgba(var(--accent-rgb), 0.32);
	}

	.voice-channel-actions button.leave {
		background: rgba(239, 68, 68, 0.2);
		border-color: rgba(239, 68, 68, 0.5);
		flex: 0 0 auto;
	}

	@media (max-width: 768px) {
		.voice-channel-strip {
			left: 8px;
			right: 8px;
			bottom: calc(var(--mobile-nav-height) + 8px);
			min-width: 0;
			width: auto;
			max-height: min(58dvh, 420px);
			overflow-y: auto;
			padding: 0.6rem;
			gap: 0.55rem;
			-ms-overflow-style: none;
			scrollbar-width: none;
		}

		.voice-channel-strip::-webkit-scrollbar {
			display: none;
			width: 0;
			height: 0;
		}

		.voice-debug-grid {
			grid-template-columns: 1fr;
		}

		.voice-channel-actions button {
			flex: 1 1 calc(50% - 0.2rem);
			min-height: 40px;
		}

		.voice-channel-actions button.leave {
			flex: 1 1 100%;
		}

	}

</style>
