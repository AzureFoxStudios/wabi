import { expect, test } from 'bun:test';
import { commitDirection, endTarget, homeTarget, jumpTarget, pageTarget, stepTo, type Pos } from './gridNav';

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
