import { describe, expect, test } from 'bun:test';
import * as XLSX from 'xlsx';
import { exportBook, importBook, officeCell, safeText, zipLimits } from './fileAdapter';
import { parseFormula, type CellVersion, type Scalar, type WorkbookSnapshot } from './formula';

function fixture(values: Scalar[]): WorkbookSnapshot {
    return { sheets: [{ id: 'sheet', name: 'ข้อมูล', rows: [{ id: 'row', position: 0 }], columns: values.map((_, i) => ({ id: `col${i}`, position: i })), cells: Object.fromEntries(values.map((value, i) => [`row|col${i}`, [{ id: `value${i}`, cell: `row|col${i}`, parents: [], input: String(value ?? ''), literal: value }]])) }] };
}
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe('spreadsheet file safety and declared round trip', () => {
    test('CSV text preserves Thai, leading zeros, quotes, dates, and formula-looking strings', async () => {
        const imported = await importBook(bytes('\ufeff00123,"สวัสดี, ไทย","line\nnext",=1+1,2026-09-18\n'), 'source.csv');
        const cells = imported.sheets[0].cells;
        expect(cells.map(cell => cell.literal)).toEqual(['00123', 'สวัสดี, ไทย', 'line\nnext', '=1+1', '2026-09-18']);
        expect(cells.every(cell => cell.cached === undefined)).toBe(true);
    });
    test('TSV and invalid UTF-8 are handled explicitly', async () => {
        expect((await importBook(bytes('007\tไทย\tfalse'), 'source.tsv')).sheets[0].cells.map(cell => cell.literal)).toEqual(['007', 'ไทย', 'false']);
        await expect(importBook(new Uint8Array([0xff, 0xff]).buffer, 'invalid.csv')).rejects.toThrow();
    });
    test('safe-text output protects prefixes without changing actual numbers', () => {
        for (const value of ['=1+1', '+cmd', '-cmd', '@SUM(A1)', ' \t=1', '\u0000=1']) expect(safeText(value)).toBe("'" + value);
        expect(safeText(-23)).toBe('-23');
        expect(safeText('00123')).toBe('00123');
        expect(safeText(false)).toBe('false');
    });
    for (const format of ['xlsx', 'ods']) {
        test(`${format} retains literal cells as non-formula typed values`, async () => {
            const values = ['=1+1', '=WEBSERVICE("https://example.invalid")', '00123', 'ไทย', 0, false, ''];
            const book = fixture(values), result = await exportBook(book, format, 'sheet');
            zipLimits(result.bytes);
            const output = XLSX.read(result.bytes, { type: 'array', cellFormula: true });
            const sheet = output.Sheets[output.SheetNames[0]];
            for (let i = 0; i < values.length; i++) {
                const cell = sheet[XLSX.utils.encode_cell({ r: 0, c: i })];
                expect(cell?.f).toBeUndefined();
                if (values[i] !== '') expect(cell.v).toBe(values[i]);
            }
            const imported = await importBook(result.bytes, `roundtrip.${format}`);
            expect(imported.sheets[0].cells[0].literal).toBe('=1+1');
        });
    }
    test('supported native expressions export as formulas, unknown/external formulas do not', async () => {
        const book = fixture([2, 3, null]);
        const version: CellVersion = { id: 'sum', cell: 'row|col2', parents: [], input: '=SUM(A1:B1)', expression: parseFormula('=SUM(A1:B1)', book, 'sheet') };
        book.sheets[0].cells['row|col2'] = [version];
        expect(officeCell(version, book, 'sheet', 5).f).toBe('SUM(A1:B1)');
        const result = await exportBook(book, 'xlsx', 'sheet');
        const output = XLSX.read(result.bytes, { type: 'array' });
        expect(output.Sheets[output.SheetNames[0]].C1.f).toBe('SUM(A1:B1)');
        const external: CellVersion = { id: 'external', cell: 'row|col2', parents: [], input: '=WEBSERVICE("https://example.invalid")', parseError: '#UNSUPPORTED!', cached: 'old result' };
        expect(officeCell(external, book, 'sheet', null, '#UNSUPPORTED!')).toEqual({ t: 's', v: external.input });
    });
    test('CSV export contains only selected sheet values and neutralizes literal formulas', async () => {
        const book = fixture(['=1+1', '00123', -23]);
        book.sheets.push({ ...fixture(['PRIVATE']).sheets[0], id: 'hidden', name: 'Other' });
        const output = new TextDecoder().decode((await exportBook(book, 'csv', 'sheet')).bytes);
        expect(output).toContain("'=1+1");
        expect(output).toContain('00123');
        expect(output).not.toContain('PRIVATE');
        await expect(exportBook(book, 'csv', 'missing')).rejects.toThrow('no longer available');
    });
    test('malformed archives and unsupported types fail before conversion', async () => {
        for (const value of [new ArrayBuffer(0), new ArrayBuffer(22), bytes('not a zip')]) expect(() => zipLimits(value)).toThrow();
        await expect(importBook(bytes('text'), 'source.xlsm')).rejects.toThrow('Supported imports');
        await expect(importBook(new ArrayBuffer(12 * 1024 * 1024 + 1), 'source.csv')).rejects.toThrow('12 MB');
    });
});
