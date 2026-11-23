/**
 * The spreadsheet clipboard, as pure functions.
 *
 * Copying writes two things at once. `text/plain` is what other applications get: the values as they
 * are shown, with anything that could run as a formula elsewhere quoted. A second, Wabi-only payload
 * carries the cells as typed, formulas included, so pasting inside Wabi behaves like Excel: formulas
 * come along and their relative references move with them. Wabi never trusts that payload: it is
 * validated before use, and anything that is not exactly this shape falls back to the plain text.
 */
import { shiftFormulaText, type Limits } from './refText';

export const WABI_CELLS_MIME = 'application/x-wabi-cells+json';
/** The most cells one copy, paste or clear touches. */
export const MAX_CLIP_CELLS = 2000;
const MAX_CELL_LENGTH = 8192;

export interface CellClip {
	v: 1;
	rows: number;
	columns: number;
	/** The inputs as typed, row by row; formulas are written as A1 text. */
	cells: string[][];
	/** The top-left cell that was copied, as row and column indexes. */
	origin: { r: number; c: number };
	cut: boolean;
}

export interface DisplayCell { text: string; numeric: boolean }

const quote = (text: string) => (/[\t\r\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text);

/**
 * Tab-separated text for other applications. A shown value that starts with = + @ or - and is not a
 * number is prefixed with an apostrophe so it cannot become a formula in the application it lands in.
 */
export function valuesToTsv(rows: DisplayCell[][]): string {
	return rows
		.map((row) => row.map((cell) => quote(!cell.numeric && /^[=+@-]/.test(cell.text) ? "'" + cell.text : cell.text)).join('\t'))
		.join('\n');
}

/** Tab-separated text into rows and cells. Quoted fields may hold tabs and newlines. */
export function parseTsv(text: string): string[][] {
	const result: string[][] = [[]];
	let field = '';
	let quoted = false;
	for (let index = 0; index < text.length; index++) {
		const c = text[index];
		if (c === '"' && (quoted || field === '')) {
			if (quoted && text[index + 1] === '"') { field += '"'; index++; } else quoted = !quoted;
		} else if (!quoted && (c === '\t' || c === '\n')) {
			result.at(-1)!.push(field.replace(/\r$/, ''));
			field = '';
			if (c === '\n') result.push([]);
		} else field += c;
	}
	result.at(-1)!.push(field.replace(/\r$/, ''));
	// Every spreadsheet ends its text with a newline; that is not another row.
	if (result.length > 1 && result.at(-1)!.length === 1 && result.at(-1)![0] === '') result.pop();
	if (quoted) throw new Error('Pasted table has an unclosed quote.');
	return result;
}

const isIndex = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/** The Wabi payload, or null when it is missing, malformed, oversized or not ours. */
export function parseClip(json: string | undefined | null): CellClip | null {
	if (!json || json.length > 4 * 1024 * 1024) return null;
	let data: unknown;
	try { data = JSON.parse(json); } catch { return null; }
	if (typeof data !== 'object' || data === null) return null;
	const clip = data as Partial<CellClip>;
	if (clip.v !== 1 || typeof clip.cut !== 'boolean') return null;
	if (!isIndex(clip.rows) || !isIndex(clip.columns) || clip.rows < 1 || clip.columns < 1) return null;
	if (clip.rows * clip.columns > MAX_CLIP_CELLS) return null;
	if (!clip.origin || !isIndex(clip.origin.r) || !isIndex(clip.origin.c)) return null;
	if (!Array.isArray(clip.cells) || clip.cells.length !== clip.rows) return null;
	for (const row of clip.cells) {
		if (!Array.isArray(row) || row.length !== clip.columns) return null;
		for (const cell of row) if (typeof cell !== 'string' || cell.length > MAX_CELL_LENGTH) return null;
	}
	return { v: 1, rows: clip.rows, columns: clip.columns, cells: clip.cells, origin: { r: clip.origin.r, c: clip.origin.c }, cut: clip.cut };
}

export interface Placement { r: number; c: number; input: string }
export interface Bounds { r0: number; r1: number; c0: number; c1: number }

/**
 * Where each copied cell lands. One copied cell pasted over a selection fills the whole selection
 * (as Excel does); anything else lands as a block from the active cell. Relative references in
 * formulas move by the distance from where they were copied.
 */
export function placeClip(clip: CellClip, anchor: { r: number; c: number }, selection: Bounds | null, limits?: Limits): Placement[] {
	const placements: Placement[] = [];
	const area = selection ? (selection.r1 - selection.r0 + 1) * (selection.c1 - selection.c0 + 1) : 0;
	if (clip.rows === 1 && clip.columns === 1 && selection && area > 1) {
		for (let r = selection.r0; r <= selection.r1; r++)
			for (let c = selection.c0; c <= selection.c1; c++)
				placements.push({ r, c, input: shiftFormulaText(clip.cells[0][0], r - clip.origin.r, c - clip.origin.c, limits) });
		return placements;
	}
	const dr = anchor.r - clip.origin.r;
	const dc = anchor.c - clip.origin.c;
	for (let i = 0; i < clip.rows; i++)
		for (let j = 0; j < clip.columns; j++)
			placements.push({ r: anchor.r + i, c: anchor.c + j, input: shiftFormulaText(clip.cells[i][j], dr, dc, limits) });
	return placements;
}

/** What a fill (Ctrl+D, Ctrl+R) writes: `source` copied into each target, references shifted by the distance. */
export function fillPlacements(source: { r: number; c: number; input: string }, targets: { r: number; c: number }[], limits?: Limits): Placement[] {
	return targets.map((target) => ({ ...target, input: shiftFormulaText(source.input, target.r - source.r, target.c - source.c, limits) }));
}
