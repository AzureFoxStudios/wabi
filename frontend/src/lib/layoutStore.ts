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
	centerPanelView,
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
	centerDmChannelId,
	selectedGroupChannel,
	pinnedDmChannelId,
	pinnedDmOtherUser,
	obviousGrabRails,
	NOTES_DM_ID,
	layoutLoaded,
	setLayoutLoaded,
	DEFAULT_CONSTANTS,
	isApplyingLayout
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
	mergeRightPanelStack,
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
	scheduleSyncWorkspace,
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
	if (!layoutLoaded) return;
	activeWorkspace.set(state.activeWorkspace);
});

channelSidebarWidth.subscribe(() => {
	queuePersist();
	if (!isApplyingLayout) scheduleSyncWorkspace();
});
rightPanelWidth.subscribe(() => queuePersist());
rightPanelView.subscribe(() => queuePersist());
rightPanelDock.subscribe(() => queuePersist());
navDock.subscribe(() => {
	queuePersist();
	if (!isApplyingLayout) scheduleSyncWorkspace();
});

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

const showAdminCenterStage = () => {
	centerPanelView.set('admin');
};

/** N3: full-width notes center stage (same storage key as right-panel KeepNotes). */
const showNotesCenterStage = () => {
	// Clear stale NOTES_DM_ID selection if any older path left it set.
	if (get(selectedDmChannelId) === NOTES_DM_ID) {
		selectedDmChannelId.set(null);
		dmOtherUser.set(null);
	}
	selectedGroupChannel.set(null);
	centerPanelView.set('notes');
};

const setCenterPanelView = (view: 'chat' | 'admin' | 'notes') => {
	centerPanelView.set(view);
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

const openDM = (channelIdStr: string, otherUserObj: any, target: 'center' | 'right' = 'right') => {
	if (target === 'center') {
		centerDmChannelId.set(channelIdStr);
		dmOtherUser.set(otherUserObj);
		selectedGroupChannel.set(null);
	} else {
		selectedDmChannelId.set(channelIdStr);
		dmOtherUser.set(otherUserObj);
		selectedGroupChannel.set(null);
		openRightPanel('dms');
	}
};

const openGroupDM = (channelIdStr: string, channel: any, target: 'center' | 'right' = 'right') => {
	if (target === 'center') {
		centerDmChannelId.set(channelIdStr);
		dmOtherUser.set(null);
		selectedGroupChannel.set(channel);
	} else {
		selectedDmChannelId.set(channelIdStr);
		dmOtherUser.set(null);
		selectedGroupChannel.set(channel);
		openRightPanel('dms');
	}
};

const openCenterDm = (channelIdStr: string, otherUserObj: any) => openDM(channelIdStr, otherUserObj, 'center');
const openCenterGroupDm = (channelIdStr: string, channel: any) => openGroupDM(channelIdStr, channel, 'center');
const closeCenterDm = () => {
	centerDmChannelId.set(null);
};

	/** N2: open the real notes workspace panel — not a fake DM conversation. */
	const openNotes = () => {
		// Clear stale NOTES_DM_ID selection if any older path left it set.
		if (get(selectedDmChannelId) === NOTES_DM_ID) {
			selectedDmChannelId.set(null);
			dmOtherUser.set(null);
		}
		selectedGroupChannel.set(null);
		openRightPanel('notes');
	};

const closeDM = () => {
	selectedDmChannelId.set(null);
	dmOtherUser.set(null);
	selectedGroupChannel.set(null);
};

const pinToAux = (channelId: string, otherUser: any) => {
	pinnedDmChannelId.set(channelId);
	pinnedDmOtherUser.set(otherUser);
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
		centerDmChannelId,
		pinnedDmChannelId,
		dmOtherUser,
		pinnedDmOtherUser,
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
		$centerDmChannelId,
		$pinnedDmChannelId,
		$dmOtherUser,
		$pinnedDmOtherUser,
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
			centerDmChannelId: $centerDmChannelId,
			pinnedDmChannelId: $pinnedDmChannelId,
			dmOtherUser: $dmOtherUser,
			pinnedDmOtherUser: $pinnedDmOtherUser,
			selectedGroupChannel: $selectedGroupChannel,
			isResizing: $isResizing,
			navDock: $navDock,
			isNavCollapsed: $channelSidebarWidth <= 0,
			activeWorkspace: $activeWorkspace,
			workspaces: Object.keys($layoutState.workspaces ?? {}),
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
	centerDmChannelId,
	pinnedDmChannelId,
	dmOtherUser,
	pinnedDmOtherUser,
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
	showAdminCenterStage,
	showNotesCenterStage,
	setCenterPanelView,
	showMediaTab,
	showMapTab,
	showNotesTab,
	openRightPanel,
	setActiveRightPanel,
	openDM,
	openGroupDM,
	openCenterDm,
	openCenterGroupDm,
	closeCenterDm,
	openNotes,
	closeDM,
	pinToAux,
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
	mergeRightPanelStack,
	resetRightPanelDock,
	detachPanel,
	dockPanel,
	isPanelDetached,
	setObviousGrabRails: (enabled: boolean) => obviousGrabRails.set(Boolean(enabled))
};


export { NOTES_DM_ID };
