/**
 * layoutStoreStates.ts
 * Layout store state definitions
 */

import { readable, writable } from 'svelte/store';
import type { User, Channel } from './socket-types';
import { createDefaultLayoutState, FALLBACK_WORKSPACE_PANEL_ID, type LayoutStateV1, type WorkspacePanelId } from '$lib/docking/layoutSchema';
import { getWorkspacePanelManifest } from './workspacePanels';

type RightPanelTab = WorkspacePanelId;

export const NOTES_DM_ID = '__keep_notes__';

export type HomeLayoutMode = 'dm-pure' | 'dm-focused' | 'server-browser';

const DEFAULT_NAV_WIDTH = 280;
const DEFAULT_RIGHT_WIDTH = 320;
const MIN_RIGHT_WIDTH = 220;
const OBVIOUS_GRAB_RAILS_KEY = 'wabi:obvious-grab-rails';
const HOME_LAYOUT_KEY = 'wabi:home-layout';
const STUB_STRIP_KEY = 'wabi:stub-strip';
const STUB_SIDE_KEY = 'wabi:stub-side';

export type RightPanelMode = 'none' | 'peek' | 'pinned';
export type StubSide = 'left' | 'right';

export const DEFAULT_STUB_STRIP: WorkspacePanelId[] = ['users', 'dms', 'notes'];

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
export const rightPanelMode = writable<RightPanelMode>('none');
/** N3: center stage can host admin dashboard or full notes (chat = default shell). */
export type CenterPanelView = 'chat' | 'admin' | 'notes';
export const centerPanelView = writable<CenterPanelView>('chat');
export const activeRightTab = writable<RightPanelTab>(FALLBACK_WORKSPACE_PANEL_ID);
/** Committed pin — survives peek-over (hovering another stub only changes activeRightTab). */
export const pinnedPanelId = writable<WorkspacePanelId | null>(null);
export const showMobileChannels = writable(false);

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

function readStubStrip(): WorkspacePanelId[] {
	if (typeof localStorage === 'undefined') return [...DEFAULT_STUB_STRIP];
	try {
		const stored = localStorage.getItem(STUB_STRIP_KEY);
		if (stored) {
			const parsed = JSON.parse(stored) as unknown;
			if (Array.isArray(parsed)) {
				const ids = parsed.filter((id): id is WorkspacePanelId => typeof id === 'string' && id.length > 0);
				if (ids.length > 0) return ids;
			}
		}
	} catch { /* best effort */ }
	return [...DEFAULT_STUB_STRIP];
}

function readStubSide(): StubSide {
	if (typeof localStorage === 'undefined') return 'right';
	try {
		const stored = localStorage.getItem(STUB_SIDE_KEY);
		if (stored === 'left' || stored === 'right') return stored;
	} catch { /* best effort */ }
	return 'right';
}

/** Pure derivation used by the one-time seed: ordered union of stacks[].tabs,
 *  filtered to panels that resolve in the registry; falls back to the default
 *  strip. Kept separate from the localStorage wrapper so it is unit-testable. */
export function deriveStubStripFromDock(
	stacks: Array<{ tabs: WorkspacePanelId[] }> | undefined
): WorkspacePanelId[] {
	const seen = new Set<WorkspacePanelId>();
	const derived: WorkspacePanelId[] = [];
	for (const stack of stacks ?? []) {
		for (const id of stack.tabs) {
			if (seen.has(id) || getWorkspacePanelManifest(id) === null) continue;
			seen.add(id);
			derived.push(id);
		}
	}
	return derived.length > 0 ? derived : [...DEFAULT_STUB_STRIP];
}

/** One-time seed from the legacy dock: no-op once wabi:stub-strip exists. */
export function seedStubStripIfAbsent(stacks: Array<{ tabs: WorkspacePanelId[] }> | undefined): void {
	if (typeof localStorage === 'undefined') return;
	try {
		if (localStorage.getItem(STUB_STRIP_KEY) !== null) return;
	} catch { return; }

	const seeded = deriveStubStripFromDock(stacks);
	stubStrip.set(seeded);
	try { localStorage.setItem(STUB_STRIP_KEY, JSON.stringify(seeded)); } catch { /* best effort */ }
}

export const stubStrip = writable<WorkspacePanelId[]>(readStubStrip());
export const stubSide = writable<StubSide>(readStubSide());
export const focusMode = writable(false);

if (typeof localStorage !== 'undefined') {
	stubStrip.subscribe(value => {
		try { localStorage.setItem(STUB_STRIP_KEY, JSON.stringify(value)); } catch { /* best effort */ }
	});
	stubSide.subscribe(value => {
		try { localStorage.setItem(STUB_SIDE_KEY, value); } catch { /* best effort */ }
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
