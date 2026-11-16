import { expect, test } from 'bun:test';
import { cycleAbsolute, findRefs, shiftFormulaText } from './refText';

test('finds references, ranges, sheet prefixes and $ markers', () => {
	const refs = findRefs("=SUM(A1:B2)+Data!$C3+'My Sheet'!D$4");
	expect(refs.map((r) => [r.sheet, r.absCol, r.col, r.absRow, r.row])).toEqual([
		['', false, 'A', false, 1],
		['', false, 'B', false, 2],
		['Data!', true, 'C', false, 3],
		["'My Sheet'!", false, 'D', true, 4]
	]);
});

test('strings, function names and numbers are not references', () => {
	expect(findRefs('=LOG10(100)+"A1"+1E5')).toEqual([]);
	expect(findRefs('=CONCAT("x ""B2"" y",C3)').map((r) => r.col + r.row)).toEqual(['C3']);
	expect(findRefs('=ATAN2(1,2)')).toEqual([]);
});

test('paste moves relative references and keeps the ones marked $', () => {
	expect(shiftFormulaText('=A1+B2', 1, 1)).toBe('=B2+C3');
	expect(shiftFormulaText('=$A1+B$2', 2, 3)).toBe('=$A3+E$2');
	expect(shiftFormulaText('=SUM(A1:A10)', 0, 1)).toBe('=SUM(B1:B10)');
	expect(shiftFormulaText('=Data!B2*2', 3, 0)).toBe('=Data!B5*2');
});

test('strings inside the formula are not touched', () => {
	expect(shiftFormulaText('=IF(A1="A1",B1,"B1")', 1, 0)).toBe('=IF(A2="A1",B2,"B1")');
});

test('a reference pushed off the sheet becomes #REF!', () => {
	expect(shiftFormulaText('=A1', -1, 0)).toBe('=#REF!');
	expect(shiftFormulaText('=B1+C1', 0, -2)).toBe('=#REF!+A1');
	expect(shiftFormulaText('=A10000', 1, 0)).toBe('=#REF!');
	// IV is column 256, the last one the grid supports.
	expect(shiftFormulaText('=IU1', 0, 1)).toBe('=IV1');
	expect(shiftFormulaText('=IV1', 0, 1)).toBe('=#REF!');
});

test('text that is not a formula, and a zero shift, are unchanged', () => {
	expect(shiftFormulaText('A1+B2', 1, 1)).toBe('A1+B2');
	expect(shiftFormulaText('=A1', 0, 0)).toBe('=A1');
});

test('F4 cycles A1, $A$1, A$1, $A1 and back', () => {
	let text = '=A1+B1';
	const states: string[] = [];
	for (let i = 0; i < 4; i++) {
		const result = cycleAbsolute(text, 2, 2)!;
		text = result.text;
		states.push(text);
	}
	expect(states).toEqual(['=$A$1+B1', '=A$1+B1', '=$A1+B1', '=A1+B1']);
});

test('F4 on a range cycles both ends together and selects what changed', () => {
	const result = cycleAbsolute('=SUM(A1:B2)', 6, 6)!;
	expect(result.text).toBe('=SUM($A$1:$B$2)');
	expect(result.selStart).toBe(5);
	expect(result.selEnd).toBe(result.text.length - 1);
	expect(cycleAbsolute(result.text, 8, 8)!.text).toBe('=SUM(A$1:B$2)');
});

test('F4 works with the caret just after a reference, and finds nothing elsewhere', () => {
	expect(cycleAbsolute('=A1', 3, 3)!.text).toBe('=$A$1');
	expect(cycleAbsolute('=SUM(', 5, 5)).toBeNull();
	expect(cycleAbsolute('=1+2', 2, 2)).toBeNull();
});

test('F4 keeps a sheet prefix', () => {
	expect(cycleAbsolute('=Data!B2', 8, 8)!.text).toBe('=Data!$B$2');
});
