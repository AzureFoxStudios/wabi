import { expect, test } from 'bun:test';
import { accept, callAt, signatureParts, suggest, typedName } from './autocomplete';
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

// Asserts what must hold however many functions exist, so adding one never breaks this test:
// every result starts with the typed letters, the list is alphabetical and capped, and the
// functions people reach for first are in it.
function expectOffers(text: string, prefix: string, mustInclude: string[]) {
	const found = names(text);
	expect(found.length).toBeGreaterThan(0);
	expect(found.length).toBeLessThanOrEqual(8);
	for (const name of found) expect(name.startsWith(prefix)).toBe(true);
	expect(found).toEqual([...found].sort());
	for (const name of mustInclude) expect(found).toContain(name);
}

test('typing a letter after = offers matching functions, alphabetically', () => {
	expectOffers('=S', 'S', ['SUM']);
	expectOffers('=su', 'SU', ['SUM', 'SUMIF']);
	expectOffers('=CO', 'CO', ['CONCAT', 'COUNT', 'COUNTA', 'COUNTIF']);
	expectOffers('=SUM(1,a', 'A', ['ABS', 'AND', 'AVERAGE']);
	expectOffers('=1+m', 'M', ['MAX', 'MIN']);
});

test('a longer prefix narrows the list, and an exact name still lists itself first', () => {
	expect(names('=SUM')[0]).toBe('SUM');
	expect(names('=sumif').slice(0, 2)).toEqual(['SUMIF', 'SUMIFS']);
	expect(names('=vlook')).toEqual(['VLOOKUP']);
});

test('the lookup, text, date and error-handling functions Excel users reach for are offered', () => {
	for (const name of ['VLOOKUP', 'XLOOKUP', 'INDEX', 'MATCH', 'IFERROR', 'TEXT', 'LEFT', 'TODAY', 'DATE', 'SUMIFS', 'COUNTIFS'])
		expect(FUNCTION_CATALOG.map((item) => item.name)).toContain(name);
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

test('the signature is split around the argument being typed', () => {
	expect(signatureParts('IF(logical_test, value_if_true, [value_if_false])', 1)).toEqual({
		before: 'IF(logical_test, ', current: 'value_if_true', after: ', [value_if_false])'
	});
	expect(signatureParts('ABS(number)', 0)).toEqual({ before: 'ABS(', current: 'number', after: ')' });
	expect(signatureParts('ABS(number)', 3)).toEqual({ before: 'ABS(number)', current: '', after: '' });
});

test('a variadic signature keeps highlighting its last real argument', () => {
	const sig = 'SUM(number1, [number2], …)';
	expect(signatureParts(sig, 0).current).toBe('number1');
	expect(signatureParts(sig, 1).current).toBe('[number2]');
	expect(signatureParts(sig, 7).current).toBe('[number2]');
});

test('no hint outside a call, in a bare bracket, or in plain text', () => {
	expect(callAt('=1+2', 4)).toBeNull();
	expect(callAt('=(1+2', 5)).toBeNull();
	expect(callAt('SUM(', 4)).toBeNull();
	expect(callAt('=SUM(1)', 7)).toBeNull();
});
