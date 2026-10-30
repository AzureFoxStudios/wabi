import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
	peekPanel,
	dismissPeek,
	pinPanel,
	unpinOne,
	setDockStackLimit,
	dockOrder,
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
	dockStack,
	dockStackLimit,
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
import {
	BUILTIN_WORKSPACE_PANELS,
	choosePanelChannel,
	coercePluginWorkspacePanels,
	panelChannelChoice,
	panelChannelPicking,
	panelChannelShown,
	panelFrameCounts,
	resolvePanelChannel,
	setPanelFrameCount,
	showPanelChannelPicker
} from '$lib/workspacePanels';
import { ICON_NAMES } from '$lib/components/ui/icons';
import { get } from 'svelte/store';

// The store modules guard every localStorage/window access, so they are safe
// to import under bun:test. Other test files may install their own global
// localStorage mock (cssSanitize.test.ts) — never assume ours is active, and
// never clear the shared global: only remove our own keys.

function resetState(mode: RightPanelMode = 'none', tab: string = 'users'): void {
	rightPanelMode.set(mode);
	dockStack.set([]);
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

	test('pinning a second panel stacks it beside the first; the last in is focused', () => {
		resetState();
		pinPanel('users');
		pinPanel('notes');
		expect(get(dockStack)).toEqual(['users', 'notes']);
		expect(get(pinnedPanelId)).toBe('notes');
		expect(get(rightPanelMode)).toBe('pinned');
	});

	test('the stack holds at most three; the oldest drops off', () => {
		resetState();
		for (const id of ['users', 'dms', 'notes', 'map']) pinPanel(id);
		expect(get(dockStack)).toEqual(['dms', 'notes', 'map']);
	});

	test('the stack limit is a preference: raise it for more, lower it to drop the oldest', () => {
		resetState();
		setDockStackLimit(5);
		for (const id of ['users', 'dms', 'notes', 'map', 'wiki']) pinPanel(id);
		expect(get(dockStack)).toEqual(['users', 'dms', 'notes', 'map', 'wiki']);
		setDockStackLimit(2);
		expect(get(dockStack)).toEqual(['map', 'wiki']);
		expect(get(pinnedPanelId)).toBe('wiki');
		setDockStackLimit(999);
		expect(get(dockStackLimit)).toBe(12);
		setDockStackLimit(0);
		expect(get(dockStackLimit)).toBe(1);
		setDockStackLimit(3);
	});

	test('unpinning one panel keeps the rest; unpinning the last closes the dock', () => {
		resetState();
		pinPanel('users');
		pinPanel('notes');
		unpinOne('notes');
		expect(get(dockStack)).toEqual(['users']);
		expect(get(rightPanelMode)).toBe('pinned');
		expect(get(pinnedPanelId)).toBe('users');
		unpinOne('users');
		expect(get(rightPanelMode)).toBe('none');
		expect(get(dockStack)).toEqual([]);
	});

	test('closeRightPanel clears the whole stack', () => {
		resetState();
		pinPanel('users');
		pinPanel('notes');
		closeRightPanel();
		expect(get(dockStack)).toEqual([]);
		expect(get(rightPanelMode)).toBe('none');
	});

	test('dock order follows the rail order, not pin order', () => {
		expect(dockOrder(['notes', 'users'], ['users', 'dms', 'notes'])).toEqual(['users', 'notes']);
		expect(dockOrder(['wiki', 'users'], ['users', 'notes'])).toEqual(['users', 'wiki']);
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

describe('companion manifests (§7.22, §9.4, §9.6)', () => {
	const byId = new Map(BUILTIN_WORKSPACE_PANELS.map((panel) => [panel.id, panel] as const));

	test('one unabbreviated name per place: DMs, Transfers, Models', () => {
		expect(byId.get('dms')?.label).toBe('DMs');
		expect(byId.get('transfers')?.label).toBe('Transfers');
		expect(byId.get('model-viewport')?.label).toBe('Models');
		const railWords = BUILTIN_WORKSPACE_PANELS.map((panel) => panel.shortLabel || panel.label);
		for (const retired of ['Xfers', 'CAD', 'CAD & 3D', 'Messages']) expect(railWords).not.toContain(retired);
	});

	test('Calls uses the voice glyph; headphones mean Listening (§6)', () => {
		expect(byId.get('calls')?.icon).toBe('voice');
		expect(BUILTIN_WORKSPACE_PANELS.some((panel) => panel.icon === 'headphones')).toBe(false);
	});

	test('every built-in panel has a one-line description for Add panels and its frame', () => {
		for (const panel of BUILTIN_WORKSPACE_PANELS) {
			expect(panel.description, panel.id).toBeTruthy();
			expect(panel.description!.length, panel.id).toBeLessThanOrEqual(42);
			expect(panel.description, panel.id).not.toMatch(/\.$/);
		}
	});

	test('the panels that draw their own row B, and the ones that open in center stage', () => {
		const own = BUILTIN_WORKSPACE_PANELS.filter((panel) => panel.ownsToolbar).map((panel) => panel.id).sort();
		expect(own).toEqual(['dms', 'forum', 'notes', 'users', 'wiki']);
		const stage = BUILTIN_WORKSPACE_PANELS.filter((panel) => panel.opensInStage).map((panel) => panel.id).sort();
		expect(stage).toEqual(['dms', 'forum', 'notes', 'wiki']);
	});

	test('panel glyph names resolve to the registry or the panel vocabulary', () => {
		const vocabulary = ['users', 'messages', 'notes', 'wiki', 'forum', 'layers', 'map', 'media', 'admin', 'box', 'activity', 'tasks', 'settings', 'transfers', 'headphones'];
		for (const panel of BUILTIN_WORKSPACE_PANELS) {
			expect(vocabulary.includes(panel.icon) || (ICON_NAMES as readonly string[]).includes(panel.icon), panel.id).toBe(true);
		}
	});

	test('add-on panels carry their declared description', () => {
		const [panel] = coercePluginWorkspacePanels({ id: 'demo', workspacePanels: [{ id: 'one', label: 'Demo', description: '  Shows a demo  ' }] });
		expect(panel.description).toBe('Shows a demo');
		const [bare] = coercePluginWorkspacePanels({ id: 'demo', workspacePanels: [{ id: 'two', label: 'Bare' }] });
		expect(bare.description).toBeUndefined();
	});
});

describe('companion frame state', () => {
	test('a panel publishes its count; null clears it', () => {
		setPanelFrameCount('users', 8);
		expect(get(panelFrameCounts).users).toBe(8);
		setPanelFrameCount('users', null);
		expect('users' in get(panelFrameCounts)).toBe(false);
	});

	test('Wiki/Forum: one channel opens directly; several show the picker until one is chosen', () => {
		const one = [{ id: 'w1' }];
		const several = [{ id: 'w1' }, { id: 'w2' }];
		expect(resolvePanelChannel(null, one, null)).toBe('w1');
		expect(resolvePanelChannel(null, several, null)).toBeNull();
		expect(resolvePanelChannel(null, several, 'w2')).toBe('w2');
		expect(resolvePanelChannel('w1', several, 'w2')).toBe('w1');
		// A chosen channel that is gone falls back instead of showing a dead page.
		expect(resolvePanelChannel('gone', several, null)).toBeNull();
		expect(resolvePanelChannel(null, [], null)).toBeNull();
	});

	test('the chosen channel is kept per kind', () => {
		choosePanelChannel('wiki', 'w2');
		choosePanelChannel('forum', 'f1');
		expect(get(panelChannelChoice)).toEqual({ wiki: 'w2', forum: 'f1' });
		choosePanelChannel('wiki', null);
		choosePanelChannel('forum', null);
		expect(get(panelChannelChoice)).toEqual({ wiki: null, forum: null });
	});

	// Regression (review round 1): "All wikis" while the stage read a wiki of that kind re-chose the
	// stage channel at once, so the picker never showed and no other wiki could be read beside it.
	test('"All wikis" shows the picker even while the stage reads a wiki, until one is chosen', () => {
		const several = [{ id: 'guide' }, { id: 'handbook' }];
		choosePanelChannel('wiki', 'guide');
		showPanelChannelPicker('wiki');
		expect(get(panelChannelChoice).wiki).toBeNull();
		expect(get(panelChannelPicking)).toEqual({ wiki: true, forum: false });
		// The stage is on 'guide' (a wiki): the picker still wins.
		expect(resolvePanelChannel(null, several, 'guide', get(panelChannelPicking).wiki)).toBeNull();
		choosePanelChannel('wiki', 'handbook');
		expect(get(panelChannelPicking).wiki).toBe(false);
		expect(resolvePanelChannel(get(panelChannelChoice).wiki, several, 'guide', get(panelChannelPicking).wiki)).toBe('handbook');
		// With a single channel there is no list to choose from: it opens directly.
		showPanelChannelPicker('wiki');
		expect(resolvePanelChannel(null, [{ id: 'guide' }], 'guide', true)).toBe('guide');
		choosePanelChannel('wiki', null);
		expect(get(panelChannelPicking).wiki).toBe(false);
	});

	test('panelChannelShown answers from every channel, by kind, ignoring a stale choice', () => {
		const all = [
			{ id: 'general', type: 'text' },
			{ id: 'guide', type: 'wiki' },
			{ id: 'handbook', type: 'wiki' },
			{ id: 'help', type: 'forum' }
		];
		const none = { wiki: false, forum: false };
		expect(panelChannelShown('wiki', { wiki: 'handbook', forum: null }, none, all, 'general')).toBe('handbook');
		// A chosen channel that was deleted: the stage's wiki, else the picker (never the dead id).
		expect(panelChannelShown('wiki', { wiki: 'gone', forum: null }, none, all, 'guide')).toBe('guide');
		expect(panelChannelShown('wiki', { wiki: 'gone', forum: null }, none, all, 'general')).toBeNull();
		expect(panelChannelShown('wiki', { wiki: 'handbook', forum: null }, { wiki: true, forum: false }, all, 'guide')).toBeNull();
		expect(panelChannelShown('forum', { wiki: null, forum: 'gone' }, none, all, 'general')).toBe('help');
	});
});
