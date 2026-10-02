import { expect, test } from 'bun:test';
import { calculate, parseFormula, type Axis, type SheetSnapshot, type WorkbookSnapshot } from './formula';
import { createScaleFixture } from '../../../../scripts/office-scale-fixture';

function summary(book: WorkbookSnapshot, inputs: string[]): SheetSnapshot {
    const sheet: SheetSnapshot = {
        id: 'summary', name: 'Summary',
        rows: inputs.map((_, i) => ({ id: `s${i}`, position: i })), columns: [{ id: 'value', position: 0 }], cells: {}
    };
    book.sheets.push(sheet);
    inputs.forEach((input, i) => {
        const key = `s${i}|value`;
        sheet.cells[key] = [{ id: `summary-${i}`, cell: key, input, parents: [], expression: parseFormula(input, book, sheet.id) }];
    });
    return sheet;
}

test('axis lookup work is linear in axes, not populated cells times row count', () => {
    const book = createScaleFixture(1000, 20);
    let rowReads = 0, columnReads = 0;
    book.sheets[0].rows = book.sheets[0].rows.map((row): Axis => ({ position: row.position, get id() { rowReads++; return row.id; } }));
    book.sheets[0].columns = book.sheets[0].columns.map((column): Axis => ({ position: column.position, get id() { columnReads++; return column.id; } }));
    const result = calculate(book);
    expect(Object.keys(result.values).length).toBe(20000);
    expect(result.errors).toEqual({});
    expect(rowReads).toBeLessThanOrEqual(2000);
    expect(columnReads).toBeLessThanOrEqual(40);
});

test('calculates 200,000 values and cross-sheet totals without changing input', () => {
    const book = createScaleFixture();
    summary(book, ['=SUM(Data!A1:T5000)', '=SUM(Data!A5001:T10000)', '=A1+A2']);
    const before = JSON.stringify(book.sheets[0].cells['r9999|c19']);
    const started = performance.now(), result = calculate(book), elapsedMs = performance.now() - started;
    expect(result.errors).toEqual({});
    expect(Object.keys(result.values).length).toBe(200003);
    expect(result.values['data/r0|c0']).toBe(1);
    expect(result.values['data/r9999|c19']).toBe(200000);
    expect(result.values['summary/s0|value']).toBe(100000 * 100001 / 2);
    expect(result.values['summary/s2|value']).toBe(200000 * 200001 / 2);
    expect(JSON.stringify(book.sheets[0].cells['r9999|c19'])).toBe(before);
    console.log(JSON.stringify({ fixture: 'calculation-only-200000-cells', elapsedMs, outputCells: Object.keys(result.values).length, errors: 0 }));
}, 30000);

test('new snapshots rebuild row positions and preserve stable references after reordering', () => {
    const book = createScaleFixture(3, 2);
    summary(book, ['=Data!A2', '=SUM(Data!A1:A2)']);
    expect(calculate(book).values['summary/s0|value']).toBe(3);
    expect(calculate(book).values['summary/s1|value']).toBe(4);
    const rows = book.sheets[0].rows;
    book.sheets[0].rows = [rows[0], rows[2], rows[1]];
    expect(calculate(book).values['summary/s0|value']).toBe(3);
    expect(calculate(book).values['summary/s1|value']).toBe(9);
    book.sheets[0].rows = [rows[0], rows[2]];
    const removed = calculate(book);
    expect(removed.errors['summary/s0|value']).toBe('#REF!');
    expect(removed.errors['summary/s1|value']).toBe('#REF!');
    expect(removed.values['summary/s0|value']).toBeUndefined();
});

test('budget exhaustion marks later cells as LIMIT instead of leaving unexplained blanks', () => {
    const book = createScaleFixture(5000, 20);
    const sheet = summary(book, Array.from({ length: 22 }, () => '=SUM(Data!A1:T5000)'));
    const result = calculate(book);
    for (const key of Object.keys(sheet.cells)) {
        const id = `${sheet.id}/${key}`;
        expect(Object.hasOwn(result.values, id) || Object.hasOwn(result.errors, id)).toBe(true);
    }
    expect(result.values['summary/s0|value']).toBe(100000 * 100001 / 2);
    expect(result.errors['summary/s21|value']).toBe('#LIMIT!');
    expect(result.values['summary/s21|value']).toBeUndefined();
}, 30000);

test('the single-range safety bound is not raised by the larger calculation fixture', () => {
    const book = createScaleFixture();
    summary(book, ['=SUM(Data!A1:T10000)']);
    const result = calculate(book);
    expect(result.errors['summary/s0|value']).toBe('#LIMIT!');
    expect(Object.keys(result.values).length).toBe(200000);
}, 30000);

test('cycles and competing values still produce explicit diagnostics', () => {
    const book = createScaleFixture(1, 2), sheet = book.sheets[0];
    sheet.cells['r0|c0'] = [{ id: 'a', cell: 'r0|c0', input: '=B1', parents: [], expression: parseFormula('=B1', book, sheet.id) }];
    sheet.cells['r0|c1'] = [{ id: 'b', cell: 'r0|c1', input: '=A1', parents: [], expression: parseFormula('=A1', book, sheet.id) }];
    const cycle = calculate(book);
    expect(cycle.errors['data/r0|c0']).toBe('#CYCLE!'); expect(cycle.errors['data/r0|c1']).toBe('#CYCLE!');
    sheet.cells['r0|c0'] = [{ id: 'one', cell: 'r0|c0', input: '12', parents: [] }, { id: 'two', cell: 'r0|c0', input: '13', parents: [] }];
    const conflict = calculate(book);
    expect(conflict.errors['data/r0|c0']).toBe('#CONFLICT!'); expect(conflict.errors['data/r0|c1']).toBe('#CONFLICT!');
});
