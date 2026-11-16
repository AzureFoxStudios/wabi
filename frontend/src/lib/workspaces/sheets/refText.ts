/**
 * Cell references inside formula *text*: find them, shift them for paste, cycle $ with F4.
 *
 * This reads the text the user sees ("=SUM(A1:B2)+Data!$C3"), never the stored expression, so it
 * works on a clipboard that came from another sheet or workbook. The reference shape mirrors the
 * calculator's tokenizer in formula.ts (optional sheet prefix, optional $ on either part, up to
 * four letters, a row from 1). String literals are skipped, and a name followed by "(" such as
 * LOG10( is a function, not a cell.
 */
import { columnIndex, columnName } from './formula';

export interface RefMatch {
	start: number;
	end: number;
	/** The sheet prefix as written, including its "!" (empty when there is none). */
	sheet: string;
	absCol: boolean;
	col: string;
	absRow: boolean;
	row: number;
}

const REF_SOURCE = String.raw`(?<![A-Za-z0-9_.$'])((?:'(?:[^']|'')+'!|[A-Za-z_][A-Za-z0-9_ ]*!)?)(\$?)([A-Za-z]{1,4})(\$?)([1-9]\d*)(?![A-Za-z0-9_(])`;

export function findRefs(text: string): RefMatch[] {
	const pattern = new RegExp(`"(?:[^"]|"")*"|${REF_SOURCE}`, 'g');
	const found: RefMatch[] = [];
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text))) {
		if (match[3] === undefined) continue; // a string literal
		found.push({
			start: match.index,
			end: match.index + match[0].length,
			sheet: match[1],
			absCol: match[2] === '$',
			col: match[3].toUpperCase(),
			absRow: match[4] === '$',
			row: Number(match[5])
		});
	}
	return found;
}

function render(ref: Pick<RefMatch, 'sheet' | 'absCol' | 'col' | 'absRow' | 'row'>): string {
	return `${ref.sheet}${ref.absCol ? '$' : ''}${ref.col}${ref.absRow ? '$' : ''}${ref.row}`;
}

export interface Limits { rows: number; columns: number }
const DEFAULT_LIMITS: Limits = { rows: 10000, columns: 256 };

/**
 * The formula as it reads after moving `dr` rows and `dc` columns: relative parts move, parts
 * marked $ stay. A reference pushed off the sheet becomes #REF!, as in Excel. Not a formula: unchanged.
 */
export function shiftFormulaText(input: string, dr: number, dc: number, limits: Limits = DEFAULT_LIMITS): string {
	if (!input.startsWith('=') || (dr === 0 && dc === 0)) return input;
	let out = '';
	let at = 0;
	for (const ref of findRefs(input)) {
		const column = ref.absCol ? columnIndex(ref.col) : columnIndex(ref.col) + dc;
		const row = ref.absRow ? ref.row : ref.row + dr;
		out += input.slice(at, ref.start);
		out += column < 0 || column >= limits.columns || row < 1 || row > limits.rows
			? '#REF!'
			: render({ ...ref, col: columnName(column), row });
		at = ref.end;
	}
	return out + input.slice(at);
}

export interface CycleResult { text: string; selStart: number; selEnd: number }

// F4: A1 → $A$1 → A$1 → $A1 → A1, keyed by "column absolute, row absolute".
const NEXT: Record<string, [boolean, boolean]> = {
	'00': [true, true],
	'11': [false, true],
	'01': [true, false],
	'10': [false, false]
};

/**
 * F4 on the reference at the caret (or on the references a selection touches). A range such as
 * A1:B2 cycles as one. Returns null when there is no reference there.
 */
export function cycleAbsolute(text: string, start: number, end: number): CycleResult | null {
	const all = findRefs(text);
	const hit = all.filter((ref) => (start === end ? ref.start <= start && start <= ref.end : ref.end > start && ref.start < end));
	if (!hit.length) return null;
	const chosen = new Set(hit);
	for (const ref of hit) {
		if (text[ref.end] === ':') {
			const partner = all.find((other) => other.start === ref.end + 1);
			if (partner) chosen.add(partner);
		}
		if (ref.start > 0 && text[ref.start - 1] === ':') {
			const partner = all.find((other) => other.end === ref.start - 1);
			if (partner) chosen.add(partner);
		}
	}
	const targets = [...chosen].sort((a, b) => a.start - b.start);
	const [absCol, absRow] = NEXT[`${targets[0].absCol ? 1 : 0}${targets[0].absRow ? 1 : 0}`];
	let out = '';
	let at = 0;
	let selEnd = 0;
	for (const ref of targets) {
		out += text.slice(at, ref.start);
		out += render({ ...ref, absCol, absRow });
		selEnd = out.length;
		at = ref.end;
	}
	return { text: out + text.slice(at), selStart: targets[0].start, selEnd };
}
