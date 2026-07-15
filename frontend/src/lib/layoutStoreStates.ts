/**
 * layoutStoreStates.ts
 * Layout store state definitions
 */

import { readable, writable } from 'svelte/store';
import type { User, Channel } from './socket-types';
import { createDefaultLayoutState, createDefaultPanelDock, FALLBACK_WORKSPACE_PANEL_ID, type LayoutStateV1, type WorkspacePanelDockV1, type WorkspacePanelId } from '$lib/docking/layoutSchema';

type RightPanelView = 'none' | WorkspacePanelId;
type RightPanelTab = WorkspacePanelId;

export const NOTES_DM_ID = '__keep_notes__';

export type HomeLayoutMode = 'dm-pure' | 'dm-focused' | 'server-browser';

const DEFAULT_NAV_WIDTH = 280;
const DEFAULT_RIGHT_WIDTH = 320;
const MIN_RIGHT_WIDTH = 220;
const OBVIOUS_GRAB_RAILS_KEY = 'wabi:obvious-grab-rails';
const HOME_LAYOUT_KEY = 'wabi:home-layout';

export const isMobile = readable(false, (set) => {
	if (typeof window === 'undefined') {
		return;
	}
	const mql = window.matchMedia('(max-width: 768px)');
	set(mql.matches);
	const listener = (e: MediaQueryListEvent) => set(e.matches);
	mql.addEventListener('change', listener);
	return () => mql.removeEventListener('change', listener);
});

export const layoutState = writable<LayoutStateV1>(createDefaultLayoutState());
export const activeWorkspace = writable('default');
export const navDock = writable<any>('left');
export const rightPanelView = writable<RightPanelView>('none');
export const centerPanelView = writable<'chat' | 'admin'>('chat');
export const activeRightTab = writable<RightPanelTab>(FALLBACK_WORKSPACE_PANEL_ID);
export const rightPanelDock = writable<WorkspacePanelDockV1>(createDefaultPanelDock());
export const showMobileChannels = writable(false);
export const detachedPanelIds = writable<Set<WorkspacePanelId>>(new Set());

export const channelSidebarWidth = writable(DEFAULT_NAV_WIDTH);
export const rightPanelWidth = writable(DEFAULT_RIGHT_WIDTH);
export const isResizingChannel = writable(false);
export const isResizingRight = writable(false);

export const selectedDmChannelId = writable<string | null>(null);
export const dmOtherUser = writable<User | null>(null);
export const centerDmChannelId = writable<string | null>(null);
export const selectedGroupChannel = writable<Channel | null>(null);
export const pinnedDmChannelId = writable<string | null>(null);
export const pinnedDmOtherUser = writable<User | null>(null);
export const obviousGrabRails = writable(false);

function readHomeLayout(): HomeLayoutMode {
	if (typeof localStorage === 'undefined') return 'server-browser';
	try {
		const stored = localStorage.getItem(HOME_LAYOUT_KEY);
		if (stored === 'dm-pure' || stored === 'dm-focused' || stored === 'server-browser') return stored;
	} catch { /* best effort */ }
	return 'server-browser';
}

export const homeLayout = writable<HomeLayoutMode>(readHomeLayout());

if (typeof localStorage !== 'undefined') {
	homeLayout.subscribe(value => {
		try { localStorage.setItem(HOME_LAYOUT_KEY, value); } catch { /* best effort */ }
	});
}

export const DEFAULT_CONSTANTS = {
	NAV_WIDTH: DEFAULT_NAV_WIDTH,
	RIGHT_WIDTH: DEFAULT_RIGHT_WIDTH,
	MIN_RIGHT_WIDTH: MIN_RIGHT_WIDTH,
	GRAB_RAILS_KEY: OBVIOUS_GRAB_RAILS_KEY
};

export let isApplyingLayout = false;
export let layoutLoaded = false;
export let persistTimer: ReturnType<typeof setTimeout> | null = null;

export function setIsApplyingLayout(value: boolean): void {
	isApplyingLayout = value;
}

export function setLayoutLoaded(value: boolean): void {
	layoutLoaded = value;
}

export function setPersistTimer(timer: ReturnType<typeof setTimeout> | null): void {
	persistTimer = timer;
}
