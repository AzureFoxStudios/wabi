import { browser } from '$app/environment';
import { writable, readable, derived, get } from 'svelte/store';
import type { User, Channel } from './socket-types';
import { isInCall } from '$lib/calling';
import {
	buildPhase1Root,
	cloneWorkspace,
	createDefaultLayoutState,
	createDefaultWorkspaceLayout,
	deserializeLayoutState,
	getAuxTabset,
	getNavTabset,
	getWorkspace,
	migrateLayoutState,
	serializeLayoutState,
	type DockActions,
	type DockSide,
	type LayoutStateV1,
	type WorkspaceLayoutV1
} from '$lib/docking/layoutSchema';
import {
	clearPersistedLayoutState,
	loadPersistedLayoutState,
	persistLayoutState
} from '$lib/docking/layoutPersistence';

type RightPanelView = 'none' | 'users' | 'dms' | 'admin' | 'media';
type RightPanelTab = 'users' | 'dms' | 'admin' | 'media';
export const NOTES_DM_ID = '__keep_notes__';

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

const DEFAULT_NAV_WIDTH = 280;
const DEFAULT_RIGHT_WIDTH = 320;
const MIN_RIGHT_WIDTH = 220;
const OBVIOUS_GRAB_RAILS_KEY = 'wabi:obvious-grab-rails';

const layoutState = writable<LayoutStateV1>(createDefaultLayoutState());
const activeWorkspace = writable('default');
const navDock = writable<DockSide>('left');
const rightPanelView = writable<RightPanelView>('none');
const activeRightTab = writable<RightPanelTab>('users');
const showMobileChannels = writable(false);

const channelSidebarWidth = writable(DEFAULT_NAV_WIDTH);
const rightPanelWidth = writable(DEFAULT_RIGHT_WIDTH);
const isResizingChannel = writable(false);
const isResizingRight = writable(false);

const selectedDmChannelId = writable<string | null>(null);
const dmOtherUser = writable<User | null>(null);
const selectedGroupChannel = writable<Channel | null>(null);
const obviousGrabRails = writable(false);

let isApplyingLayout = false;
let layoutLoaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function queuePersist() {
	if (!browser || !layoutLoaded) return;
	if (persistTimer) {
		clearTimeout(persistTimer);
	}
	persistTimer = setTimeout(() => {
		persistTimer = null;
		void persistLayoutState(get(layoutState));
	}, 140);
}

function withActiveWorkspace(mutator: (workspace: WorkspaceLayoutV1) => WorkspaceLayoutV1): void {
	layoutState.update((state) => {
		const current = state.workspaces[state.activeWorkspace] || createDefaultWorkspaceLayout(state.activeWorkspace);
		const next = mutator(current);
		return {
			...state,
			workspaces: {
				...state.workspaces,
				[next.name]: next
			},
			activeWorkspace: next.name,
			updatedAt: Date.now()
		};
	});
}

function applyWorkspaceToRuntime(workspace: WorkspaceLayoutV1): void {
	isApplyingLayout = true;
	navDock.set(workspace.navDock);

	const nav = getNavTabset(workspace);
	const aux = getAuxTabset(workspace);

	channelSidebarWidth.set(nav.collapsed ? 0 : nav.size);
	rightPanelWidth.set(aux.size);

	if (!get(isMobile)) {
		if (aux.collapsed) {
			rightPanelView.set('none');
		} else if (get(rightPanelView) === 'none') {
			rightPanelView.set(get(activeRightTab));
		}
	}

	activeWorkspace.set(workspace.name);
	isApplyingLayout = false;
}

function syncWorkspaceFromRuntime(): void {
	if (isApplyingLayout || !layoutLoaded) return;

	withActiveWorkspace((workspace) => {
		const side = get(navDock);
		const navTab = getNavTabset(workspace);
		const auxTab = getAuxTabset(workspace);

		const runtimeNavWidth = get(channelSidebarWidth);
		const runtimeAuxWidth = get(rightPanelWidth);
		const auxOpen = get(rightPanelView) !== 'none';

		const nextNavSize = runtimeNavWidth > 0 ? runtimeNavWidth : navTab.size || DEFAULT_NAV_WIDTH;
		const nextAuxSize = runtimeAuxWidth > 0 ? runtimeAuxWidth : auxTab.size || DEFAULT_RIGHT_WIDTH;

		return {
			...workspace,
			navDock: side,
			root: buildPhase1Root(
				side,
				nextNavSize,
				runtimeNavWidth <= 0,
				nextAuxSize,
				!auxOpen || runtimeAuxWidth <= 0
			),
			updatedAt: Date.now()
		};
	});

	queuePersist();
}

async function loadLayoutState(): Promise<void> {
	if (!browser) return;
	try {
		const persisted = await loadPersistedLayoutState();
		const migrated = migrateLayoutState(persisted);
		layoutState.set(migrated);
		activeWorkspace.set(migrated.activeWorkspace);
		applyWorkspaceToRuntime(getWorkspace(migrated));
	} catch (error) {
		console.warn('[Docking] Layout recovery fell back to defaults:', error);
		const fallback = createDefaultLayoutState();
		layoutState.set(fallback);
		activeWorkspace.set('default');
		applyWorkspaceToRuntime(getWorkspace(fallback));
		void persistLayoutState(fallback);
	} finally {
		layoutLoaded = true;
	}
}

if (browser) {
	try {
		obviousGrabRails.set(localStorage.getItem(OBVIOUS_GRAB_RAILS_KEY) === 'true');
	} catch {
		obviousGrabRails.set(false);
	}
	void loadLayoutState();

	obviousGrabRails.subscribe((enabled) => {
		try {
			localStorage.setItem(OBVIOUS_GRAB_RAILS_KEY, enabled ? 'true' : 'false');
		} catch {
			// Best effort only.
		}
	});
}

layoutState.subscribe((state) => {
	if (!layoutLoaded || isApplyingLayout) return;
	activeWorkspace.set(state.activeWorkspace);
});

channelSidebarWidth.subscribe(() => syncWorkspaceFromRuntime());
rightPanelWidth.subscribe(() => syncWorkspaceFromRuntime());
rightPanelView.subscribe(() => syncWorkspaceFromRuntime());
navDock.subscribe(() => syncWorkspaceFromRuntime());

const toggleRightPanel = () => {
	rightPanelView.update((current) => {
		if (current === 'none') {
			if (get(rightPanelWidth) < MIN_RIGHT_WIDTH) {
				rightPanelWidth.set(DEFAULT_RIGHT_WIDTH);
			}
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

const showAdminTab = () => {
	activeRightTab.set('admin');
	rightPanelView.set('admin');
};

const showMediaTab = () => {
	activeRightTab.set('media');
	rightPanelView.set('media');
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

const openNotes = () => {
	selectedDmChannelId.set(NOTES_DM_ID);
	dmOtherUser.set({
		id: 'notes',
		username: 'Notes',
		color: '#28b463',
		status: 'active'
	});
	selectedGroupChannel.set(null);
	activeRightTab.set('dms');
	rightPanelView.set('dms');
};

const closeDM = () => {
	selectedDmChannelId.set(null);
	dmOtherUser.set(null);
	selectedGroupChannel.set(null);
};

const toggleMobileChannels = () => {
	showMobileChannels.update((v) => !v);
	if (get(showMobileChannels)) {
		rightPanelView.set('none');
	}
};

const toggleMobileUsers = () => {
	rightPanelView.update((current) => {
		if (current !== 'none') {
			return 'none';
		}
		showMobileChannels.set(false);
		return get(activeRightTab);
	});
};

const resetPanelsOnDesktop = () => {
	if (!get(isMobile)) {
		rightPanelView.set('none');
	}
};

const setNavDock = (side: DockSide) => {
	navDock.set(side);
};

const toggleNavDock = () => {
	navDock.update((side) => (side === 'left' ? 'right' : 'left'));
};

const collapseNav = () => {
	channelSidebarWidth.update((width) => {
		if (width <= 0) return width;
		return 0;
	});
};

const expandNav = () => {
	channelSidebarWidth.update((width) => (width > 0 ? width : DEFAULT_NAV_WIDTH));
};

const toggleNavCollapsed = () => {
	channelSidebarWidth.update((width) => (width > 0 ? 0 : DEFAULT_NAV_WIDTH));
};

function setActiveWorkspace(name: string): void {
	const trimmed = name.trim();
	if (!trimmed) return;
	layoutState.update((state) => {
		if (!state.workspaces[trimmed]) return state;
		return {
			...state,
			activeWorkspace: trimmed,
			updatedAt: Date.now()
		};
	});

	const workspace = get(layoutState).workspaces[trimmed];
	if (workspace) {
		applyWorkspaceToRuntime(workspace);
		queuePersist();
	}
}

function saveWorkspace(name: string): void {
	const trimmed = name.trim();
	if (!trimmed) return;
	const state = get(layoutState);
	const current = getWorkspace(state);
	const nextWorkspace = cloneWorkspace(current, trimmed);
	layoutState.update((prev) => ({
		...prev,
		activeWorkspace: trimmed,
		workspaces: {
			...prev.workspaces,
			[trimmed]: nextWorkspace
		},
		updatedAt: Date.now()
	}));
	applyWorkspaceToRuntime(nextWorkspace);
	queuePersist();
}

function renameWorkspace(oldName: string, nextName: string): void {
	const source = oldName.trim();
	const target = nextName.trim();
	if (!source || !target || source === target) return;
	layoutState.update((state) => {
		const existing = state.workspaces[source];
		if (!existing) return state;

		const workspaces = { ...state.workspaces };
		delete workspaces[source];
		workspaces[target] = cloneWorkspace(existing, target);

		return {
			...state,
			workspaces,
			activeWorkspace: state.activeWorkspace === source ? target : state.activeWorkspace,
			updatedAt: Date.now()
		};
	});

	const maybeActive = get(layoutState).workspaces[target];
	if (maybeActive && get(activeWorkspace) === target) {
		applyWorkspaceToRuntime(maybeActive);
	}
	queuePersist();
}

function resetWorkspace(name?: string): void {
	const target = (name || get(activeWorkspace) || 'default').trim();
	const isKnownPreset = target === 'default' || target === 'focus' || target === 'mod';
	const fallbackName = isKnownPreset ? target : 'default';
	const reset = createDefaultWorkspaceLayout(fallbackName);

	layoutState.update((state) => ({
		...state,
		activeWorkspace: target,
		workspaces: {
			...state.workspaces,
			[target]: {
				...reset,
				name: target
			}
		},
		updatedAt: Date.now()
	}));

	applyWorkspaceToRuntime(get(layoutState).workspaces[target]);
	queuePersist();
}

async function resetAllLayouts(): Promise<void> {
	const defaults = createDefaultLayoutState();
	layoutState.set(defaults);
	applyWorkspaceToRuntime(getWorkspace(defaults));
	await clearPersistedLayoutState();
}

function importLayoutJson(jsonText: string): boolean {
	const trimmed = jsonText.trim();
	if (!trimmed) return false;
	try {
		JSON.parse(trimmed);
		const next = deserializeLayoutState(trimmed);
		layoutState.set(next);
		applyWorkspaceToRuntime(getWorkspace(next));
		queuePersist();
		return true;
	} catch {
		return false;
	}
}

function exportLayoutJson(): string {
	return serializeLayoutState(get(layoutState));
}

const dockActions: DockActions = {
	dock(moduleId, zone) {
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
	collapse(zone) {
		if (zone === 'left' || zone === 'right') {
			const side = get(navDock);
			if (zone === side) {
				collapseNav();
			} else {
				rightPanelView.set('none');
			}
		}
	},
	reset(workspaceName) {
		resetWorkspace(workspaceName);
	},
	saveWorkspace(name) {
		saveWorkspace(name);
	},
	loadWorkspace(name) {
		setActiveWorkspace(name);
	}
};

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
		selectedDmChannelId,
		dmOtherUser,
		selectedGroupChannel,
		isResizing,
		navDock,
			activeWorkspace,
			layoutState,
			obviousGrabRails
		],
		([
		$isMobile,
		$rightPanelView,
		$showMobileChannels,
		$channelSidebarWidth,
		$rightPanelWidth,
		$isInCall,
		$activeRightTab,
		$selectedDmChannelId,
		$dmOtherUser,
		$selectedGroupChannel,
		$isResizing,
			$navDock,
			$activeWorkspace,
			$layoutState,
			$obviousGrabRails
		]) => {
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
			isResizing: $isResizing,
			navDock: $navDock,
			isNavCollapsed: $channelSidebarWidth <= 0,
				activeWorkspace: $activeWorkspace,
				workspaces: Object.keys($layoutState.workspaces),
				layoutVersion: $layoutState.layoutVersion,
				obviousGrabRails: $obviousGrabRails
			};
		}
	);

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
	showMobileChannels,
	obviousGrabRails,

	// Existing actions
	toggleRightPanel,
	showUsersTab,
	showDMsTab,
	showAdminTab,
	showMediaTab,
	openDM,
	openGroupDM,
	openNotes,
	closeDM,
	toggleMobileChannels,
	toggleMobileUsers,
	resetPanelsOnDesktop,

	// Docking/workspace actions
	setNavDock,
	toggleNavDock,
	collapseNav,
	expandNav,
	toggleNavCollapsed,
	saveWorkspace,
	loadWorkspace: setActiveWorkspace,
	renameWorkspace,
	resetWorkspace,
	resetAllLayouts,
	exportLayoutJson,
	importLayoutJson,
	setObviousGrabRails: (enabled: boolean) => obviousGrabRails.set(Boolean(enabled))
};
