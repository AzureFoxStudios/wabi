/**
 * Find and replace across a sheet, as pure functions over cell inputs (what was typed, so a
 * formula is searched as its text, like Excel's default "look in formulas").
 */
export interface FindCell { r: number; c: number; input: string }
export interface FindOptions { query: string; caseSensitive: boolean; wholeCell: boolean }
export interface Hit { r: number; c: number }

const fold = (text: string, options: FindOptions) => (options.caseSensitive ? text : text.toLocaleLowerCase());

function matches(input: string, options: FindOptions): boolean {
	if (!options.query) return false;
	const text = fold(input, options);
	const query = fold(options.query, options);
	return options.wholeCell ? text === query : text.includes(query);
}

/** Matching cells in reading order (row by row, left to right). */
export function findCells(cells: readonly FindCell[], options: FindOptions): Hit[] {
	return cells
		.filter((cell) => matches(cell.input, options))
		.sort((a, b) => a.r - b.r || a.c - b.c)
		.map(({ r, c }) => ({ r, c }));
}

/** The next hit after `from` (wrapping), or the previous one; -1 when there are none. */
export function stepHit(hits: readonly Hit[], from: Hit | null, forward: boolean): number {
	if (hits.length === 0) return -1;
	if (!from) return forward ? 0 : hits.length - 1;
	const after = (hit: Hit) => hit.r > from.r || (hit.r === from.r && hit.c > from.c);
	const before = (hit: Hit) => hit.r < from.r || (hit.r === from.r && hit.c < from.c);
	if (forward) { const index = hits.findIndex(after); return index < 0 ? 0 : index; }
	for (let i = hits.length - 1; i >= 0; i--) if (before(hits[i])) return i;
	return hits.length - 1;
}

function escapeRegExp(text: string) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** The cell's input with every match replaced, or null when nothing matched. A whole-cell search replaces the whole cell. */
export function replaceInput(input: string, options: FindOptions, replacement: string): string | null {
	if (!matches(input, options)) return null;
	if (options.wholeCell) return replacement;
	const pattern = new RegExp(escapeRegExp(options.query), options.caseSensitive ? 'gu' : 'giu');
	// A function replacement, so "$&" or "$1" in what the user typed stays literal text.
	return input.replace(pattern, () => replacement);
}
