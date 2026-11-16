import { expect, test } from 'bun:test';
import { arrowAction, canPoint, liveSpan, pointInsert, refLabel } from './pointMode';

test('a reference may be pointed at after =, an operator, an open bracket or a comma', () => {
	for (const text of ['=', '=A1+', '=SUM(', '=IF(A1>1,', '=A1 * ', '=A1<>', '=SUM(A1:']) {
		expect(canPoint(text, text.length)).toBe(true);
	}
});

test('not after a finished operand, a function name, a string or in plain text', () => {
	for (const text of ['=A1', '=SUM', '=A1)', '=1%', '="x"', '="a,', 'A1+', '', 'hello']) {
		expect(canPoint(text, text.length)).toBe(false);
	}
	// A comma inside a string is text; after the string closes it counts again.
	expect(canPoint('=IF(A1="a,', 10)).toBe(false);
	expect(canPoint('=IF(A1="a",', 11)).toBe(true);
});

test('not when the caret sits in front of part of a token', () => {
	expect(canPoint('=A1+B2', 4)).toBe(false); // before "B2"
	expect(canPoint('=A1+)', 4)).toBe(true);
	expect(canPoint('=A1+ ', 4)).toBe(true);
});

test('labels name a cell or a range from any two corners', () => {
	expect(refLabel({ r: 1, c: 1 }, { r: 1, c: 1 })).toBe('B2');
	expect(refLabel({ r: 1, c: 1 }, { r: 3, c: 2 })).toBe('B2:C4');
	expect(refLabel({ r: 3, c: 2 }, { r: 1, c: 1 })).toBe('B2:C4');
	expect(refLabel({ r: 0, c: 26 }, { r: 0, c: 26 })).toBe('AA1');
});

test('the first click inserts at the caret', () => {
	const result = pointInsert('=SUM(', 5, 'B2', null);
	expect(result.text).toBe('=SUM(B2');
	expect(result.caret).toBe(7);
	expect(result.span).toEqual({ start: 5, end: 7, label: 'B2' });
});

test('the next click replaces it, and a drag widens it to a range', () => {
	const first = pointInsert('=SUM(', 5, 'B2', null);
	const second = pointInsert(first.text, first.caret, 'C3', first.span);
	expect(second.text).toBe('=SUM(C3');
	const dragged = pointInsert(second.text, second.caret, 'C3:D6', second.span);
	expect(dragged.text).toBe('=SUM(C3:D6');
	expect(dragged.caret).toBe(10);
});

test('text after the caret is kept', () => {
	const first = pointInsert('=IF(,1,2)', 4, 'A1', null);
	expect(first.text).toBe('=IF(A1,1,2)');
	expect(pointInsert(first.text, first.caret, 'B1', first.span).text).toBe('=IF(B1,1,2)');
});

test('typing after a point-mode reference ends the replacement', () => {
	const first = pointInsert('=', 1, 'A1', null);
	const typed = first.text + '+';
	expect(liveSpan(typed, first.span)).toEqual(first.span); // text before it is unchanged
	expect(liveSpan('=B1+', first.span)).toBeNull(); // the user edited it
	expect(pointInsert('=B1+', 4, 'C1', liveSpan('=B1+', first.span)).text).toBe('=B1+C1');
});

test('arrow keys: edit mode moves the caret, enter mode points or commits', () => {
	expect(arrowAction('edit', '=', 1, false)).toBe('caret');
	expect(arrowAction('enter', '=', 1, false)).toBe('point');
	expect(arrowAction('enter', '=SUM(', 5, false)).toBe('point');
	expect(arrowAction('enter', '=A1+B1', 6, false)).toBe('commit');
	expect(arrowAction('enter', '=A1', 3, true)).toBe('point'); // already pointing
	expect(arrowAction('enter', 'hello', 5, false)).toBe('commit');
});
