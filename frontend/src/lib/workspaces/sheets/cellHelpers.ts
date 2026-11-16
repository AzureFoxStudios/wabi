/**
 * Small pure rules behind Excel-style shortcuts and hints in the grid: what an error means, what
 * Ctrl+; writes, and which cells Alt+= adds up.
 */
import type { Pos } from './gridNav';

const ERROR_HINTS: Record<string, string> = {
	'#REF!': 'This formula points at a cell, row or column that no longer exists.',
	'#CYCLE!': 'This formula refers to itself, directly or through other cells.',
	'#DIV/0!': 'This formula divides by zero or by an empty cell.',
	'#VALUE!': 'A value in this formula is the wrong kind, for example text where a number is needed.',
	'#NAME?': 'This formula uses a name Wabi does not recognise, such as a function that does not exist.',
	'#N/A': 'No matching value was found.',
	'#NUM!': 'The result is not a usable number, or an argument is out of range.',
	'#ARGS!': 'This function was given too many or too few arguments.',
	'#PARSE!': 'This formula could not be read. Check the brackets, commas and quotes.',
	'#UNSUPPORTED!': 'This formula uses something Wabi cannot calculate yet.',
	'#LIMIT!': 'This calculation is larger than Wabi will run.',
	'#CONFLICT!': 'Two people changed this cell at once. Type a new value to choose one.',
	'#DATE!': 'This is not a date Wabi can show.'
};

/** A sentence for an error value shown in a cell, or null when the text is not an error. */
export function explainError(shown: string): string | null {
	const code = shown.trim().split(/\s/)[0];
	return ERROR_HINTS[code] ?? null;
}

/** The Excel serial number for a calendar day (1 = 1900-01-01 as Excel counts, 25569 = 1970-01-01). */
export function excelSerial(date: Date): number {
	return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000) + 25_569;
}

export interface SumRange { from: Pos; to: Pos }

/**
 * Alt+=. The run of numbers directly above the cell, or, when there is none above, directly to its
 * left. A cell that is not a number ends the run, so a heading above a column is never summed.
 */
export function autoSumRange(isNumber: (cell: Pos) => boolean, at: Pos): SumRange | null {
	let r = at.r - 1;
	while (r >= 0 && isNumber({ r, c: at.c })) r--;
	if (r < at.r - 1) return { from: { r: r + 1, c: at.c }, to: { r: at.r - 1, c: at.c } };
	let c = at.c - 1;
	while (c >= 0 && isNumber({ r: at.r, c })) c--;
	if (c < at.c - 1) return { from: { r: at.r, c: c + 1 }, to: { r: at.r, c: at.c - 1 } };
	return null;
}
