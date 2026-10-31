/**
 * The writing surface as CodeMirror extensions (design contract §7.15, §8.7, §8.8): what turns
 * `CodeMirrorEditor` in prose mode into a page you write on rather than a code field.
 *
 * - `markdownLineStyles`: heading lines take the serif heading sizes and their `#` markers hang
 *   in the left margin in faint mono; list, quote and fence markers go faint; quote lines get the
 *   prose quote rule; fenced lines read as code. Classes only (`cm-w-*`); the look lives with the
 *   surface's CSS (WritingEditor.svelte), so every theme answers through roles.
 * - `selectionReporter`: measures the main selection after every change that can move it, for
 *   the selection bubble. It reports `null` while the selection is empty or the editor is blurred.
 * - `writingKeymap`: Ctrl B / I / Shift X / E / Shift K for Bold, Italic, Strikethrough, Inline
 *   code and Link (Ctrl K stays the jump palette, D13), and Alt F10 to reach the bubble from the
 *   keyboard.
 * - `runEdit`, `formatSelection`, `linkAtSelection`, `insertAtSelection`, `insertText`: dispatch
 *   the pure edits from writingMarkdown.ts as user input, so the host's update listener (and
 *   undo history) treats them like typing.
 */
import { Prec, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, keymap, placeholder as placeholderText, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import {
	activeMarks,
	insertInline,
	insertKind,
	linkSelection,
	toggleInlineMark,
	type Box,
	type InlineMark,
	type InsertKind,
	type TextEdit
} from './writingMarkdown';

export interface WritingSelection {
	from: number;
	to: number;
	/** Client box of the selection start (first line). */
	start: Box;
	/** Client box of the selection end (last line). */
	end: Box;
	marks: Record<InlineMark, boolean>;
}

/** Dispatch a pure edit as typing: one undo step, the host's update listener sees it. */
export function runEdit(view: EditorView, edit: TextEdit, event = 'input.format'): void {
	view.dispatch({
		changes: { from: edit.from, to: edit.to, insert: edit.insert },
		selection: { anchor: edit.anchor, head: edit.head },
		userEvent: event,
		scrollIntoView: true
	});
	view.focus();
}

export function formatSelection(view: EditorView, mark: InlineMark): boolean {
	if (view.state.readOnly) return false;
	const range = view.state.selection.main;
	runEdit(view, toggleInlineMark(view.state.doc.toString(), range.from, range.to, mark));
	return true;
}

export function linkAtSelection(view: EditorView): boolean {
	if (view.state.readOnly) return false;
	const range = view.state.selection.main;
	runEdit(view, linkSelection(view.state.doc.toString(), range.from, range.to));
	return true;
}

/** An Insert menu entry at the caret (a line kind or a block). */
export function insertAtSelection(view: EditorView, kind: InsertKind): boolean {
	if (view.state.readOnly) return false;
	const range = view.state.selection.main;
	runEdit(view, insertKind(view.state.doc.toString(), range.from, range.to, kind), 'input');
	return true;
}

/** Inline text in place of the selection (an uploaded image's Markdown). */
export function insertText(view: EditorView, text: string): boolean {
	if (view.state.readOnly) return false;
	const range = view.state.selection.main;
	runEdit(view, insertInline(view.state.doc.toString(), range.from, range.to, text), 'input');
	return true;
}

const line = (className: string) => Decoration.line({ class: className });
const marker = Decoration.mark({ class: 'cm-w-marker' });
// A heading marker knows its own width in characters, so CSS can hang it in the margin.
const hangingMarkers = new Map<number, Decoration>();
function hangingMarker(chars: number): Decoration {
	let decoration = hangingMarkers.get(chars);
	if (!decoration) {
		decoration = Decoration.mark({ class: 'cm-w-marker cm-w-hang', attributes: { style: `--hang: ${chars}` } });
		hangingMarkers.set(chars, decoration);
	}
	return decoration;
}
const HEADING = /^(#{1,6})(\s+)\S/;
const QUOTE = /^(\s*)(>\s?)/;
const LIST = /^(\s*)([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
/** A thematic break: up to three spaces, then three or more of one of - * _ (spaces allowed). */
function isRule(text: string): boolean {
	const indent = text.length - text.trimStart().length;
	if (indent > 3) return false;
	const marks = text.replace(/\s/g, '');
	return marks.length >= 3 && (marks[0] === '-' || marks[0] === '*' || marks[0] === '_') && [...marks].every((char) => char === marks[0]);
}

const strong = Decoration.mark({ class: 'cm-w-strong' });
const emphasis = Decoration.mark({ class: 'cm-w-em' });
const struck = Decoration.mark({ class: 'cm-w-strike' });
const inlineCode = Decoration.mark({ class: 'cm-w-inline-code' });
const linkWords = Decoration.mark({ class: 'cm-w-link' });
// Inline marks: the words take the style, their markers go faint. Code spans are found first;
// nothing inside one is styled. (No look-behind: older WebKit cannot parse it.)
const INLINE: readonly { pattern: RegExp; size: number; deco: Decoration; single?: boolean }[] = [
	{ pattern: /\*\*(?=\S)([^*\n]*?\S)\*\*/g, size: 2, deco: strong },
	{ pattern: /\*(?=[^\s*])([^*\n]*?[^\s*])?\*(?!\*)/g, size: 1, deco: emphasis, single: true },
	{ pattern: /~~(?=\S)([^~\n]*?\S)~~/g, size: 2, deco: struck }
];
const CODE_SPAN = /`([^`\n]+)`/g;
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

type Range = { from: number; to: number; value: Decoration; line?: boolean };

function inlineRanges(text: string, offset: number, out: Range[]): void {
	const code: [number, number][] = [];
	const inCode = (from: number, to: number) => code.some(([a, b]) => from < b && to > a);
	const wrap = (at: number, end: number, open: number, close: number, deco: Decoration) => {
		out.push({ from: offset + at, to: offset + at + open, value: marker });
		out.push({ from: offset + at + open, to: offset + end - close, value: deco });
		out.push({ from: offset + end - close, to: offset + end, value: marker });
	};
	for (const match of text.matchAll(CODE_SPAN)) {
		const at = match.index ?? 0;
		const end = at + match[0].length;
		code.push([at, end]);
		wrap(at, end, 1, 1, inlineCode);
	}
	for (const match of text.matchAll(LINK)) {
		const at = match.index ?? 0;
		const end = at + match[0].length;
		if (inCode(at, end)) continue;
		wrap(at, end, 1, end - (at + 1 + match[1].length), linkWords);
	}
	for (const { pattern, size, deco, single } of INLINE) {
		for (const match of text.matchAll(pattern)) {
			const at = match.index ?? 0;
			const end = at + match[0].length;
			if (inCode(at, end)) continue;
			// A single star right after another star or a word character is not emphasis.
			if (single && at > 0 && /[*\p{Letter}\p{Number}_]/u.test(text[at - 1])) continue;
			wrap(at, end, size, size, deco);
		}
	}
}

function decorate(view: EditorView): DecorationSet {
	const ranges: Range[] = [];
	const doc = view.state.doc;
	const until = view.viewport.to;
	let fence: string | null = null;
	// Fences open and close from the top, so the scan starts at line 1 (pages are short; it
	// stops at the end of the viewport).
	for (let number = 1; number <= doc.lines; number += 1) {
		const row = doc.line(number);
		if (row.from > until) break;
		const text = row.text;
		const fenceMatch = FENCE.exec(text);
		if (fence !== null) {
			ranges.push({ from: row.from, to: row.from, value: line('cm-w-code'), line: true });
			if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
			continue;
		}
		if (fenceMatch) {
			fence = fenceMatch[1];
			ranges.push({ from: row.from, to: row.from, value: line('cm-w-code cm-w-fence'), line: true });
			continue;
		}
		let body = 0;
		const heading = HEADING.exec(text);
		if (heading) {
			const chars = heading[1].length + heading[2].length;
			ranges.push({ from: row.from, to: row.from, value: line(`cm-w-heading cm-w-h${heading[1].length}`), line: true });
			ranges.push({ from: row.from, to: row.from + chars, value: hangingMarker(chars) });
			body = chars;
		} else if (isRule(text)) {
			ranges.push({ from: row.from, to: row.from, value: line('cm-w-rule'), line: true });
			ranges.push({ from: row.from, to: row.to, value: marker });
			continue;
		} else {
			const quote = QUOTE.exec(text);
			if (quote) {
				ranges.push({ from: row.from, to: row.from, value: line('cm-w-quote'), line: true });
				ranges.push({ from: row.from + quote[1].length, to: row.from + quote[0].length, value: marker });
				body = quote[0].length;
			} else {
				const list = LIST.exec(text);
				if (list) {
					ranges.push({ from: row.from + list[1].length, to: row.from + list[0].length, value: marker });
					body = list[0].length;
				}
			}
		}
		inlineRanges(text.slice(body), row.from + body, ranges);
	}
	return Decoration.set(
		ranges.filter((range) => range.line || range.to > range.from).map((range) => range.value.range(range.from, range.to)),
		true
	);
}

/** Markdown structure as line and marker classes (no syntax-highlighting package needed). */
export const markdownLineStyles: Extension = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = decorate(view);
		}
		update(update: ViewUpdate) {
			if (update.docChanged || update.viewportChanged) this.decorations = decorate(update.view);
		}
	},
	{ decorations: (plugin) => plugin.decorations }
);

function box(rect: { left: number; top: number; right: number; bottom: number }): Box {
	return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function measureSelection(view: EditorView): WritingSelection | null {
	const range = view.state.selection.main;
	if (range.empty || !view.hasFocus) return null;
	const start = view.coordsAtPos(range.from, 1);
	const end = view.coordsAtPos(range.to, -1);
	if (!start || !end) return null;
	return { from: range.from, to: range.to, start: box(start), end: box(end), marks: activeMarks(view.state.doc.toString(), range.from, range.to) };
}

/** Reports the measured selection (or null) to `report` whenever it can have moved. */
export function selectionReporter(report: (selection: WritingSelection | null, view: EditorView) => void): Extension {
	return ViewPlugin.fromClass(
		class {
			constructor(readonly view: EditorView) {
				this.schedule();
			}
			update(update: ViewUpdate) {
				if (update.selectionSet || update.docChanged || update.focusChanged || update.geometryChanged || update.viewportChanged) this.schedule();
			}
			schedule() {
				this.view.requestMeasure({ key: this, read: measureSelection, write: (selection, view) => report(selection, view) });
			}
			destroy() {
				report(null, this.view);
			}
		}
	);
}

/** Formatting keys; `onBubbleKey` moves focus into the bubble (Alt F10) and says if it could. */
export function writingKeymap(onBubbleKey?: () => boolean): Extension {
	return Prec.high(
		keymap.of([
			{ key: 'Mod-b', run: (view) => formatSelection(view, 'bold') },
			{ key: 'Mod-i', run: (view) => formatSelection(view, 'italic') },
			{ key: 'Mod-Shift-x', run: (view) => formatSelection(view, 'strike') },
			{ key: 'Mod-e', run: (view) => formatSelection(view, 'code') },
			{ key: 'Mod-Shift-k', run: (view) => linkAtSelection(view) },
			{ key: 'Alt-F10', run: () => onBubbleKey?.() ?? false }
		])
	);
}

/** Captures the view for a host that needs to run commands on it. */
export function viewHandle(onView: (view: EditorView | null) => void): Extension {
	return ViewPlugin.fromClass(
		class {
			constructor(readonly view: EditorView) {
				onView(view);
			}
			destroy() {
				onView(null);
			}
		}
	);
}

/** The writing surface for a host: line styles, keys, an optional placeholder. */
export function writingSurface(options: { placeholder?: string; onBubbleKey?: () => boolean } = {}): Extension {
	return [markdownLineStyles, writingKeymap(options.onBubbleKey), options.placeholder ? placeholderText(options.placeholder) : []];
}
