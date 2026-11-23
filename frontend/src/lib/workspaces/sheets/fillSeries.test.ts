import { expect, test } from 'bun:test';
import { fillValues } from './fillSeries';

const inputs = (source: string[], count: number) => fillValues(source, count).map((cell) => cell.input);

test('two numbers continue the series by their step', () => {
	expect(inputs(['1', '2'], 3)).toEqual(['3', '4', '5']);
	expect(inputs(['10', '20', '30'], 2)).toEqual(['40', '50']);
	expect(inputs(['5', '3'], 3)).toEqual(['1', '-1', '-3']);
	expect(inputs(['0.1', '0.2'], 2)).toEqual(['0.3', '0.4']);
});

test('a single number is copied, not counted up', () => {
	expect(inputs(['7'], 3)).toEqual(['7', '7', '7']);
});

test('a single text ending in a number counts up, keeping leading zeros', () => {
	expect(inputs(['Item 1'], 3)).toEqual(['Item 2', 'Item 3', 'Item 4']);
	expect(inputs(['A007'], 2)).toEqual(['A008', 'A009']);
	expect(inputs(['Q9'], 2)).toEqual(['Q10', 'Q11']);
});

test('text without a trailing number is copied', () => {
	expect(inputs(['hello'], 2)).toEqual(['hello', 'hello']);
	expect(inputs(['1 apple'], 2)).toEqual(['1 apple', '1 apple']);
});

test('several mixed cells repeat in order', () => {
	expect(inputs(['a', 'b'], 5)).toEqual(['a', 'b', 'a', 'b', 'a']);
	expect(inputs(['1', 'x'], 3)).toEqual(['1', 'x', '1']);
});

test('formulas are copied and report how far they have moved', () => {
	expect(fillValues(['=A1*2'], 3)).toEqual([{ input: '=A1*2', shift: 1 }, { input: '=A1*2', shift: 2 }, { input: '=A1*2', shift: 3 }]);
	// a block of two repeats; the second pass has moved two cells from where it came
	expect(fillValues(['=A1', '=B1'], 4).map((cell) => cell.shift)).toEqual([2, 2, 4, 4]);
});

test('nothing to fill, nothing to write', () => {
	expect(fillValues([], 3)).toEqual([]);
	expect(fillValues(['1'], 0)).toEqual([]);
});
