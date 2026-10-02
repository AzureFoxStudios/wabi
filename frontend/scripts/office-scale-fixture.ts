import type { WorkbookSnapshot, SheetSnapshot } from '../src/lib/workspaces/sheets/formula';

/** Deterministic, synthetic calculation data; no user data or persisted artifacts.
 * Reused by unit and real-browser worker tests. This does not bypass import limits.
 */
export function createScaleFixture(rowCount = 10000, columnCount = 20): WorkbookSnapshot {
    if (!Number.isInteger(rowCount) || !Number.isInteger(columnCount) || rowCount < 1 || rowCount > 10000 || columnCount < 1 || columnCount > 20) throw new Error('Invalid scale fixture dimensions');
    const sheet: SheetSnapshot = {
        id: 'data', name: 'Data',
        rows: Array.from({ length: rowCount }, (_, i) => ({ id: `r${i}`, position: i })),
        columns: Array.from({ length: columnCount }, (_, i) => ({ id: `c${i}`, position: i })),
        cells: {}
    };
    for (let r = 0; r < rowCount; r++) for (let c = 0; c < columnCount; c++) {
        const key = `r${r}|c${c}`, n = r * columnCount + c + 1;
        sheet.cells[key] = [{ id: `v${n}`, cell: key, input: String(n), literal: n, parents: [] }];
    }
    return { sheets: [sheet] };
}
