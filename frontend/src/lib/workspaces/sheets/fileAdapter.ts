import type { CellObject, WorkSheet } from 'xlsx';
import { zipLimits } from '../zipLimits';
import { calculate, columnName, cellKey, heads, renderFormula, literal, type WorkbookSnapshot, type Scalar, type CellVersion } from './formula';

export interface ImportedStyle { fill?: string; format?: 'number' | 'percent' | 'currency' | 'text' | 'date'; precision?: number; currency?: string; }
export interface ImportedCell { r: number; c: number; input: string; literal?: Scalar; cached?: Scalar; style?: ImportedStyle; }
export interface ImportedSheet { name: string; rows: number; columns: number; cells: ImportedCell[]; widths?: (number | undefined)[]; }
export interface ImportedWorkbook { sheets: ImportedSheet[]; warnings: string[]; }
const MB = 1024 * 1024;

// Re-exported for existing callers; the check itself is shared by all Office imports.
export { zipLimits } from '../zipLimits';

/** Light fills only: Wabi has no text colour, so a dark fill would hide the text. */
function importedFill(style: unknown): string | undefined {
    const s = style as { patternType?: string; fgColor?: { rgb?: string } } | undefined;
    const rgb = s?.patternType === 'solid' ? s.fgColor?.rgb : undefined;
    if (typeof rgb !== 'string' || !/^([0-9a-f]{2})?[0-9a-f]{6}$/i.test(rgb)) return undefined;
    const hex = rgb.slice(-6), n = parseInt(hex, 16), lum = (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    return lum >= 0.6 && lum < 0.999 ? '#' + hex.toLowerCase() : undefined;
}
/** The common Excel number formats that Wabi can display; anything else stays General. */
export function importedFormat(code: unknown): Pick<ImportedStyle, 'format' | 'precision' | 'currency'> {
    if (typeof code !== 'string' || !code || code.toLowerCase() === 'general') return {};
    const decimals = (code.split(';')[0].match(/\.(0+)/)?.[1].length) ?? 0;
    if (code === '@') return { format: 'text' };
    if (code.includes('%')) return { format: 'percent', precision: Math.min(10, decimals) };
    if (/y{2,4}/i.test(code) && /m/i.test(code)) return { format: 'date' };
    if (/[$฿€£¥]/.test(code)) return { format: 'currency', precision: Math.min(10, decimals), currency: code.includes('฿') ? 'THB' : code.includes('€') ? 'EUR' : code.includes('£') ? 'GBP' : code.includes('¥') ? 'JPY' : 'USD' };
    if (/^[#,0.]+$/.test(code.split(';')[0]) && /0/.test(code)) return { format: 'number', precision: Math.min(10, decimals) };
    return {};
}
export async function importBook(buffer: ArrayBuffer, name: string, delimiter?: string): Promise<ImportedWorkbook> {
    if (buffer.byteLength > 12 * MB) throw new Error('Spreadsheet import is limited to 12 MB.');
    const ext = name.split('.').pop()?.toLowerCase();
    if (!['csv', 'tsv', 'xlsx', 'ods'].includes(ext || '')) throw new Error('Supported imports are CSV, TSV, XLSX, and ODS.');
    if (ext === 'xlsx' || ext === 'ods') zipLimits(buffer);
    const XLSX = await import('xlsx');
    const text = ext === 'csv' || ext === 'tsv';
    const book = XLSX.read(text ? new TextDecoder('utf-8', { fatal: true }).decode(buffer) : buffer, { type: text ? 'string' : 'array', raw: text, cellFormula: true, cellDates: false, cellNF: true, cellStyles: !text, sheetStubs: !text, bookVBA: false, bookFiles: false, FS: delimiter || (ext === 'tsv' ? '\t' : ','), sheetRows: 10001 });
    if (!book.SheetNames.length || book.SheetNames.length > 20) throw new Error('This release supports 1–20 sheets.');
    let count = 0;
    const warnings = ['Imported copy: advanced formatting, external connections, macros, and embedded objects are not executed or preserved in the native model.', 'CSV/TSV uses UTF-8 and keeps every column as text, including formula-looking values and leading zeros.'];
    const sheets: ImportedSheet[] = book.SheetNames.map(sheetName => {
        const sheet = book.Sheets[sheetName];
        const range = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref'] || 'A1');
        if (range.e.r >= 10000 || range.e.c >= 256) throw new Error(`${sheetName} exceeds the supported 10,000-row / 256-column grid.`);
        const cells: ImportedCell[] = [];
        for (const address of Object.keys(sheet)) {
            if (address.startsWith('!')) continue;
            const position = XLSX.utils.decode_cell(address), cell = sheet[address];
            if (++count > 50000) throw new Error('Import is limited to 50,000 populated cells.');
            const fill = text ? undefined : importedFill(cell.s), numberFormat = text ? {} : importedFormat(cell.z);
            const style: ImportedStyle | undefined = fill || numberFormat.format ? { ...(fill ? { fill } : {}), ...numberFormat } : undefined;
            const value: Scalar = typeof cell.v === 'number' || typeof cell.v === 'boolean' || typeof cell.v === 'string' ? cell.v : null;
            // Delimited text never acquires executable formula semantics from a parser heuristic.
            const formula = !text && typeof cell.f === 'string' ? cell.f : null;
            const textValue = value === null ? null : String(value);
            if (value === null && !formula && !style) continue;
            cells.push({ r: position.r, c: position.c, input: formula ? '=' + formula : value === null ? '' : String(value), ...(formula ? { cached: value } : value === null ? {} : { literal: text ? textValue : value }), ...(style ? { style } : {}) });
        }
        if (sheet['!merges']?.length) warnings.push(`${sheetName}: merged-cell layout was not imported; values are retained.`);
        const widths = text ? undefined : ((sheet['!cols'] || []) as { wpx?: number }[]).map(col => (typeof col?.wpx === 'number' ? Math.max(60, Math.min(600, Math.round(col.wpx))) : undefined));
        return { name: sheetName, rows: Math.max(100, range.e.r + 1), columns: Math.max(20, range.e.c + 1), cells, ...(widths?.some(Boolean) ? { widths } : {}) };
    });
    return { sheets, warnings };
}

export function safeText(value: Scalar): string {
    if (value === null) return '';
    const text = String(value);
    return typeof value === 'string' && /^[\s\u0000-\u001f]*[=+@\-]/u.test(text) ? "'" + text : text;
}

/** Only a parsed, supported native expression may become an executable Office formula. */
export function officeCell(version: CellVersion, book: WorkbookSnapshot, sheetId: string, value: Scalar, error?: string): CellObject {
    if (version.literal !== undefined) {
        const val = version.literal;
        return { t: typeof val === 'number' ? 'n' : typeof val === 'boolean' ? 'b' : 's', v: val ?? '' };
    }
    if (version.expression) {
        return { t: typeof value === 'string' ? 's' : typeof value === 'boolean' ? 'b' : 'n', f: renderFormula(version.expression, book, sheetId).slice(1), ...(!error && value !== null ? { v: value } : {}) };
    }
    // Unknown/external formulas stay recoverable strings, never executable code in a recipient's app.
    if (version.parseError || version.input.startsWith('=')) return { t: 's', v: version.input };
    const val = literal(version.input);
    return { t: typeof val === 'number' ? 'n' : typeof val === 'boolean' ? 'b' : 's', v: val ?? '' };
}

export async function exportBook(book: WorkbookSnapshot, format: string, activeId: string): Promise<{ type: string; bytes: ArrayBuffer }> {
    if (!['csv', 'tsv', 'xlsx', 'ods'].includes(format)) throw new Error('Unsupported export format');
    const XLSX = await import('xlsx'), calculated = calculate(book), output = XLSX.utils.book_new();
    for (const sheet of book.sheets) {
        if ((format === 'csv' || format === 'tsv') && sheet.id !== activeId) continue;
        const ws: WorkSheet = {};
        for (let r = 0; r < sheet.rows.length; r++) for (let c = 0; c < sheet.columns.length; c++) {
            const id = cellKey(sheet.rows[r].id, sheet.columns[c].id), versions = heads(sheet.cells[id] || []);
            if (!versions.length) continue;
            if (versions.length > 1) throw new Error('Resolve conflicting cells before exporting a workbook.');
            const version = versions[0], calcId = `${sheet.id}/${id}`, error = calculated.errors[calcId], value = calculated.values[calcId] ?? null, address = columnName(c) + (r + 1);
            ws[address] = format === 'csv' || format === 'tsv' ? { t: 's', v: safeText(error || value) } : officeCell(version, book, sheet.id, value, error);
        }
        ws['!ref'] = `A1:${columnName(sheet.columns.length - 1)}${sheet.rows.length}`;
        const name = sheet.name.replace(/[\\/?*\[\]:]/g, ' ').slice(0, 31) || 'Sheet';
        let safe = name, suffix = 1;
        while (output.SheetNames.includes(safe)) safe = name.slice(0, 26) + ' ' + suffix++;
        XLSX.utils.book_append_sheet(output, ws, safe);
    }
    if (!output.SheetNames.length) throw new Error('The selected sheet is no longer available.');
    if (format === 'csv' || format === 'tsv') return { type: 'text/plain;charset=utf-8', bytes: new TextEncoder().encode(XLSX.utils.sheet_to_csv(output.Sheets[output.SheetNames[0]], { FS: format === 'tsv' ? '\t' : ',', blankrows: false })).buffer as ArrayBuffer };
    return { type: 'application/octet-stream', bytes: XLSX.write(output, { type: 'array', bookType: format as 'xlsx' | 'ods', compression: true }) as ArrayBuffer };
}
