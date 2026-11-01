import { describe, expect, test } from 'bun:test';
import { STRIP_PEEK_SHARE, STRIP_SLACK_PX, isSettledSave, stripEdges, stripPeekWidth, stripWheelDelta, type StripWheel } from './keepNotesCompanion';

// The Notes companion's editor tools (KeepNotesView): the ink strip fades only on an edge with
// tools out of view and ends part-way through a tool, a wheel over the row moves it sideways,
// and the footer shows the save word whenever a save is not settled.

describe('stripEdges', () => {
	test('a strip that fits has no fade', () => {
		expect(stripEdges(0, 130, 130)).toEqual({ before: false, after: false });
	});

	test('overflow inside the last tool’s padding is not a cut glyph, so it has no fade', () => {
		expect(stripEdges(0, 130 + STRIP_SLACK_PX, 130)).toEqual({ before: false, after: false });
	});

	test('at the start only the end fades; at the end only the start; between, both', () => {
		expect(stripEdges(0, 130, 89)).toEqual({ before: false, after: true });
		expect(stripEdges(41, 130, 89)).toEqual({ before: true, after: false });
		expect(stripEdges(20, 130, 89)).toEqual({ before: true, after: true });
	});
});

describe('stripPeekWidth', () => {
	// Pen, Eraser, Shapes as measured at 13px with 5px padding.
	const tools = [31.5, 47, 51.9];

	test('a strip whose tools fit keeps its natural width', () => {
		expect(stripPeekWidth(140, tools)).toBeNull();
		expect(stripPeekWidth(130.4 - STRIP_SLACK_PX, tools)).toBeNull();
	});

	test('when the end would fall in the gap before a tool, it cuts through the one before instead', () => {
		// 85px of room (the 255px panel): Pen and Eraser fit (78.5) and only 6.5px of Shapes
		// would show, so the end stops 65% of the way through Eraser.
		expect(stripPeekWidth(85, tools)).toBeCloseTo(31.5 + 47 * (1 - STRIP_PEEK_SHARE), 6);
	});

	test('when enough of the next tool shows, the strip uses all its room', () => {
		expect(stripPeekWidth(100, tools)).toBe(100);
		// Not even the first tool fits: the strip takes what there is.
		expect(stripPeekWidth(20, tools)).toBe(20);
	});
});

describe('stripWheelDelta', () => {
	const base: StripWheel = { deltaX: 0, deltaY: 100, deltaMode: 0, inStrip: false, scrollLeft: 0, maxScroll: 41, pageWidth: 89 };

	test('a plain wheel turn over the row moves the strip sideways, clamped to its end', () => {
		expect(stripWheelDelta(base)).toBe(41);
		expect(stripWheelDelta({ ...base, deltaY: 10 })).toBe(10);
		expect(stripWheelDelta({ ...base, deltaY: -100, scrollLeft: 41 })).toBe(-41);
	});

	test('line and page wheel steps are converted to pixels', () => {
		expect(stripWheelDelta({ ...base, deltaY: 1, deltaMode: 1, maxScroll: 400 })).toBe(16);
		expect(stripWheelDelta({ ...base, deltaY: 1, deltaMode: 2, maxScroll: 400 })).toBe(89);
	});

	test('nothing to scroll, or already at that end, leaves the event to the browser', () => {
		expect(stripWheelDelta({ ...base, maxScroll: 0 })).toBe(0);
		expect(stripWheelDelta({ ...base, deltaY: -100 })).toBe(0);
		expect(stripWheelDelta({ ...base, scrollLeft: 41 })).toBe(0);
		expect(stripWheelDelta({ ...base, deltaY: 0 })).toBe(0);
	});

	test('a sideways gesture over the strip itself scrolls natively; over a pinned tool it moves the strip', () => {
		expect(stripWheelDelta({ ...base, deltaX: 30, deltaY: 0, inStrip: true })).toBe(0);
		expect(stripWheelDelta({ ...base, deltaX: 30, deltaY: 0, inStrip: false })).toBe(30);
	});
});

describe('isSettledSave', () => {
	test('only a finished save is settled', () => {
		expect(isSettledSave('Saved on this device')).toBe(true);
		expect(isSettledSave(' Saved 09:41 ')).toBe(true);
		for (const word of ['Saving…', 'Unsaved changes', 'Conflicting changes', 'Could not save', '']) {
			expect(isSettledSave(word)).toBe(false);
		}
	});
});
