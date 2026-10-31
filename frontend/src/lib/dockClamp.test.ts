import { describe, expect, test } from 'bun:test';
import {
	DOCK_DEFAULT_PANEL,
	DOCK_MAX_PANEL,
	DOCK_MIN_PANEL,
	dockWidthFor,
	peekWidthFor,
	resizeKeyWidth,
	stageWithoutPanel
} from './dockClamp';

// Contract numbers (§4.3): sidebar 264, rail 44, panel 304 (240-744), stage keeps >= 600.
const shell = { sidebar: 264, rail: 44 };

describe('dockWidthFor: pinned panels never crush center stage', () => {
	test('1536: pinned at the chosen width, stage stays roomy', () => {
		const dock = dockWidthFor({ viewport: 1536, ...shell, requested: DOCK_DEFAULT_PANEL });
		expect(dock).toEqual({ mode: 'pin', width: 304, max: 628 });
		expect(1536 - shell.sidebar - shell.rail - dock.width).toBeGreaterThanOrEqual(600);
	});

	test('1536: a very wide request is capped at 744 or the room left, whichever is smaller', () => {
		expect(dockWidthFor({ viewport: 1536, ...shell, requested: 900 }).width).toBe(628);
		expect(dockWidthFor({ viewport: 2400, ...shell, requested: 900 }).width).toBe(DOCK_MAX_PANEL);
	});

	test('1280: pinned, clamped so the stage keeps 600px', () => {
		expect(dockWidthFor({ viewport: 1280, ...shell, requested: 304 })).toEqual({ mode: 'pin', width: 304, max: 372 });
		const wide = dockWidthFor({ viewport: 1280, ...shell, requested: 600 });
		expect(wide).toEqual({ mode: 'pin', width: 372, max: 372 });
		expect(1280 - shell.sidebar - shell.rail - wide.width).toBe(600);
	});

	test('1280 with the current 280px sidebar and 46px rail still keeps 600px', () => {
		const dock = dockWidthFor({ viewport: 1280, sidebar: 280, rail: 46, requested: 744 });
		expect(dock.mode).toBe('pin');
		expect(1280 - 280 - 46 - dock.width).toBe(600);
	});

	test('1000: no room to pin, so the panel peeks at 340px over the stage', () => {
		expect(dockWidthFor({ viewport: 1000, ...shell, requested: 304 })).toEqual({ mode: 'peek', width: 340, max: 0 });
		expect(dockWidthFor({ viewport: 1000, sidebar: 280, rail: 46, requested: 320 }).mode).toBe('peek');
	});

	test('820: peek, 340px (72% of a 512px stage would be 368)', () => {
		expect(dockWidthFor({ viewport: 820, ...shell, requested: 304 })).toEqual({ mode: 'peek', width: 340, max: 0 });
	});

	test('a narrow stage gets a peek of 72% of the stage', () => {
		expect(dockWidthFor({ viewport: 700, ...shell, requested: 304 })).toEqual({ mode: 'peek', width: 282, max: 0 });
	});

	test('collapsing the sidebar makes room to pin', () => {
		expect(dockWidthFor({ viewport: 1000, sidebar: 0, rail: 44, requested: 304 })).toEqual({ mode: 'pin', width: 304, max: 356 });
	});

	test('pins exactly at the 240px threshold, peeks one pixel below it', () => {
		const edge = 264 + 44 + 600 + 240;
		expect(dockWidthFor({ viewport: edge, ...shell, requested: 304 })).toEqual({ mode: 'pin', width: 240, max: 240 });
		expect(dockWidthFor({ viewport: edge - 1, ...shell, requested: 304 }).mode).toBe('peek');
	});

	test('a request below the minimum is raised to 240', () => {
		expect(dockWidthFor({ viewport: 1536, ...shell, requested: 100 }).width).toBe(DOCK_MIN_PANEL);
	});

	test('garbage input degrades to a safe answer', () => {
		expect(dockWidthFor({ viewport: Number.NaN, ...shell, requested: 304 })).toEqual({ mode: 'peek', width: 0, max: 0 });
		expect(dockWidthFor({ viewport: 1536, ...shell, requested: Number.NaN }).width).toBe(DOCK_DEFAULT_PANEL);
		expect(stageWithoutPanel({ viewport: 500, sidebar: 600, rail: 44 })).toBe(0);
		expect(peekWidthFor(0, 0)).toBe(0);
	});

	test('a sidebar that leaves no stage still gets a usable peek, never a 0px sliver', () => {
		// 1000 window, 900 sidebar: no stage at all, but 956px beside the rail.
		expect(dockWidthFor({ viewport: 1000, sidebar: 900, rail: 44, requested: 304 })).toEqual({ mode: 'peek', width: DOCK_MIN_PANEL, max: 0 });
		// A tiny window gives the peek what there is beside the rail.
		expect(dockWidthFor({ viewport: 200, sidebar: 300, rail: 44, requested: 304 }).width).toBe(156);
		expect(peekWidthFor(0)).toBe(DOCK_MIN_PANEL);
		// The floor only lifts a peek that 72% would make narrower than a panel.
		expect(peekWidthFor(300)).toBe(DOCK_MIN_PANEL);
		expect(peekWidthFor(392)).toBe(282);
	});
});

describe('resizeKeyWidth: the separator is keyboard operable', () => {
	const right = { towardStage: 'ArrowLeft' as const, max: 600 };
	const left = { towardStage: 'ArrowRight' as const, max: 600 };

	test('arrow toward the stage widens by 16, away narrows by 16', () => {
		expect(resizeKeyWidth('ArrowLeft', 304, { ...right, shift: false })).toBe(320);
		expect(resizeKeyWidth('ArrowRight', 304, { ...right, shift: false })).toBe(288);
	});

	test('Shift moves 64', () => {
		expect(resizeKeyWidth('ArrowLeft', 304, { ...right, shift: true })).toBe(368);
		expect(resizeKeyWidth('ArrowRight', 304, { ...right, shift: true })).toBe(240);
	});

	test('a left-side panel mirrors the arrows', () => {
		expect(resizeKeyWidth('ArrowRight', 304, { ...left, shift: false })).toBe(320);
		expect(resizeKeyWidth('ArrowLeft', 304, { ...left, shift: false })).toBe(288);
	});

	test('clamps to 240 and the room left; Home and End jump to the ends', () => {
		expect(resizeKeyWidth('ArrowRight', 248, { ...right, shift: false })).toBe(240);
		expect(resizeKeyWidth('ArrowLeft', 590, { ...right, shift: true })).toBe(600);
		expect(resizeKeyWidth('Home', 400, { ...right, shift: false })).toBe(240);
		expect(resizeKeyWidth('End', 400, { ...right, shift: false })).toBe(600);
	});

	test('other keys do not resize', () => {
		expect(resizeKeyWidth('Enter', 304, { ...right, shift: false })).toBeNull();
		expect(resizeKeyWidth('ArrowUp', 304, { ...right, shift: false })).toBeNull();
	});
});
