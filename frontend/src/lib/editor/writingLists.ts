/**
 * List keys for the writing surface: Tab / Shift-Tab indent and outdent list items the way Word
 * does, and Enter continues a list (or ends it on an empty item).
 *
 * - Tab on a list line indents it by two spaces (a nested list); Shift-Tab takes them back. Over
 *   a selection that spans several lines, Tab / Shift-Tab indent / outdent every line (blank
 *   lines are left alone). Anywhere else Tab returns false, so the browser moves focus and a
 *   keyboard user is never trapped. Fenced code is only indented by a multi-line selection.
 * - Enter runs `@codemirror/lang-markdown`'s `insertNewlineContinueMarkup` (new `- `, `1. ` or
 *   `- [ ] ` marker at the same indent; numbers count up; an empty item ends the list), except
 *   inside fenced code, where it stays a plain newline.
 *
 * `indentChanges` is pure over an `EditorState`, so it is tested without a view.
 */
import type { ChangeSpec, EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown';
import { fencedLines } from './writingBlocks';

export const LIST_INDENT = '  ';
const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])(?:\s|$)/;
const LEADING = /^(?: {1,2}|\t)/;

/**
 * Changes that indent (`direction` 1) or outdent (-1) the lines the selection touches, or null
 * when Tab should keep its browser meaning (a caret or one-line selection off a list line) or
 * there is nothing to change.
 */
export function indentChanges(state: EditorState, direction: 1 | -1): ChangeSpec[] | null {
	if (state.readOnly) return null;
	const { doc } = state;
	const fenced = fencedLines(state);
	const numbers = new Set<number>();
	let multi = false;
	let listLine = false;
	for (const range of state.selection.ranges) {
		const first = doc.lineAt(range.from).number;
		let last = doc.lineAt(range.to).number;
		if (!range.empty && last > first && range.to === doc.line(last).from) last -= 1;
		if (last > first) multi = true;
		for (let number = first; number <= last; number += 1) {
			numbers.add(number);
			if (LIST_LINE.test(doc.line(number).text) && !fenced.has(number)) listLine = true;
		}
	}
	if (!multi && !listLine) return null;
	const changes: ChangeSpec[] = [];
	for (const number of [...numbers].sort((a, b) => a - b)) {
		const row = doc.line(number);
		if (row.text.trim() === '') continue;
		// A single line only moves when it is a list item (checked above); a multi-line selection moves every line.
		if (direction === 1) changes.push({ from: row.from, insert: LIST_INDENT });
		else {
			const lead = LEADING.exec(row.text);
			if (lead) changes.push({ from: row.from, to: row.from + lead[0].length });
		}
	}
	return changes.length ? changes : null;
}

function indent(view: EditorView, direction: 1 | -1): boolean {
	const changes = indentChanges(view.state, direction);
	// Off a list line (or when nothing can move) the key falls through to the browser.
	if (!changes) return false;
	view.dispatch({ changes, userEvent: direction === 1 ? 'input.indent' : 'delete.dedent', scrollIntoView: true });
	return true;
}

export const indentListMore = (view: EditorView): boolean => indent(view, 1);
export const indentListLess = (view: EditorView): boolean => indent(view, -1);

const continueList = insertNewlineContinueMarkupCommand({ nonTightLists: false });

/** Enter: continue the list or quote; false (a plain Enter) off Markdown markup and inside fenced code. */
export function continueMarkup(view: EditorView): boolean {
	const { state } = view;
	if (state.readOnly) return false;
	const fenced = fencedLines(state);
	for (const range of state.selection.ranges) {
		if (fenced.has(state.doc.lineAt(range.head).number)) return false;
	}
	return continueList(view);
}
