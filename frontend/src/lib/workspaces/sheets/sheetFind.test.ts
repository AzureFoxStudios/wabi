import { expect, test } from 'bun:test';
import { findCells, replaceInput, stepHit, type FindCell, type FindOptions } from './sheetFind';

const cells: FindCell[] = [
	{ r: 2, c: 1, input: 'Hello world' }, { r: 0, c: 3, input: 'hello' }, { r: 0, c: 0, input: '=SUM(A1:A3)' },
	{ r: 1, c: 0, input: 'HELLO' }, { r: 3, c: 0, input: 'goodbye' }
];
const opts = (query: string, extra: Partial<FindOptions> = {}): FindOptions => ({ query, caseSensitive: false, wholeCell: false, ...extra });

test('finds cells containing the text, in reading order, ignoring case by default', () => {
	expect(findCells(cells, opts('hello'))).toEqual([{ r: 0, c: 3 }, { r: 1, c: 0 }, { r: 2, c: 1 }]);
});

test('match case and entire cell narrow it', () => {
	// "Hello world" and "HELLO" differ in case, so only the lower-case cell matches
	expect(findCells(cells, opts('hello', { caseSensitive: true }))).toEqual([{ r: 0, c: 3 }]);
	expect(findCells(cells, opts('hello', { wholeCell: true }))).toEqual([{ r: 0, c: 3 }, { r: 1, c: 0 }]);
	expect(findCells(cells, opts('hello', { wholeCell: true, caseSensitive: true }))).toEqual([{ r: 0, c: 3 }]);
});

test('formulas are searched as typed, and an empty query finds nothing', () => {
	expect(findCells(cells, opts('sum('))).toEqual([{ r: 0, c: 0 }]);
	expect(findCells(cells, opts(''))).toEqual([]);
});

test('stepping goes to the next hit in reading order and wraps', () => {
	const hits = findCells(cells, opts('hello'));
	expect(stepHit(hits, null, true)).toBe(0);
	expect(stepHit(hits, { r: 0, c: 3 }, true)).toBe(1);
	expect(stepHit(hits, { r: 2, c: 1 }, true)).toBe(0);
	expect(stepHit(hits, { r: 0, c: 0 }, true)).toBe(0);
	expect(stepHit(hits, { r: 1, c: 0 }, false)).toBe(0);
	expect(stepHit(hits, { r: 0, c: 3 }, false)).toBe(2);
	expect(stepHit(hits, null, false)).toBe(2);
	expect(stepHit([], null, true)).toBe(-1);
});

test('replace swaps every occurrence in a cell, keeping the rest', () => {
	expect(replaceInput('Hello hello', opts('hello'), 'bye')).toBe('bye bye');
	expect(replaceInput('Hello hello', opts('hello', { caseSensitive: true }), 'bye')).toBe('Hello bye');
	expect(replaceInput('nothing', opts('hello'), 'bye')).toBeNull();
});

test('an entire-cell replace swaps the whole cell', () => {
	expect(replaceInput('hello', opts('hello', { wholeCell: true }), 'a b')).toBe('a b');
	expect(replaceInput('hello there', opts('hello', { wholeCell: true }), 'x')).toBeNull();
});

test('what is typed is literal: regex characters and $ patterns mean nothing', () => {
	expect(replaceInput('a.b', opts('.'), '$&')).toBe('a$&b');
	expect(replaceInput('1+1=2', opts('+'), '-')).toBe('1-1=2');
	expect(findCells([{ r: 0, c: 0, input: 'a*b' }], opts('*'))).toEqual([{ r: 0, c: 0 }]);
});
