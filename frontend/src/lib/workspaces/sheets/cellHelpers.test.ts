import { expect, test } from 'bun:test';
import { autoSumRange, excelSerial, explainError } from './cellHelpers';
import type { Pos } from './gridNav';

test('every error code the calculator produces has a plain-language hint', () => {
	for (const code of ['#REF!', '#CYCLE!', '#DIV/0!', '#VALUE!', '#NAME?', '#N/A', '#NUM!', '#ARGS!', '#PARSE!', '#UNSUPPORTED!', '#LIMIT!', '#CONFLICT!'])
		expect(explainError(code)?.length).toBeGreaterThan(10);
});

test('imported formulas show a result then a marker; the hint reads the code at the start', () => {
	expect(explainError('#REF! STALE')).toContain('no longer exists');
});

test('ordinary values have no hint', () => {
	for (const text of ['', '12', 'hello', '#hashtag', '#']) expect(explainError(text)).toBeNull();
});

test('Excel serial numbers: the epoch, a known date, and the day rolling at local midnight', () => {
	expect(excelSerial(new Date(1970, 0, 1))).toBe(25569);
	expect(excelSerial(new Date(2000, 0, 1))).toBe(36526);
	expect(excelSerial(new Date(2026, 10, 16, 23, 59))).toBe(excelSerial(new Date(2026, 10, 16, 0, 1)));
	expect(excelSerial(new Date(2026, 10, 17, 0, 1))).toBe(excelSerial(new Date(2026, 10, 16, 0, 1)) + 1);
});

const numbers = (cells: string[]) => { const set = new Set(cells); return (cell: Pos) => set.has(`${cell.r},${cell.c}`); };

test('AutoSum adds the run of numbers above, stopping at a heading', () => {
	expect(autoSumRange(numbers(['1,0', '2,0', '3,0']), { r: 4, c: 0 })).toEqual({ from: { r: 1, c: 0 }, to: { r: 3, c: 0 } });
	// row 0 is a text heading, so it is not included
	expect(autoSumRange(numbers(['1,2', '2,2']), { r: 3, c: 2 })).toEqual({ from: { r: 1, c: 2 }, to: { r: 2, c: 2 } });
});

test('with nothing numeric above, AutoSum adds the run to the left', () => {
	expect(autoSumRange(numbers(['2,0', '2,1', '2,2']), { r: 2, c: 3 })).toEqual({ from: { r: 2, c: 0 }, to: { r: 2, c: 2 } });
});

test('above wins over left, and nothing numeric gives no range', () => {
	expect(autoSumRange(numbers(['0,1', '1,0', '1,1']), { r: 2, c: 1 })).toEqual({ from: { r: 0, c: 1 }, to: { r: 1, c: 1 } });
	expect(autoSumRange(numbers([]), { r: 2, c: 2 })).toBeNull();
	expect(autoSumRange(numbers(['0,0']), { r: 0, c: 0 })).toBeNull();
});
