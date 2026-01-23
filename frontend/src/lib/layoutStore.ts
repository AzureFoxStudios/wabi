// frontend/src/lib/layoutStore.ts
import { writable, readable, derived } from 'svelte/store';
import type { User } from './socket-types';

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

type RightPanelView = 'none' | 'dm-list' | 'dm';
const rightPanelView = writable<RightPanelView>('none');
const showMobileChannels = writable(false);

const channelSidebarWidth = writable(240);
const userPanelWidth = writable(250);
const dmPanelWidth = writable(350);

const isResizingChannel = writable(false);
const isResizingUser = writable(false);
const isResizingDM = writable(false);

const dmChannelId = writable<string | null>(null);
const dmOtherUser = writable<User | null>(null);

// Actions
const toggleDesktopUserPanel = () => {
	rightPanelView.update((current) => {
		if (current === 'dm-list') {
			return 'none';
		} else {
			return 'dm-list';
		}
	});
};

const openDM = (channelIdStr: string, otherUserObj: User) => {
	dmChannelId.set(channelIdStr);
	dmOtherUser.set(otherUserObj);
	rightPanelView.set('dm');
};

const closeDM = () => {
	dmChannelId.set(null);
	dmOtherUser.set(null);
	rightPanelView.update(current => get(isMobile) ? 'dm-list' : 'none');
};

const handleDMPanelBack = () => {
	rightPanelView.set('dm-list');
};

const toggleMobileChannels = () => {
	showMobileChannels.update(v => !v);
	if (get(showMobileChannels)) {
		rightPanelView.set('none');
	}
};

const toggleMobileUsers = () => {
	rightPanelView.update(current => {
		if (current === 'dm-list' || current === 'dm') {
			return 'none';
		} else {
			showMobileChannels.set(false);
			return 'dm-list';
		}
	});
};

const resetPanelsOnDesktop = () => {
    if(!get(isMobile)) {
        rightPanelView.set('none');
    }
}

// Derived stores
const isResizing = derived(
	[isResizingChannel, isResizingUser, isResizingDM],
	([$isResizingChannel, $isResizingUser, $isResizingDM]) =>
		$isResizingChannel || $isResizingUser || $isResizingDM
);

const layout = derived(
	[isMobile, rightPanelView, showMobileChannels, userPanelWidth, dmPanelWidth],
	([$isMobile, $rightPanelView, $showMobileChannels, $userPanelWidth, $dmPanelWidth]) => {
		const showDMListPanel = !$isMobile && $rightPanelView === 'dm-list';
		const showDMPanel = !$isMobile && $rightPanelView === 'dm';

		return {
			isMobile: $isMobile,
			rightPanelView: $rightPanelView,
			showMobileChannels: $isMobile && $showMobileChannels,
			showDMListPanel,
			showDMPanel,
			toggleButtonRight: (showDMListPanel ? $userPanelWidth : 0) + (showDMPanel ? $dmPanelWidth : 0)
		};
	}
);

export const layoutStore = {
	subscribe: layout.subscribe,
    isResizing: { subscribe: isResizing.subscribe },
	channelSidebarWidth,
	userPanelWidth,
	dmPanelWidth,
	isResizingChannel,
	isResizingUser,
	isResizingDM,
	dmChannelId,
	dmOtherUser,
    rightPanelView,
    showMobileChannels,

	// Actions
	toggleDesktopUserPanel,
	openDM,
	closeDM,
	handleDMPanelBack,
	toggleMobileChannels,
	toggleMobileUsers,
    resetPanelsOnDesktop,
};
