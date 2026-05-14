/**
 * layoutStoreNav.ts
 * Navigation dock and panel helpers
 */

import { get } from 'svelte/store';
import { type WorkspacePanelId } from '$lib/docking/layoutSchema';
import { navDock, channelSidebarWidth, rightPanelView, showMobileChannels, detachedPanelIds, isMobile, activeRightTab } from './layoutStoreStates';
import { DEFAULT_CONSTANTS } from './layoutStoreStates';
import { scheduleSyncWorkspace } from './layoutStoreSync';

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

export const expandRight = () => {
	const { rightPanelWidth } = require('./layoutStoreStates');
	rightPanelWidth.update((width: number) => (width > 0 ? width : DEFAULT_CONSTANTS.RIGHT_WIDTH));
};

export const toggleNavCollapsed = () => {
	channelSidebarWidth.update((width) => (width > 0 ? 0 : DEFAULT_CONSTANTS.NAV_WIDTH));
};

export const toggleMobileChannels = () => {
	showMobileChannels.update((v) => !v);
	if (get(showMobileChannels)) {
		rightPanelView.set('none');
	}
};

export const toggleMobileUsers = () => {
	rightPanelView.update((current) => {
		if (current !== 'none') {
			return 'none';
		}
		showMobileChannels.set(false);
		return get(activeRightTab);
	});
};

export const resetPanelsOnDesktop = () => {
	if (!get(isMobile)) {
		rightPanelView.set('none');
	}
};

export function detachPanel(panelId: WorkspacePanelId): void {
	detachedPanelIds.update((set) => {
		const next = new Set(set);
		next.add(panelId);
		return next;
	});
}

export function dockPanel(panelId: WorkspacePanelId): void {
	detachedPanelIds.update((set) => {
		const next = new Set(set);
		next.delete(panelId);
		return next;
	});
}

export function isPanelDetached(panelId: WorkspacePanelId): boolean {
	return get(detachedPanelIds).has(panelId);
}
