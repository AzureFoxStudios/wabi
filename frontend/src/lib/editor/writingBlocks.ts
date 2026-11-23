/**
 * Line-level block edits for the writing surface's Word-style keys: headings (Ctrl Alt 1-3,
 * Ctrl Alt 0 / Ctrl Shift N for Normal) and lists (Ctrl Shift L / 8 bullets, Ctrl Shift 7
 * numbers). The planning functions are pure over an `EditorState`, so they are tested without a
 * view; the commands dispatch the planned changes as typing (one undo step, selection mapped).
 * Lines inside a fenced code block are never touched.
 */
import type { ChangeSpec, EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING_MARK = /^( {0,3})(#{1,6})(?:[ \t]+|$)/;
const BULLET_MARK = /^(\s*)([-*+]\s+(?:\[[ xX]\]\s+)?)/;
const NUMBER_MARK = /^(\s*)(\d+[.)]\s+)/;

export type HeadingLevel = 0 | 1 | 2 | 3;
export type ListKind = 'bullet' | 'number';

/** Line numbers (1-based) that sit in a fenced code block, fence lines included. */
export function fencedLines(state: EditorState): Set<number> {
	const inside = new Set<number>();
	let fence: string | null = null;
	for (let number = 1; number <= state.doc.lines; number += 1) {
		const match = FENCE.exec(state.doc.line(number).text);
		if (fence !== null) {
			inside.add(number);
			if (match && match[1][0] === fence[0] && match[1].length >= fence.length) fence = null;
		} else if (match) {
			fence = match[1];
			inside.add(number);
		}
	}
	return inside;
}

/**
 * The lines a block key acts on: every line a selection touches (a selection that ends at the
 * very start of a line leaves that line out), outside fenced code.
 */
export function targetLines(state: EditorState): number[] {
	const fenced = fencedLines(state);
	const numbers = new Set<number>();
	for (const range of state.selection.ranges) {
		const first = state.doc.lineAt(range.from).number;
		let last = state.doc.lineAt(range.to).number;
		if (!range.empty && last > first && range.to === state.doc.line(last).from) last -= 1;
		for (let number = first; number <= last; number += 1) if (!fenced.has(number)) numbers.add(number);
	}
	return [...numbers].sort((a, b) => a - b);
}

/** Changes that set the target lines to heading `level` (0 is Normal); pressing the level every line already has returns them to Normal. Null when no line can change. */
export function headingChanges(state: EditorState, level: HeadingLevel): ChangeSpec[] | null {
	const lines = targetLines(state).map((number) => state.doc.line(number));
	if (lines.length === 0) return null;
	const current = (text: string) => HEADING_MARK.exec(text)?.[2].length ?? 0;
	const want: number = level !== 0 && lines.every((row) => current(row.text) === level) ? 0 : level;
	const changes: ChangeSpec[] = [];
	for (const row of lines) {
		const mark = HEADING_MARK.exec(row.text);
		if (current(row.text) === want) continue;
		const insert = want === 0 ? '' : `${'#'.repeat(want)} `;
		changes.push({ from: row.from, to: row.from + (mark ? mark[0].length : 0), insert });
	}
	return changes.length ? changes : null;
}

/** Changes that toggle a bulleted or numbered list on the target lines; null when nothing can change. */
export function listChanges(state: EditorState, kind: ListKind): ChangeSpec[] | null {
	const all = targetLines(state).map((number) => state.doc.line(number));
	// Blank lines in a multi-line selection are left alone; a lone blank caret line still starts a list.
	const filled = all.filter((row) => row.text.trim() !== '');
	const lines = filled.length ? filled : all;
	if (lines.length === 0) return null;
	const own = kind === 'bullet' ? BULLET_MARK : NUMBER_MARK;
	const other = kind === 'bullet' ? NUMBER_MARK : BULLET_MARK;
	const changes: ChangeSpec[] = [];
	if (lines.every((row) => own.test(row.text))) {
		for (const row of lines) {
			const mark = own.exec(row.text)!;
			changes.push({ from: row.from + mark[1].length, to: row.from + mark[0].length, insert: '' });
		}
		return changes;
	}
	lines.forEach((row, index) => {
		const marker = kind === 'bullet' ? '- ' : `${index + 1}. `;
		const mine = own.exec(row.text);
		if (mine && kind === 'bullet') return;
		const foreign = other.exec(row.text);
		const indent = (mine ?? foreign)?.[1].length ?? row.text.length - row.text.trimStart().length;
		const end = mine ? mine[0].length : foreign ? foreign[0].length : indent;
		changes.push({ from: row.from + indent, to: row.from + end, insert: marker });
	});
	return changes.length ? changes : null;
}

function run(view: EditorView, changes: ChangeSpec[] | null): boolean {
	if (!changes) return false;
	view.dispatch({ changes, userEvent: 'input.format', scrollIntoView: true });
	return true;
}

/** Set the caret's (or each selected) line to a heading level, or Normal for 0. */
export function setHeading(view: EditorView, level: HeadingLevel): boolean {
	if (view.state.readOnly) return false;
	return run(view, headingChanges(view.state, level));
}

/** Toggle a bulleted or numbered list on the caret's (or each selected) line. */
export function toggleList(view: EditorView, kind: ListKind): boolean {
	if (view.state.readOnly) return false;
	return run(view, listChanges(view.state, kind));
}
