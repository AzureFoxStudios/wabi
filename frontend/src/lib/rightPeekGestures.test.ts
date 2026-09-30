import { afterEach, expect, test } from 'bun:test';
import { get } from 'svelte/store';
import { peekAnimationGate } from './rightPeekGestures';
import { closeRightPanel, peekPanel } from './layoutStoreRightPanel';
import { rightPanelMode } from './layoutStoreStates';

const originalFrame = globalThis.requestAnimationFrame;
afterEach(() => {
	globalThis.requestAnimationFrame = originalFrame;
	closeRightPanel();
});

for (const hovering of [true, false]) {
	test(`settled peek ${hovering ? 'stays open under a stationary pointer' : 'retracts when pointer is outside'}`, async () => {
		globalThis.requestAnimationFrame = (callback) => { callback(0); return 0; };
		let animationEnd: (event: { target: unknown }) => void = () => {};
		const node = {
			matches: (selector: string) => { expect(selector).toBe(':hover'); return hovering; },
			classList: { contains: () => false },
			addEventListener: (_: string, callback: typeof animationEnd) => { animationEnd = callback; },
			removeEventListener: () => {}
		};
		peekPanel('users');
		const gate = peekAnimationGate(node as unknown as HTMLElement);
		try {
			animationEnd({ target: node });
			await new Promise((resolve) => setTimeout(resolve, 230));
			expect(get(rightPanelMode)).toBe(hovering ? 'peek' : 'none');
		} finally { gate.destroy(); }
	});
}
