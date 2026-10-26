import { afterEach, describe, expect, test } from 'bun:test';
import { get } from 'svelte/store';
import { armPeekDismiss, peekAnimationGate } from './rightPeekGestures';
import { closeRightPanel, dismissPeek, dockCanPin, endPeek, openPanelFromRail, openRightPanel, peekHeld, peekPanel, peekPanelFromRail, peekRequested, pinPanel, pinStowed, setDisplayedPanel, unpinOne, unpinPanel } from './layoutStoreRightPanel';
import { activeRightTab, dockStack, pinnedPanelId, rightPanelMode } from './layoutStoreStates';

const originalFrame = globalThis.requestAnimationFrame;
afterEach(() => {
	globalThis.requestAnimationFrame = originalFrame;
	unpinPanel();
	dockCanPin.set(true);
});

/** Mount the zone's animation gate the way MainLayout does, then let the entrance settle. */
async function settle(hovering: boolean): Promise<void> {
	globalThis.requestAnimationFrame = (callback) => { callback(0); return 0; };
	let animationEnd: (event: { target: unknown }) => void = () => {};
	const node = {
		matches: (selector: string) => { expect(selector).toBe(':hover'); return hovering; },
		classList: { contains: () => false },
		addEventListener: (_: string, callback: typeof animationEnd) => { animationEnd = callback; },
		removeEventListener: () => {}
	};
	const gate = peekAnimationGate(node as unknown as HTMLElement);
	try {
		animationEnd({ target: node });
		await new Promise((resolve) => setTimeout(resolve, 230));
	} finally { gate.destroy(); }
}

for (const hovering of [true, false]) {
	test(`settled hover peek ${hovering ? 'stays open under a stationary pointer' : 'retracts when pointer is outside'}`, async () => {
		peekPanel('users');
		await settle(hovering);
		expect(get(rightPanelMode)).toBe(hovering ? 'peek' : 'none');
	});
}

// Center-stage guard (design contract §8.4): MainLayout publishes dockCanPin from dockClamp.ts.
describe('opening a companion when the stage has no room to spare', () => {
	test('a stub click pins when the stage keeps 600px', () => {
		dockCanPin.set(true);
		openPanelFromRail('users');
		expect(get(rightPanelMode)).toBe('pinned');
		expect(get(peekHeld)).toBe(false);
	});

	test('a stub click opens a held peek when pinning would crush the stage', () => {
		dockCanPin.set(false);
		openPanelFromRail('users');
		expect(get(rightPanelMode)).toBe('peek');
		expect(get(peekHeld)).toBe(true);
		expect(get(activeRightTab)).toBe('users');
	});

	test('a held peek does not retract when the pointer leaves or the entrance settles', async () => {
		dockCanPin.set(false);
		openPanelFromRail('users');
		dismissPeek();
		expect(get(rightPanelMode)).toBe('peek');
		await settle(false);
		armPeekDismiss(null, 0);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(get(rightPanelMode)).toBe('peek');
	});

	test('clicking the same stub again closes the held peek; another stub replaces it', () => {
		dockCanPin.set(false);
		openPanelFromRail('users');
		openPanelFromRail('notes');
		expect(get(rightPanelMode)).toBe('peek');
		expect(get(activeRightTab)).toBe('notes');
		openPanelFromRail('notes');
		expect(get(rightPanelMode)).toBe('none');
		expect(get(peekHeld)).toBe(false);
	});

	test('a click commits a hover peek of the same stub instead of closing it', () => {
		dockCanPin.set(false);
		peekPanel('users');
		expect(get(peekHeld)).toBe(false);
		openPanelFromRail('users');
		expect(get(rightPanelMode)).toBe('peek');
		expect(get(peekHeld)).toBe(true);
	});

	test('a pin that loses its room is stowed, not turned into a peek: nothing covers the stage', () => {
		pinPanel('users');
		dockCanPin.set(false);
		expect(pinStowed()).toBe(true);
		expect(get(rightPanelMode)).toBe('pinned');
		expect(get(peekHeld)).toBe(false);
		expect(get(pinnedPanelId)).toBe('users');
		// Room again: the same pin is back in flow.
		dockCanPin.set(true);
		expect(pinStowed()).toBe(false);
		expect(get(rightPanelMode)).toBe('pinned');
		expect(get(pinnedPanelId)).toBe('users');
	});

	test('a stowed pin opens from its stub as a held peek and closes again without losing the pin', () => {
		pinPanel('users');
		pinPanel('notes');
		dockCanPin.set(false);
		openPanelFromRail('users');
		expect(get(peekHeld)).toBe(true);
		expect(get(activeRightTab)).toBe('users');
		openPanelFromRail('users');
		expect(get(peekHeld)).toBe(false);
		expect(get(rightPanelMode)).toBe('pinned');
		expect(get(dockStack)).toEqual(['users', 'notes']);
		expect(get(activeRightTab)).toBe('notes');
	});

	test('another stub peeks over a stowed pin; the scrim and Escape (endPeek) end the peek and keep the pin', () => {
		pinPanel('users');
		dockCanPin.set(false);
		openPanelFromRail('dms');
		expect(get(peekHeld)).toBe(true);
		expect(get(activeRightTab)).toBe('dms');
		expect(get(pinnedPanelId)).toBe('users');
		expect(get(dockStack)).toEqual(['users']);
		expect(endPeek()).toBe(true);
		expect(get(peekHeld)).toBe(false);
		expect(get(rightPanelMode)).toBe('pinned');
		expect(get(pinnedPanelId)).toBe('users');
		expect(get(activeRightTab)).toBe('users');
	});

	test('endPeek with no peek on screen leaves every pin alone, in flow or stowed (a stray Escape)', () => {
		pinPanel('users');
		expect(endPeek()).toBe(false);
		expect(get(rightPanelMode)).toBe('pinned');
		dockCanPin.set(false);
		expect(endPeek()).toBe(false);
		expect(get(rightPanelMode)).toBe('pinned');
		expect(get(pinnedPanelId)).toBe('users');
	});

	test('endPeek closes a plain peek, held or hover', () => {
		dockCanPin.set(false);
		openPanelFromRail('users');
		expect(endPeek()).toBe(true);
		expect(get(rightPanelMode)).toBe('none');
		peekPanel('calls');
		expect(endPeek()).toBe(true);
		expect(get(rightPanelMode)).toBe('none');
	});

	// Callers that close the panel as part of an action (navigation, deep links, "show in center
	// stage") get one result whatever the window width: nothing is left to come back later.
	for (const room of [true, false]) {
		test(`closeRightPanel closes every pin ${room ? 'in flow' : 'stowed for lack of room'}, peek included`, () => {
			pinPanel('users');
			pinPanel('model-viewport');
			dockCanPin.set(room);
			if (!room) openPanelFromRail('dms');
			closeRightPanel();
			expect(get(rightPanelMode)).toBe('none');
			expect(get(pinnedPanelId)).toBeNull();
			expect(get(dockStack)).toEqual([]);
			expect(get(peekHeld)).toBe(false);
			dockCanPin.set(true);
			expect(get(rightPanelMode)).toBe('none');
		});
	}

	test('the rail menu can unpin a stowed pin; it does not come back when room returns', () => {
		pinPanel('users');
		pinPanel('notes');
		dockCanPin.set(false);
		unpinOne('notes');
		expect(get(dockStack)).toEqual(['users']);
		unpinOne('users');
		expect(get(rightPanelMode)).toBe('none');
		dockCanPin.set(true);
		expect(get(rightPanelMode)).toBe('none');
	});

	test('when room returns, a peek over a stowed pin joins the dock; a peek of the pin just re-pins', () => {
		pinPanel('users');
		dockCanPin.set(false);
		openPanelFromRail('users');
		dockCanPin.set(true);
		expect(get(peekHeld)).toBe(false);
		expect(get(dockStack)).toEqual(['users']);
		dockCanPin.set(false);
		openPanelFromRail('notes');
		dockCanPin.set(true);
		expect(get(peekHeld)).toBe(false);
		expect(get(dockStack)).toEqual(['users', 'notes']);
		expect(get(activeRightTab)).toBe('notes');
	});

	test('openRightPanel and setDisplayedPanel show a stowed pin as a held peek instead of a no-op', () => {
		pinPanel('users');
		dockCanPin.set(false);
		openRightPanel('users');
		expect(get(peekHeld)).toBe(true);
		endPeek();
		setDisplayedPanel('users');
		expect(get(peekHeld)).toBe(true);
		expect(get(pinnedPanelId)).toBe('users');
	});

	test('a hover retract never ends a held peek over a stowed pin', () => {
		pinPanel('users');
		dockCanPin.set(false);
		openPanelFromRail('dms');
		dismissPeek();
		expect(get(peekHeld)).toBe(true);
		expect(get(activeRightTab)).toBe('dms');
	});

	test('a held peek pins itself once the stage has room again', () => {
		dockCanPin.set(false);
		openPanelFromRail('notes');
		dockCanPin.set(true);
		expect(get(rightPanelMode)).toBe('pinned');
		expect(get(pinnedPanelId)).toBe('notes');
		expect(get(peekHeld)).toBe(false);
	});

	test('openRightPanel never toggles shut and opens a held peek when there is no room', () => {
		dockCanPin.set(false);
		openRightPanel('dms');
		openRightPanel('dms');
		expect(get(rightPanelMode)).toBe('peek');
		expect(get(peekHeld)).toBe(true);
		expect(get(activeRightTab)).toBe('dms');
	});

	test('hover peeks never become held, and closing clears the hold', () => {
		dockCanPin.set(false);
		openPanelFromRail('users');
		closeRightPanel();
		peekPanel('notes');
		expect(get(peekHeld)).toBe(false);
	});
});

// The scrim is for peeks the person asked for (§8.4); MainLayout reads peekHeld || peekRequested.
describe('which peeks the person asked for', () => {
	test('a peek the app opens on its own (the Calls peek on joining a call) is not asked for', () => {
		peekPanel('calls');
		expect(get(rightPanelMode)).toBe('peek');
		expect(get(peekRequested)).toBe(false);
		expect(get(peekHeld)).toBe(false);
	});

	test('a rail hover peek is asked for, also when it takes over a summoned peek', () => {
		peekPanelFromRail('users');
		expect(get(peekRequested)).toBe(true);
		closeRightPanel();
		expect(get(peekRequested)).toBe(false);
		peekPanel('calls');
		peekPanelFromRail('dms');
		expect(get(activeRightTab)).toBe('dms');
		expect(get(peekRequested)).toBe(true);
	});

	test('a rail hover never marks a pin, and the mark ends with the peek', () => {
		pinPanel('users');
		peekPanelFromRail('notes');
		expect(get(peekRequested)).toBe(false);
		unpinPanel();
		peekPanelFromRail('notes');
		dismissPeek();
		expect(get(rightPanelMode)).toBe('none');
		expect(get(peekRequested)).toBe(false);
		peekPanel('calls');
		expect(get(peekRequested)).toBe(false);
	});
});

test('leaving peek mode by any route ends the hold', () => {
	dockCanPin.set(false);
	openPanelFromRail('users');
	expect(get(peekHeld)).toBe(true);
	rightPanelMode.set('none');
	expect(get(peekHeld)).toBe(false);
});
