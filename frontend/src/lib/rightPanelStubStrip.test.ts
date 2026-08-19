import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
	peekPanel,
	dismissPeek,
	pinPanel,
	closeRightPanel,
	openRightPanel,
	addStub,
	removeStub,
	reorderStub,
	resetStubs,
	setStubSide
} from '$lib/layoutStoreRightPanel';
import {
	DEFAULT_STUB_STRIP,
	stubStrip,
	stubSide,
	rightPanelMode,
	pinnedPanelId,
	activeRightTab,
	layoutState,
	setLayoutLoaded,
	deriveStubStripFromDock,
	seedStubStripIfAbsent,
	type RightPanelMode,
	type StubSide
} from '$lib/layoutStoreStates';
import {
	syncWorkspaceFromRuntime,
	applyWorkspaceToRuntime,
	getDockActivePanelId
} from '$lib/layoutStoreUtils';
import { getWorkspace, createDefaultLayoutState } from '$lib/docking/layoutSchema';
import { get } from 'svelte/store';

// The store modules guard every localStorage/window access, so they are safe
// to import under bun:test. Other test files may install their own global
// localStorage mock (cssSanitize.test.ts) — never assume ours is active, and
// never clear the shared global: only remove our own keys.

function resetState(mode: RightPanelMode = 'none', tab: string = 'users'): void {
	rightPanelMode.set(mode);
	pinnedPanelId.set(mode === 'pinned' ? tab : null);
	activeRightTab.set(tab);
	stubStrip.set([...DEFAULT_STUB_STRIP]);
	stubSide.set('right');
}

beforeEach(() => {
	stubStrip.set([...DEFAULT_STUB_STRIP]);
	// Remove AFTER the set: a module-level subscription may rewrite the key.
	globalThis.localStorage?.removeItem?.('wabi:stub-strip');
	globalThis.localStorage?.removeItem?.('wabi:stub-side');
});

describe('deriveStubStripFromDock (legacy dock migration, pure)', () => {
	test('derives ordered union of stacks[].tabs, filtered to resolvable panels', () => {
		const result = deriveStubStripFromDock([
			{ tabs: ['users', 'dms', 'unknown-panel', 'notes'] },
			{ tabs: ['dms', 'map'] }
		]);
		expect(result).toEqual(['users', 'dms', 'notes', 'map']);
	});

	test('falls back to DEFAULT_STUB_STRIP when nothing resolves', () => {
		expect(deriveStubStripFromDock([{ tabs: ['ghost-a', 'ghost-b'] }])).toEqual(DEFAULT_STUB_STRIP);
	});

	test('handles undefined stacks', () => {
		expect(deriveStubStripFromDock(undefined)).toEqual(DEFAULT_STUB_STRIP);
	});
});

describe('seedStubStripIfAbsent (localStorage-gated wrapper)', () => {
	test('is a no-op once the key exists', () => {
		if (typeof globalThis.localStorage === 'undefined') return; // nothing to gate against
		globalThis.localStorage?.setItem?.('wabi:stub-strip', '["map"]');
		seedStubStripIfAbsent([{ tabs: ['users', 'dms'] }]);
		expect(get(stubStrip)).toEqual(['users', 'dms', 'notes']);
	});

	test('seeds when the key is absent and persists it', () => {
		if (typeof globalThis.localStorage === 'undefined') return;
		seedStubStripIfAbsent([{ tabs: ['users', 'dms', 'map'] }]);
		expect(get(stubStrip)).toEqual(['users', 'dms', 'map']);
		expect(globalThis.localStorage?.getItem?.('wabi:stub-strip')).toBe('["users","dms","map"]');
	});
});

describe('peek / pin / dismiss state machine', () => {
	beforeEach(() => resetState());

	test('peekPanel opens from none and sets the displayed tab', () => {
		peekPanel('map');
		expect(get(rightPanelMode)).toBe('peek');
		expect(get(activeRightTab)).toBe('map');
		expect(get(pinnedPanelId)).toBeNull();
	});

	test('pinPanel pins, auto-adds its stub, and records the committed pin', () => {
		pinPanel('map');
		expect(get(rightPanelMode)).toBe('pinned');
		expect(get(pinnedPanelId)).toBe('map');
		expect(get(activeRightTab)).toBe('map');
		expect(get(stubStrip)).toContain('map');
	});

	test('pinPanel toggles off when the stub was already the pinned one', () => {
		resetState('pinned', 'users');
		pinPanel('users');
		expect(get(rightPanelMode)).toBe('none');
		expect(get(pinnedPanelId)).toBeNull();
	});

	test('peek-over while pinned changes only the displayed tab, never the pin', () => {
		pinPanel('users');
		peekPanel('dms');
		expect(get(rightPanelMode)).toBe('pinned');
		expect(get(pinnedPanelId)).toBe('users');
		expect(get(activeRightTab)).toBe('dms');
	});

	test('dismissPeek reverts peek-over to the pinned panel', () => {
		pinPanel('users');
		peekPanel('dms');
		dismissPeek();
		expect(get(rightPanelMode)).toBe('pinned');
		expect(get(activeRightTab)).toBe('users');
	});

	test('dismissPeek closes a plain peek', () => {
		peekPanel('map');
		dismissPeek();
		expect(get(rightPanelMode)).toBe('none');
		expect(get(pinnedPanelId)).toBeNull();
	});

	test('closeRightPanel unpins from any mode', () => {
		pinPanel('users');
		closeRightPanel();
		expect(get(rightPanelMode)).toBe('none');
		expect(get(pinnedPanelId)).toBeNull();
	});

	test('openRightPanel pins by default and auto-adds the stub', () => {
		openRightPanel('notes');
		expect(get(rightPanelMode)).toBe('pinned');
		expect(get(pinnedPanelId)).toBe('notes');
		expect(get(stubStrip)).toContain('notes');
	});

	test('openRightPanel with pin:false peeks instead', () => {
		openRightPanel('map', { pin: false });
		expect(get(rightPanelMode)).toBe('peek');
		expect(get(pinnedPanelId)).toBeNull();
	});

	test('reserved ids normalize to the fallback tab', () => {
		peekPanel('__proto__');
		expect(get(activeRightTab)).not.toBe('__proto__');
		expect(get(rightPanelMode)).toBe('peek');
	});
});

describe('strip mutations', () => {
	beforeEach(() => resetState());

	test('addStub is idempotent and appends in order', () => {
		addStub('map');
		addStub('map');
		expect(get(stubStrip)).toEqual(['users', 'dms', 'notes', 'map']);
	});

	test('removeStub filters by id', () => {
		removeStub('dms');
		expect(get(stubStrip)).toEqual(['users', 'notes']);
	});

	test('reorderStub moves within bounds and clamps', () => {
		reorderStub(0, 2);
		expect(get(stubStrip)).toEqual(['dms', 'notes', 'users']);
		reorderStub(0, 99);
		expect(get(stubStrip)).toEqual(['notes', 'users', 'dms']);
	});

	test('resetStubs restores defaults', () => {
		addStub('map');
		resetStubs();
		expect(get(stubStrip)).toEqual(DEFAULT_STUB_STRIP);
	});

	test('setStubSide only accepts left/right', () => {
		setStubSide('left');
		expect(get(stubSide)).toBe('left');
		setStubSide('right');
		expect(get(stubSide)).toBe('right');
	});
});

describe('pinned-panel persistence (syncWorkspaceFromRuntime → applyWorkspaceToRuntime)', () => {
	beforeEach(() => resetState());

	afterEach(() => {
		setLayoutLoaded(false);
		layoutState.set(createDefaultLayoutState());
	});

	test('the committed pin is persisted as the active panel and survives reload', () => {
		setLayoutLoaded(true);
		resetState('pinned', 'notes');
		syncWorkspaceFromRuntime();
		const workspace = getWorkspace(get(layoutState));
		expect(getDockActivePanelId(workspace.panelDock)).toBe('notes');
		applyWorkspaceToRuntime(workspace);
		expect(get(rightPanelMode)).toBe('pinned');
		expect(get(pinnedPanelId)).toBe('notes');
		expect(get(activeRightTab)).toBe('notes');
	});

	test('a pin removed from the strip falls back to the first stub without crashing', () => {
		setLayoutLoaded(true);
		resetState('pinned', 'map');
		stubStrip.set([...DEFAULT_STUB_STRIP]); // 'map' pinned but no longer stubbed
		syncWorkspaceFromRuntime();
		const workspace = getWorkspace(get(layoutState));
		expect(getDockActivePanelId(workspace.panelDock)).toBe(DEFAULT_STUB_STRIP[0]);
	});

	test('peek does not persist — reload restores a closed panel', () => {
		setLayoutLoaded(true);
		resetState('peek', 'map');
		stubStrip.set([...DEFAULT_STUB_STRIP, 'map']);
		syncWorkspaceFromRuntime();
		const workspace = getWorkspace(get(layoutState));
		applyWorkspaceToRuntime(workspace);
		expect(get(rightPanelMode)).toBe('none');
		expect(get(pinnedPanelId)).toBeNull();
	});
});