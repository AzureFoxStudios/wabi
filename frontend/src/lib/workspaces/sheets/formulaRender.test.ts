import { expect, test } from 'bun:test';
import * as Y from 'yjs';
import { initialize, orderedSheets, snapshot } from './model';
import { parseFormula, renderFormula } from './formula';

function book() {
	const doc = new Y.Doc();
	const data = doc.getMap('data');
	initialize(data);
	const sheetId = orderedSheets(data)[0].id;
	return { doc, snapshot: snapshot(data), sheetId };
}
const render = (text: string) => {
	const { snapshot: b, sheetId } = book();
	return renderFormula(parseFormula(text, b, sheetId), b, sheetId);
};

test('a formula comes back as it was typed, without added brackets', () => {
	expect(render('=A1*10')).toBe('=A1*10');
	expect(render('=A1+B1*C1')).toBe('=A1+B1*C1');
	expect(render('=SUM(A1:A3)/COUNT(A1:A3)')).toBe('=SUM(A1:A3)/COUNT(A1:A3)');
	expect(render('=IF(A1>5,"big","small")')).toBe('=IF(A1>5,"big","small")');
	expect(render('=A1&" "&B1')).toBe('=A1&" "&B1');
	expect(render('=-A1')).toBe('=-A1');
});

test('brackets the typist wrote stay where they change the meaning', () => {
	expect(render('=(A1+B1)*C1')).toBe('=(A1+B1)*C1');
	expect(render('=A1*(B1+C1)')).toBe('=A1*(B1+C1)');
	expect(render('=A1-(B1-C1)')).toBe('=A1-(B1-C1)');
	expect(render('=A1/(B1*C1)')).toBe('=A1/(B1*C1)');
	expect(render('=-(A1+B1)')).toBe('=-(A1+B1)');
});

test('brackets that change nothing are dropped', () => {
	expect(render('=(A1*B1)+C1')).toBe('=A1*B1+C1');
	expect(render('=A1+(B1*C1)')).toBe('=A1+B1*C1');
	expect(render('=((A1))')).toBe('=A1');
	expect(render('=A1-B1-C1')).toBe('=A1-B1-C1');
});

test('^ is right-associative and keeps the brackets that say otherwise', () => {
	expect(render('=A1^B1^C1')).toBe('=A1^B1^C1');
	expect(render('=(A1^B1)^C1')).toBe('=(A1^B1)^C1');
	expect(render('=A1^(B1^C1)')).toBe('=A1^B1^C1');
	expect(render('=(-A1)^2')).toBe('=(-A1)^2');
	expect(render('=2^-A1')).toBe('=2^-A1');
});

test('a percent sign is the division it stands for', () => {
	expect(render('=A1%')).toBe('=A1/100');
});

test('rendering never changes what a formula means: re-parsing gives the same expression', () => {
	const { snapshot: b, sheetId } = book();
	const cases = [
		'=A1*10', '=A1+B1*C1', '=(A1+B1)*C1', '=A1-(B1-C1)', '=A1-B1-C1', '=A1/(B1*C1)', '=A1^B1^C1', '=(A1^B1)^C1',
		'=-(A1+B1)', '=-A1^2', '=(-A1)^2', '=2^-A1', '=A1=B1', '=A1<>B1+1', '=A1&B1&C1', '=A1&(B1&C1)', '=(A1>1)+(B1<2)',
		'=SUM(A1,B1*2,(C1+1)*3)', '=IF(A1>1,A1*2,A1-(B1+C1))', '=-(-A1)', '=A1*-B1', '=A1+-B1', '=2*(3+4)^2', '=(2*3)^2', '=A1%+B1%'
	];
	for (const text of cases) {
		const once = parseFormula(text, b, sheetId);
		const printed = renderFormula(once, b, sheetId);
		const twice = parseFormula(printed, b, sheetId);
		expect({ text, tree: twice }).toEqual({ text, tree: once });
		// and rendering is stable: printing the re-parsed formula gives the same text
		expect(renderFormula(twice, b, sheetId)).toBe(printed);
	}
});
