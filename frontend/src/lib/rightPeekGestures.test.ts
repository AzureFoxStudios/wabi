import { afterEach, describe, expect, test } from 'bun:test';
import { get } from 'svelte/store';
import { armPeekDismiss, peekAnimationGate } from './rightPeekGestures';
import { closeRightPanel, dismissPeek, dockCanPin, openPanelFromRail, openRightPanel, peekHeld, peekPanel, pinPanel } from './layoutStoreRightPanel';
import { activeRightTab, dockStack, pinnedPanelId, rightPanelMode } from './layoutStoreStates';

const originalFrame = globalThis.requestAnimationFrame;
afterEach(() => {
	globalThis.requestAnimationFrame = originalFrame;
	closeRightPanel();
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

	test('a pin shown as a peek (no room) closes from its stub and is replaced by another', () => {
		pinPanel('users');
		dockCanPin.set(false);
		openPanelFromRail('dms');
		expect(get(rightPanelMode)).toBe('peek');
		expect(get(pinnedPanelId)).toBeNull();
		expect(get(dockStack)).toEqual([]);
		closeRightPanel();
		pinPanel('users');
		dockCanPin.set(false);
		openPanelFromRail('users');
		expect(get(rightPanelMode)).toBe('none');
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

test('leaving peek mode by any route ends the hold', () => {
	dockCanPin.set(false);
	openPanelFromRail('users');
	expect(get(peekHeld)).toBe(true);
	rightPanelMode.set('none');
	expect(get(peekHeld)).toBe(false);
});
