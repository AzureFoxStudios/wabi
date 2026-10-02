import type { CellObject, WorkSheet } from 'xlsx';
import { calculate, columnName, cellKey, heads, renderFormula, literal, type WorkbookSnapshot, type Scalar, type CellVersion } from './formula';

export interface ImportedCell { r: number; c: number; input: string; literal?: Scalar; cached?: Scalar; }
export interface ImportedSheet { name: string; rows: number; columns: number; cells: ImportedCell[]; }
export interface ImportedWorkbook { sheets: ImportedSheet[]; warnings: string[]; }
const MB = 1024 * 1024;

/** Validate the central directory before the format adapter allocates expanded data. */
export function zipLimits(buffer: ArrayBuffer): void {
    const view = new DataView(buffer);
    let end = -1;
    for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
        if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === buffer.byteLength) { end = i; break; }
    }
    if (end < 0) throw new Error('Invalid or unsupported Office archive.');
    const count = view.getUint16(end + 10, true), offset = view.getUint32(end + 16, true), directorySize = view.getUint32(end + 12, true);
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || !count || count > 4096 || offset + directorySize !== end) throw new Error('Multipart, ZIP64, or invalid Office archive directory.');
    let at = offset, total = 0;
    const names = new Set<string>();
    for (let i = 0; i < count; i++) {
        if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) throw new Error('Invalid Office archive directory.');
        const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true), compressed = view.getUint32(at + 20, true), size = view.getUint32(at + 24, true);
        const nameSize = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true), local = view.getUint32(at + 42, true);
        const next = at + 46 + nameSize + extra + comment;
        if (next > end || flags & 1 || ![0, 8].includes(method) || size === 0xffffffff || size > 24 * MB || size > Math.max(1, compressed) * 250 || local + 30 > offset) throw new Error('Encrypted or over-expanded Office archive is not supported.');
        const name = new TextDecoder().decode(new Uint8Array(buffer, at + 46, nameSize));
        if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || names.has(name)) throw new Error('Unsafe or duplicate Office archive entry.');
        names.add(name);
        if (view.getUint32(local, true) !== 0x04034b50 || view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method) throw new Error('Office archive headers disagree.');
        const localNameSize = view.getUint16(local + 26, true), localExtra = view.getUint16(local + 28, true);
        if (local + 30 + localNameSize + localExtra + compressed > offset || localNameSize !== nameSize || new TextDecoder().decode(new Uint8Array(buffer, local + 30, localNameSize)) !== name) throw new Error('Invalid Office archive entry bounds.');
        if (!(flags & 8) && (view.getUint32(local + 18, true) !== compressed || view.getUint32(local + 22, true) !== size)) throw new Error('Office archive sizes disagree.');
        total += size;
        if (total > 64 * MB) throw new Error('Office archive expands beyond the safe import limit.');
        at = next;
    }
    if (at !== end) throw new Error('Invalid Office archive directory size.');
}

export async function importBook(buffer: ArrayBuffer, name: string, delimiter?: string): Promise<ImportedWorkbook> {
    if (buffer.byteLength > 12 * MB) throw new Error('Spreadsheet import is limited to 12 MB.');
    const ext = name.split('.').pop()?.toLowerCase();
    if (!['csv', 'tsv', 'xlsx', 'ods'].includes(ext || '')) throw new Error('Supported imports are CSV, TSV, XLSX, and ODS.');
    if (ext === 'xlsx' || ext === 'ods') zipLimits(buffer);
    const XLSX = await import('xlsx');
    const text = ext === 'csv' || ext === 'tsv';
    const book = XLSX.read(text ? new TextDecoder('utf-8', { fatal: true }).decode(buffer) : buffer, { type: text ? 'string' : 'array', raw: text, cellFormula: true, cellDates: false, cellNF: true, bookVBA: false, bookFiles: false, FS: delimiter || (ext === 'tsv' ? '\t' : ','), sheetRows: 10001 });
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
            const value: Scalar = typeof cell.v === 'number' || typeof cell.v === 'boolean' || typeof cell.v === 'string' ? cell.v : null;
            // Delimited text never acquires executable formula semantics from a parser heuristic.
            const formula = !text && typeof cell.f === 'string' ? cell.f : null;
            const textValue = value === null ? null : String(value);
            cells.push({ r: position.r, c: position.c, input: formula ? '=' + formula : value === null ? '' : String(value), ...(formula ? { cached: value } : { literal: text ? textValue : value }) });
        }
        if (sheet['!merges']?.length) warnings.push(`${sheetName}: merged-cell layout was not imported; values are retained.`);
        return { name: sheetName, rows: Math.max(100, range.e.r + 1), columns: Math.max(20, range.e.c + 1), cells };
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
