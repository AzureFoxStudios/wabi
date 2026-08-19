/**
 * layoutStoreNav.ts
 * Navigation dock and panel helpers
 */

import { get } from 'svelte/store';
import { navDock, channelSidebarWidth, showMobileChannels, isMobile, activeRightTab, rightPanelMode } from './layoutStoreStates';
import { DEFAULT_CONSTANTS } from './layoutStoreStates';
import { closeRightPanel, peekPanel } from './layoutStoreRightPanel';

export const setNavDock = (side: any) => {
	navDock.set(side);
};

export const toggleNavDock = () => {
	navDock.update((side) => (side === 'left' ? 'right' : 'left'));
};

export const collapseNav = () => {
	channelSidebarWidth.update((width) => {
		if (width <= 0) return width;
		return 0;
	});
};

export const expandNav = () => {
	channelSidebarWidth.update((width) => (width > 0 ? width : DEFAULT_CONSTANTS.NAV_WIDTH));
};

export const toggleNavCollapsed = () => {
	channelSidebarWidth.update((width) => (width > 0 ? 0 : DEFAULT_CONSTANTS.NAV_WIDTH));
};

export const toggleMobileChannels = () => {
	showMobileChannels.update((v) => !v);
	if (get(showMobileChannels)) {
		closeRightPanel();
	}
};

export const toggleMobileUsers = () => {
	if (get(rightPanelMode) !== 'none') {
		closeRightPanel();
		return;
	}
	showMobileChannels.set(false);
	peekPanel(get(activeRightTab));
};

export const resetPanelsOnDesktop = () => {
	if (!get(isMobile)) {
		closeRightPanel();
	}
};