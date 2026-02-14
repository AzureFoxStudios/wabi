// frontend/src/lib/layoutStore.ts
import { writable, readable, derived, get } from 'svelte/store';
import type { User, Channel } from './socket-types';
import { isInCall } from '$lib/calling';

// State
const isMobile = readable(false, (set) => {
	if (typeof window === 'undefined') {
		return;
	}
	const mql = window.matchMedia('(max-width: 768px)');
	set(mql.matches);
	const listener = (e: MediaQueryListEvent) => set(e.matches);
	mql.addEventListener('change', listener);
	return () => mql.removeEventListener('change', listener);
});

type RightPanelView = 'none' | 'users' | 'dms';
const rightPanelView = writable<RightPanelView>('none');
const activeRightTab = writable<'users' | 'dms'>('users');
const showMobileChannels = writable(false);

const channelSidebarWidth = writable(280);
const rightPanelWidth = writable(320);

const isResizingChannel = writable(false);
const isResizingRight = writable(false);

const selectedDmChannelId = writable<string | null>(null);
const dmOtherUser = writable<User | null>(null);
const selectedGroupChannel = writable<Channel | null>(null);

// Actions
const toggleRightPanel = () => {
	rightPanelView.update((current) => {
		if (current === 'none') {
			return get(activeRightTab);
		}
		return 'none';
	});
};

const showUsersTab = () => {
	activeRightTab.set('users');
	rightPanelView.set('users');
};

const showDMsTab = () => {
	activeRightTab.set('dms');
	rightPanelView.set('dms');
};

const openDM = (channelIdStr: string, otherUserObj: User) => {
	selectedDmChannelId.set(channelIdStr);
	dmOtherUser.set(otherUserObj);
	selectedGroupChannel.set(null);
	activeRightTab.set('dms');
	rightPanelView.set('dms');
};

const openGroupDM = (channelIdStr: string, channel: Channel) => {
	selectedDmChannelId.set(channelIdStr);
	dmOtherUser.set(null);
	selectedGroupChannel.set(channel);
	activeRightTab.set('dms');
	rightPanelView.set('dms');
};

const closeDM = () => {
	selectedDmChannelId.set(null);
	dmOtherUser.set(null);
	selectedGroupChannel.set(null);
};

const toggleMobileChannels = () => {
	showMobileChannels.update(v => !v);
	if (get(showMobileChannels)) {
		rightPanelView.set('none');
	}
};

const toggleMobileUsers = () => {
	rightPanelView.update(current => {
		if (current !== 'none') {
			return 'none';
		} else {
			showMobileChannels.set(false);
			return get(activeRightTab);
		}
	});
};

const resetPanelsOnDesktop = () => {
	if (!get(isMobile)) {
		rightPanelView.set('none');
	}
};

// Derived stores
const isResizing = derived(
	[isResizingChannel, isResizingRight],
	([$isResizingChannel, $isResizingRight]) =>
		$isResizingChannel || $isResizingRight
);

const layout = derived(
	[isMobile, rightPanelView, showMobileChannels, channelSidebarWidth, rightPanelWidth, isInCall, activeRightTab, selectedDmChannelId, dmOtherUser, selectedGroupChannel, isResizing],
	([$isMobile, $rightPanelView, $showMobileChannels, $channelSidebarWidth, $rightPanelWidth, $isInCall, $activeRightTab, $selectedDmChannelId, $dmOtherUser, $selectedGroupChannel, $isResizing]) => {
		const showRightPanel = !$isMobile && $rightPanelView !== 'none';

		return {
			isMobile: $isMobile,
			isInCall: $isInCall,
			rightPanelView: $rightPanelView,
			activeRightTab: $activeRightTab,
			showMobileChannels: $isMobile && $showMobileChannels,
			showRightPanel,
			channelSidebarWidth: $channelSidebarWidth,
			rightPanelWidth: $rightPanelWidth,
			toggleButtonRight: showRightPanel ? $rightPanelWidth : 0,
			selectedDmChannelId: $selectedDmChannelId,
			dmOtherUser: $dmOtherUser,
			selectedGroupChannel: $selectedGroupChannel,
			isResizing: $isResizing
		};
	}
);

export const layoutStore = {
	subscribe: layout.subscribe,
	isResizing: { subscribe: isResizing.subscribe },
	channelSidebarWidth,
	rightPanelWidth,
	isResizingChannel,
	isResizingRight,
	selectedDmChannelId,
	dmOtherUser,
	selectedGroupChannel,
	rightPanelView,
	activeRightTab,
	showMobileChannels,

	// Actions
	toggleRightPanel,
	showUsersTab,
	showDMsTab,
	openDM,
	openGroupDM,
	closeDM,
	toggleMobileChannels,
	toggleMobileUsers,
	resetPanelsOnDesktop,
};
