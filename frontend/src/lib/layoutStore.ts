/**
 * layoutStore.ts (unified re-export)
 * Maintains 100% backward compatibility
 *
 * Re-exports from:
 * - layoutStoreStates.ts: State store definitions
 * - layoutStoreUtils.ts: Utility functions
 * - layoutStoreSync.ts: Loading and persistence
 * - layoutStoreWorkspace.ts: Workspace management
 * - layoutStoreRightPanel.ts: Right panel operations
 * - layoutStoreNav.ts: Navigation and panel helpers
 */

import { derived, get } from 'svelte/store';
import { browser } from '$app/environment';
import { isInCall } from '$lib/calling';
import {
	isMobile,
	layoutState,
	activeWorkspace,
	navDock,
	rightPanelView,
	activeRightTab,
	rightPanelDock,
	showMobileChannels,
	detachedPanelIds,
	channelSidebarWidth,
	rightPanelWidth,
	isResizingChannel,
	isResizingRight,
	selectedDmChannelId,
	dmOtherUser,
	selectedGroupChannel,
	obviousGrabRails,
	NOTES_DM_ID,
	setLayoutLoaded,
	DEFAULT_CONSTANTS
} from './layoutStoreStates';
import {
	toggleRightPanel,
	openRightPanel,
	setActiveRightPanel,
	updateRightPanelDock,
	moveRightPanelTab,
	splitRightPanelTab,
	resizeRightPanelStacks,
	toggleRightPanelStackCollapsed,
	toggleRightPanelStackPinned,
	resetRightPanelDock
} from './layoutStoreRightPanel';
import {
	setNavDock,
	toggleNavDock,
	collapseNav,
	expandNav,
	expandRight,
	toggleNavCollapsed,
	toggleMobileChannels,
	toggleMobileUsers,
	resetPanelsOnDesktop,
	detachPanel,
	dockPanel,
	isPanelDetached
} from './layoutStoreNav';
import {
	setActiveWorkspace,
	saveWorkspace,
	renameWorkspace,
	resetWorkspace
} from './layoutStoreWorkspace';
import {
	loadLayoutState,
	queuePersist,
	resetAllLayouts,
	exportLayoutJson,
	importLayoutJson
} from './layoutStoreSync';

// ============================================================================
// INITIALIZATION
// ============================================================================

if (browser) {
	try {
		obviousGrabRails.set(localStorage.getItem(DEFAULT_CONSTANTS.GRAB_RAILS_KEY) === 'true');
	} catch {
		obviousGrabRails.set(false);
	}
	void loadLayoutState();

	obviousGrabRails.subscribe((enabled) => {
		try {
			localStorage.setItem(DEFAULT_CONSTANTS.GRAB_RAILS_KEY, enabled ? 'true' : 'false');
		} catch {
			// Best effort only.
		}
	});
}

layoutState.subscribe((state) => {
	if (!get({ layoutLoaded: true })) return;
	activeWorkspace.set(state.activeWorkspace);
});

channelSidebarWidth.subscribe(() => queuePersist());
rightPanelWidth.subscribe(() => queuePersist());
rightPanelView.subscribe(() => queuePersist());
rightPanelDock.subscribe(() => queuePersist());
navDock.subscribe(() => queuePersist());

// ============================================================================
// HELPER FUNCTIONS FOR PANELS
// ============================================================================

const showUsersTab = () => {
	openRightPanel('users');
};

const showDMsTab = () => {
	openRightPanel('dms');
};

const showAdminTab = () => {
	openRightPanel('admin');
};

const showMediaTab = () => {
	openRightPanel('media');
};

const showMapTab = () => {
	openRightPanel('map');
};

const showNotesTab = () => {
	openRightPanel('notes');
};

const openDM = (channelIdStr: string, otherUserObj: any) => {
	selectedDmChannelId.set(channelIdStr);
	dmOtherUser.set(otherUserObj);
	selectedGroupChannel.set(null);
	openRightPanel('dms');
};

const openGroupDM = (channelIdStr: string, channel: any) => {
	selectedDmChannelId.set(channelIdStr);
	dmOtherUser.set(null);
	selectedGroupChannel.set(channel);
	openRightPanel('dms');
};

const openNotes = () => {
	selectedDmChannelId.set(NOTES_DM_ID);
	dmOtherUser.set({
		id: 'notes',
		username: 'Notes',
		color: '#28b463',
		status: 'active'
	});
	selectedGroupChannel.set(null);
	openRightPanel('dms');
};

const closeDM = () => {
	selectedDmChannelId.set(null);
	dmOtherUser.set(null);
	selectedGroupChannel.set(null);
};

// ============================================================================
// DOCK ACTIONS
// ============================================================================

const dockActions = {
	dock(moduleId: string, zone: string) {
		if (moduleId === 'nav' || moduleId === 'gate-switcher') {
			if (zone === 'left' || zone === 'right') {
				setNavDock(zone);
			}
		}
	},
	split() {
		// Phase 2: nested splits.
	},
	tabify() {
		// Phase 1.5: tab re-parenting.
	},
	collapse(zone: string) {
		if (zone === 'left' || zone === 'right') {
			const side = get(navDock);
			if (zone === side) {
				collapseNav();
			} else {
				rightPanelView.set('none');
			}
		}
	},
	reset(workspaceName: string) {
		resetWorkspace(workspaceName);
	},
	saveWorkspace(name: string) {
		saveWorkspace(name);
	},
	loadWorkspace(name: string) {
		setActiveWorkspace(name);
	}
};

// ============================================================================
// DERIVED STORES
// ============================================================================

const isResizing = derived([isResizingChannel, isResizingRight], ([$isResizingChannel, $isResizingRight]) => {
	return $isResizingChannel || $isResizingRight;
});

const layout = derived(
	[
		isMobile,
		rightPanelView,
		showMobileChannels,
		channelSidebarWidth,
		rightPanelWidth,
		isInCall,
		activeRightTab,
		rightPanelDock,
		selectedDmChannelId,
		dmOtherUser,
		selectedGroupChannel,
		isResizing,
		navDock,
		activeWorkspace,
		layoutState,
		obviousGrabRails,
		detachedPanelIds
	],
	([
		$isMobile,
		$rightPanelView,
		$showMobileChannels,
		$channelSidebarWidth,
		$rightPanelWidth,
		$isInCall,
		$activeRightTab,
		$rightPanelDock,
		$selectedDmChannelId,
		$dmOtherUser,
		$selectedGroupChannel,
		$isResizing,
		$navDock,
		$activeWorkspace,
		$layoutState,
		$obviousGrabRails,
		$detachedPanelIds
	]) => {
		const showRightPanel = !$isMobile && $rightPanelView !== 'none';

		return {
			isMobile: $isMobile,
			isInCall: $isInCall,
			rightPanelView: $rightPanelView,
			activeRightTab: $activeRightTab,
			rightPanelDock: $rightPanelDock,
			showMobileChannels: $isMobile && $showMobileChannels,
			showRightPanel,
			channelSidebarWidth: $channelSidebarWidth,
			rightPanelWidth: $rightPanelWidth,
			toggleButtonRight: showRightPanel ? $rightPanelWidth : 0,
			selectedDmChannelId: $selectedDmChannelId,
			dmOtherUser: $dmOtherUser,
			selectedGroupChannel: $selectedGroupChannel,
			isResizing: $isResizing,
			navDock: $navDock,
			isNavCollapsed: $channelSidebarWidth <= 0,
			activeWorkspace: $activeWorkspace,
			workspaces: Object.keys($layoutState.workspaces),
			layoutVersion: $layoutState.layoutVersion,
			obviousGrabRails: $obviousGrabRails,
			detachedPanelIds: $detachedPanelIds
		};
	}
);

// ============================================================================
// PUBLIC API
// ============================================================================

export const layoutStore = {
	subscribe: layout.subscribe,
	layoutState: { subscribe: layoutState.subscribe },
	activeWorkspace: { subscribe: activeWorkspace.subscribe },
	dockActions,
	navDock,
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
	rightPanelDock,
	showMobileChannels,
	detachedPanelIds,
	obviousGrabRails,

	// Right panel actions
	toggleRightPanel,
	showUsersTab,
	showDMsTab,
	showAdminTab,
	showMediaTab,
	showMapTab,
	showNotesTab,
	openRightPanel,
	setActiveRightPanel,
	openDM,
	openGroupDM,
	openNotes,
	closeDM,
	toggleMobileChannels,
	toggleMobileUsers,
	resetPanelsOnDesktop,

	// Navigation actions
	setNavDock,
	toggleNavDock,
	collapseNav,
	expandNav,
	expandRight,
	toggleNavCollapsed,

	// Workspace actions
	saveWorkspace,
	loadWorkspace: setActiveWorkspace,
	renameWorkspace,
	resetWorkspace,
	resetAllLayouts,
	exportLayoutJson,
	importLayoutJson,

	// Panel operations
	moveRightPanelTab,
	splitRightPanelTab,
	resizeRightPanelStacks,
	toggleRightPanelStackCollapsed,
	toggleRightPanelStackPinned,
	resetRightPanelDock,
	detachPanel,
	dockPanel,
	isPanelDetached,
	setObviousGrabRails: (enabled: boolean) => obviousGrabRails.set(Boolean(enabled))
};
