import { expect, test } from 'bun:test';
import { commitDirection, endTarget, homeTarget, jumpTarget, nextInRange, pageTarget, parseAddress, stepTo, type Pos } from './gridNav';

/** A column of data at C: rows 2-4 filled, a gap, then rows 7-8 filled. */
const data = new Set(['1,2', '2,2', '3,2', '6,2', '7,2']);
const filled = (cell: Pos) => data.has(`${cell.r},${cell.c}`);
const ROWS = 20;
const COLUMNS = 10;

test('Ctrl+Down inside a run goes to the end of the run', () => {
	expect(jumpTarget(filled, { r: 1, c: 2 }, 'down', ROWS, COLUMNS)).toEqual({ r: 3, c: 2 });
});

test('Ctrl+Down from the end of a run jumps the gap to the next filled cell', () => {
	expect(jumpTarget(filled, { r: 3, c: 2 }, 'down', ROWS, COLUMNS)).toEqual({ r: 6, c: 2 });
});

test('Ctrl+Down from an empty cell goes to the next filled cell', () => {
	expect(jumpTarget(filled, { r: 4, c: 2 }, 'down', ROWS, COLUMNS)).toEqual({ r: 6, c: 2 });
});

test('with nothing further, Ctrl+Arrow goes to the edge of the sheet', () => {
	expect(jumpTarget(filled, { r: 7, c: 2 }, 'down', ROWS, COLUMNS)).toEqual({ r: ROWS - 1, c: 2 });
	expect(jumpTarget(filled, { r: 0, c: 5 }, 'down', ROWS, COLUMNS)).toEqual({ r: ROWS - 1, c: 5 });
	expect(jumpTarget(filled, { r: 0, c: 5 }, 'right', ROWS, COLUMNS)).toEqual({ r: 0, c: COLUMNS - 1 });
	expect(jumpTarget(filled, { r: 5, c: 5 }, 'left', ROWS, COLUMNS)).toEqual({ r: 5, c: 0 });
});

test('Ctrl+Up works the other way, and stays put at the edge', () => {
	expect(jumpTarget(filled, { r: 7, c: 2 }, 'up', ROWS, COLUMNS)).toEqual({ r: 6, c: 2 });
	expect(jumpTarget(filled, { r: 6, c: 2 }, 'up', ROWS, COLUMNS)).toEqual({ r: 3, c: 2 });
	expect(jumpTarget(filled, { r: 0, c: 2 }, 'up', ROWS, COLUMNS)).toEqual({ r: 0, c: 2 });
	expect(jumpTarget(filled, { r: 4, c: 9 }, 'right', ROWS, COLUMNS)).toEqual({ r: 4, c: 9 });
});

test('single steps stay inside the sheet', () => {
	expect(stepTo({ r: 0, c: 0 }, 'up', ROWS, COLUMNS)).toEqual({ r: 0, c: 0 });
	expect(stepTo({ r: 19, c: 9 }, 'down', ROWS, COLUMNS)).toEqual({ r: 19, c: 9 });
	expect(stepTo({ r: 3, c: 3 }, 'right', ROWS, COLUMNS)).toEqual({ r: 3, c: 4 });
});

test('Home, Ctrl+Home, Ctrl+End and paging', () => {
	expect(homeTarget({ r: 5, c: 7 }, false)).toEqual({ r: 5, c: 0 });
	expect(homeTarget({ r: 5, c: 7 }, true)).toEqual({ r: 0, c: 0 });
	expect(endTarget([{ r: 3, c: 9 }, { r: 12, c: 2 }])).toEqual({ r: 12, c: 9 });
	expect(endTarget([])).toEqual({ r: 0, c: 0 });
	expect(pageTarget({ r: 5, c: 3 }, 1, 15, ROWS)).toEqual({ r: 19, c: 3 });
	expect(pageTarget({ r: 5, c: 3 }, -1, 15, ROWS)).toEqual({ r: 0, c: 3 });
});

test('Enter and Tab commit in the direction Excel moves', () => {
	expect(commitDirection('Enter', false)).toBe('down');
	expect(commitDirection('Enter', true)).toBe('up');
	expect(commitDirection('Tab', false)).toBe('right');
	expect(commitDirection('Tab', true)).toBe('left');
});

test('the name box takes a cell or a range, any case, with or without $', () => {
	expect(parseAddress('B7', 100, 20)).toEqual({ from: { r: 6, c: 1 }, to: null });
	expect(parseAddress(' c12 ', 100, 20)).toEqual({ from: { r: 11, c: 2 }, to: null });
	expect(parseAddress('$B$7', 100, 20)).toEqual({ from: { r: 6, c: 1 }, to: null });
	expect(parseAddress('B2:D9', 100, 20)).toEqual({ from: { r: 1, c: 1 }, to: { r: 8, c: 3 } });
	expect(parseAddress('b2 : d9', 100, 20)).toEqual({ from: { r: 1, c: 1 }, to: { r: 8, c: 3 } });
	expect(parseAddress('AA1', 100, 30)).toEqual({ from: { r: 0, c: 26 }, to: null });
});

test('anything that is not an address on this sheet is refused', () => {
	for (const text of ['', 'hello', 'B0', '7', 'B', 'B7:', 'B7:C', '=B7', 'B7 C7', 'ZZZZ1']) expect(parseAddress(text, 100, 20)).toBeNull();
	expect(parseAddress('B101', 100, 20)).toBeNull(); // beyond the last row
	expect(parseAddress('U1', 100, 20)).toBeNull(); // beyond the last column (T)
	expect(parseAddress('A1:B101', 100, 20)).toBeNull(); // the far end counts too
});

const box = { r0: 1, r1: 3, c0: 1, c1: 2 }; // B2:C4

test('Enter moves down a column of the selection, then on to the next column, and wraps', () => {
	expect(nextInRange(box, { r: 1, c: 1 }, 'Enter', false)).toEqual({ r: 2, c: 1 });
	expect(nextInRange(box, { r: 3, c: 1 }, 'Enter', false)).toEqual({ r: 1, c: 2 });
	expect(nextInRange(box, { r: 3, c: 2 }, 'Enter', false)).toEqual({ r: 1, c: 1 });
});

test('Shift+Enter reverses it, including the wrap', () => {
	expect(nextInRange(box, { r: 2, c: 1 }, 'Enter', true)).toEqual({ r: 1, c: 1 });
	expect(nextInRange(box, { r: 1, c: 2 }, 'Enter', true)).toEqual({ r: 3, c: 1 });
	expect(nextInRange(box, { r: 1, c: 1 }, 'Enter', true)).toEqual({ r: 3, c: 2 });
});

test('Tab moves along a row of the selection, then on to the next row, and wraps', () => {
	expect(nextInRange(box, { r: 1, c: 1 }, 'Tab', false)).toEqual({ r: 1, c: 2 });
	expect(nextInRange(box, { r: 1, c: 2 }, 'Tab', false)).toEqual({ r: 2, c: 1 });
	expect(nextInRange(box, { r: 3, c: 2 }, 'Tab', false)).toEqual({ r: 1, c: 1 });
	expect(nextInRange(box, { r: 2, c: 1 }, 'Tab', true)).toEqual({ r: 1, c: 2 });
	expect(nextInRange(box, { r: 1, c: 1 }, 'Tab', true)).toEqual({ r: 3, c: 2 });
});

test('visiting every cell once, Enter covers the whole selection', () => {
	const seen = new Set<string>();
	let at: Pos = { r: 1, c: 1 };
	for (let i = 0; i < 6; i++) { seen.add(`${at.r},${at.c}`); at = nextInRange(box, at, 'Enter', false); }
	expect(seen.size).toBe(6);
	expect(at).toEqual({ r: 1, c: 1 });
});
