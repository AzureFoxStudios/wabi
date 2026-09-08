import { describe, expect, test } from 'bun:test';
import { panelActionIndex, positionPanelPopover } from './panelPopover';

describe('panel popover placement', () => {
	for (const side of ['left', 'right'] as const) {
		for (const viewport of [{ width: 1440, height: 900 }, { width: 1000, height: 360 }, { width: 320, height: 180 }]) {
			test(`${side} drawer stays within ${viewport.width}×${viewport.height}`, () => {
				const rect = positionPanelPopover(
					{ left: side === 'left' ? 0 : viewport.width - 48, right: side === 'left' ? 48 : viewport.width, top: 200 },
					viewport, { width: 260, height: 520 }, side
				);
				expect(rect.top).toBeGreaterThanOrEqual(8);
				expect(rect.left).toBeGreaterThanOrEqual(8);
				expect(rect.top + Math.min(520, rect.maxHeight)).toBeLessThanOrEqual(viewport.height - 8);
				expect(rect.left + Math.min(260, rect.maxWidth)).toBeLessThanOrEqual(viewport.width - 8);
			});
		}
	}
	test('anchors to the trigger when there is room', () => {
		expect(positionPanelPopover({ left: 1350, right: 1398, top: 100 }, { width: 1440, height: 900 }, { width: 260, height: 400 }, 'right'))
			.toEqual({ left: 1086, top: 100, maxWidth: 1424, maxHeight: 884 });
	});
});

describe('panel action keyboard navigation', () => {
	test('supports arrows, wraparound and endpoints', () => {
		expect(panelActionIndex('ArrowDown', -1, 3)).toBe(0);
		expect(panelActionIndex('ArrowDown', 2, 3)).toBe(0);
		expect(panelActionIndex('ArrowUp', 0, 3)).toBe(2);
		expect(panelActionIndex('ArrowUp', -1, 3)).toBe(2);
		expect(panelActionIndex('Home', 2, 3)).toBe(0);
		expect(panelActionIndex('End', 0, 3)).toBe(2);
	});
	test('leaves Tab/activation to native buttons, and tolerates no enabled actions', () => {
		for (const key of ['Tab', 'Enter', ' ', 'Escape']) expect(panelActionIndex(key, 0, 3)).toBeNull();
		expect(panelActionIndex('ArrowDown', -1, 0)).toBeNull();
	});
});
