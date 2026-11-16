import { expect, test } from 'bun:test';
import { accept, callAt, suggest, typedName } from './autocomplete';
import { FUNCTION_CATALOG } from './functionCatalog';
import { FORMULA_FUNCTIONS } from './formula';

const names = (text: string) => suggest(text, text.length, FUNCTION_CATALOG).map((item) => item.name);

test('the catalog and the calculator offer exactly the same functions', () => {
	expect(FUNCTION_CATALOG.map((item) => item.name).sort()).toEqual([...FORMULA_FUNCTIONS].sort());
	for (const item of FUNCTION_CATALOG) {
		expect(item.signature.startsWith(`${item.name}(`)).toBe(true);
		expect(item.summary.length).toBeGreaterThan(5);
	}
});

test('typing a letter after = offers matching functions, alphabetically', () => {
	expect(names('=S')).toEqual(['SUM', 'SUMIF']);
	expect(names('=su')).toEqual(['SUM', 'SUMIF']);
	expect(names('=CO')).toEqual(['CONCAT', 'COUNT', 'COUNTA', 'COUNTIF']);
	expect(names('=SUM(1,a')).toEqual(['ABS', 'AND', 'AVERAGE']);
	expect(names('=1+m')).toEqual(['MAX', 'MIN']);
});

test('nothing is offered where a function cannot start', () => {
	expect(names('=')).toEqual([]);
	expect(names('S')).toEqual([]);
	expect(names('=1 s')).toEqual([]);
	expect(names('=A1')).toEqual([]);
	expect(names('=b12')).toEqual([]);
	expect(names('="su')).toEqual([]);
	expect(names('=ZZZ')).toEqual([]);
});

test('no suggestion while the caret is inside a longer name', () => {
	expect(suggest('=SUM', 3, FUNCTION_CATALOG)).toEqual([]);
	expect(typedName('=SUM', 4)).toEqual({ start: 1, prefix: 'SUM' });
});

test('accepting writes the name and an open bracket, with the caret inside it', () => {
	expect(accept('=su', 3, 'SUM')).toEqual({ text: '=SUM(', caret: 5 });
	expect(accept('=1+a', 4, 'AVERAGE')).toEqual({ text: '=1+AVERAGE(', caret: 11 });
	expect(accept('=IF(m', 5, 'MAX')).toEqual({ text: '=IF(MAX(', caret: 8 });
});

test('accepting before an existing bracket does not add a second one', () => {
	expect(accept('=su(A1)', 3, 'SUM')).toEqual({ text: '=SUM(A1)', caret: 5 });
});

test('the argument hint names the call and which argument the caret is in', () => {
	expect(callAt('=SUM(', 5)).toEqual({ name: 'SUM', argIndex: 0 });
	expect(callAt('=IF(A1>1,', 9)).toEqual({ name: 'IF', argIndex: 1 });
	expect(callAt('=IF(A1>1,"a,b",', 15)).toEqual({ name: 'IF', argIndex: 2 });
	expect(callAt('=IF(A1,SUM(B1,', 14)).toEqual({ name: 'SUM', argIndex: 1 });
	expect(callAt('=IF(A1,SUM(B1,B2),', 18)).toEqual({ name: 'IF', argIndex: 2 });
});

test('no hint outside a call, in a bare bracket, or in plain text', () => {
	expect(callAt('=1+2', 4)).toBeNull();
	expect(callAt('=(1+2', 5)).toBeNull();
	expect(callAt('SUM(', 4)).toBeNull();
	expect(callAt('=SUM(1)', 7)).toBeNull();
});
