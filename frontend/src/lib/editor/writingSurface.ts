/**
 * The writing surface as CodeMirror extensions (design contract §7.15, §8.7, §8.8): what turns
 * `CodeMirrorEditor` in prose mode into a page you write on rather than a code field.
 *
 * - `markdownLineStyles`: heading lines take the serif heading sizes and their `#` markers hang
 *   in the left margin in faint mono; quote lines get the prose quote rule; fenced lines read as
 *   code. Inline markers (`**`, `*`, `~~`, backticks, link brackets and addresses) show, faint,
 *   only on the caret's lines (D22); elsewhere they step aside so the page reads as prose, a
 *   checklist marker becomes a real checkbox, a bullet a dot, and a quote keeps only its rule.
 *   A read-only page has no caret line, so it reads clean throughout. Classes only (`cm-w-*`);
 *   the look lives with the surface's CSS (WritingFrame.svelte), so every theme answers through
 *   roles.
 * - `caretReporter`: the caret's line box, for the block handle (`+`) in the margin.
 * - `slashTrigger`: `/` typed on an empty line opens the Insert menu; `insertAtSlash` then
 *   replaces that `/` with the chosen block in one undo step.
 * - `selectionReporter`: measures the main selection after every change that can move it, for
 *   the selection bubble. It reports `null` while the selection is empty or the editor is blurred.
 * - `writingKeymap`: Ctrl B / I / Shift X / E / Shift K for Bold, Italic, Strikethrough, Inline
 *   code and Link (Ctrl K stays the jump palette, D13), Ctrl Enter to tick the checklist item on
 *   the caret's line, and Alt F10 to reach the bubble from the keyboard.
 * - `runEdit`, `formatSelection`, `linkAtSelection`, `insertAtSelection`, `insertText`: dispatch
 *   the pure edits from writingMarkdown.ts as user input, so the host's update listener (and
 *   undo history) treats them like typing.
 */
import { ChangeSet, Prec, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, placeholder as placeholderText, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import {
	activeMarks,
	insertInline,
	insertKind,
	linkSelection,
	toggleInlineMark,
	toggleTaskAt,
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

/**
 * An Insert menu entry opened by `/`: the `/` (alone on the caret's line) goes, the block takes
 * its place, all in one undo step. Without that `/` (the line changed meanwhile) it is a plain
 * Insert at the caret.
 */
export function insertAtSlash(view: EditorView, kind: InsertKind): boolean {
	if (view.state.readOnly) return false;
	const { doc, selection } = view.state;
	const line = doc.lineAt(selection.main.head);
	const slash = line.text.indexOf('/');
	if (line.text.trim() !== '/' || slash < 0) return insertAtSelection(view, kind);
	const at = line.from + slash;
	const removed = ChangeSet.of({ from: at, to: at + 1 }, doc.length);
	const text = doc.sliceString(0, at) + doc.sliceString(at + 1);
	const edit = insertKind(text, at, at, kind);
	const block = ChangeSet.of({ from: edit.from, to: edit.to, insert: edit.insert }, text.length);
	view.dispatch({
		changes: removed.compose(block),
		selection: { anchor: edit.anchor, head: edit.head },
		userEvent: 'input',
		scrollIntoView: true
	});
	view.focus();
	return true;
}

/** Removes the lone `/` that opened the Insert menu (before a host inserts an image itself). */
export function clearSlash(view: EditorView): void {
	const { doc, selection } = view.state;
	const line = doc.lineAt(selection.main.head);
	const slash = line.text.indexOf('/');
	if (view.state.readOnly || line.text.trim() !== '/' || slash < 0) return;
	view.dispatch({ changes: { from: line.from + slash, to: line.from + slash + 1 }, userEvent: 'delete' });
}

/** Tick or untick the checklist item at `pos` (default: the caret's line). */
export function toggleTask(view: EditorView, pos = view.state.selection.main.head): boolean {
	if (view.state.readOnly) return false;
	const head = view.state.selection.main.head;
	const edit = toggleTaskAt(view.state.doc.toString(), pos, head);
	if (!edit) return false;
	view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, userEvent: 'input.toggle' });
	return true;
}

const line = (className: string) => Decoration.line({ class: className });
const marker = Decoration.mark({ class: 'cm-w-marker' });
/** A marker that steps aside off the caret's lines. */
const hidden = Decoration.replace({});
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

/** A checklist marker off the caret's lines: a real checkbox that ticks the item. */
class CheckWidget extends WidgetType {
	constructor(readonly checked: boolean, readonly readonly: boolean) {
		super();
	}
	eq(other: CheckWidget) {
		return other.checked === this.checked && other.readonly === this.readonly;
	}
	toDOM(view: EditorView) {
		const wrap = document.createElement('span');
		wrap.className = 'cm-w-check';
		const box = document.createElement('input');
		box.type = 'checkbox';
		box.className = 'w-check';
		box.checked = this.checked;
		box.disabled = this.readonly;
		// The caret line shows the raw `[ ]`, and Ctrl Enter ticks it, so the box needs no tab stop.
		box.tabIndex = -1;
		box.setAttribute('aria-label', this.checked ? 'Done' : 'Not done');
		box.addEventListener('mousedown', (event) => event.preventDefault());
		box.addEventListener('click', (event) => {
			event.preventDefault();
			toggleTask(view, view.posAtDOM(wrap));
		});
		wrap.append(box);
		return wrap;
	}
	ignoreEvent() {
		return true;
	}
}
const checkWidgets = new Map<string, Decoration>();
function checkbox(checked: boolean, readonly: boolean): Decoration {
	const key = `${checked}:${readonly}`;
	let decoration = checkWidgets.get(key);
	if (!decoration) {
		decoration = Decoration.replace({ widget: new CheckWidget(checked, readonly) });
		checkWidgets.set(key, decoration);
	}
	return decoration;
}

/** A bullet marker off the caret's lines: a quiet dot in the marker's place. */
class BulletWidget extends WidgetType {
	eq() {
		return true;
	}
	toDOM() {
		const dot = document.createElement('span');
		dot.className = 'cm-w-bullet';
		dot.setAttribute('aria-hidden', 'true');
		dot.textContent = '•';
		return dot;
	}
}
const bullet = Decoration.replace({ widget: new BulletWidget() });

/** A thematic break off the caret's line: a hairline across the column. */
class RuleWidget extends WidgetType {
	eq() {
		return true;
	}
	toDOM() {
		const rule = document.createElement('span');
		rule.className = 'cm-w-hr';
		rule.setAttribute('aria-hidden', 'true');
		return rule;
	}
}
const ruleLine = Decoration.replace({ widget: new RuleWidget() });

const HEADING = /^(#{1,6})(\s+)\S/;
const QUOTE = /^(\s*)(>\s?)/;
const LIST = /^(\s*)([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/;
const TASK_MARK = /^[-*+]\s+\[([ xX])\]/;
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

/**
 * Styles one line's inline marks into `out`. Marker spans go to `markers` (they are faint on the
 * caret's lines and hidden elsewhere; the caller decides, after merging overlaps).
 */
function inlineRanges(text: string, offset: number, out: Range[], markers: [number, number][]): void {
	const code: [number, number][] = [];
	const inCode = (from: number, to: number) => code.some(([a, b]) => from < b && to > a);
	const wrap = (at: number, end: number, open: number, close: number, deco: Decoration) => {
		markers.push([offset + at, offset + at + open]);
		out.push({ from: offset + at + open, to: offset + end - close, value: deco });
		markers.push([offset + end - close, offset + end]);
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

/** Overlapping or touching marker spans as one span each (`***` is bold and italic at once). */
function mergeSpans(spans: [number, number][]): [number, number][] {
	const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
	const merged: [number, number][] = [];
	for (const [a, b] of sorted) {
		const last = merged.at(-1);
		if (last && a <= last[1]) last[1] = Math.max(last[1], b);
		else merged.push([a, b]);
	}
	return merged;
}

/** The lines (1-based, inclusive) the caret or selection touches; null on a read-only page. */
export function caretLines(state: EditorState): [number, number] | null {
	if (state.readOnly) return null;
	const range = state.selection.main;
	return [state.doc.lineAt(range.from).number, state.doc.lineAt(range.to).number];
}

/**
 * The page's decorations for `state` up to `until` (the end of the viewport), with the caret's
 * lines `active` showing their markers. Pure over the state, so it is tested without a browser.
 */
export function writingDecorations(state: EditorState, until: number, active: [number, number] | null): DecorationSet {
	const ranges: Range[] = [];
	const doc = state.doc;
	const readonly = state.readOnly;
	let fence: string | null = null;
	// Fences open and close from the top, so the scan starts at line 1 (pages are short; it
	// stops at the end of the viewport).
	for (let number = 1; number <= doc.lines; number += 1) {
		const row = doc.line(number);
		if (row.from > until) break;
		const text = row.text;
		const onCaret = active !== null && number >= active[0] && number <= active[1];
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
			ranges.push({ from: row.from, to: row.to, value: onCaret ? marker : ruleLine });
			continue;
		} else {
			const quote = QUOTE.exec(text);
			if (quote) {
				ranges.push({ from: row.from, to: row.from, value: line('cm-w-quote'), line: true });
				ranges.push({ from: row.from + quote[1].length, to: row.from + quote[0].length, value: onCaret ? marker : hidden });
				body = quote[0].length;
			} else {
				const list = LIST.exec(text);
				if (list) {
					const from = row.from + list[1].length;
					const to = row.from + list[0].length;
					const task = TASK_MARK.exec(list[2]);
					if (task) {
						const done = task[1] !== ' ';
						ranges.push({ from: row.from, to: row.from, value: line(done ? 'cm-w-task cm-w-done' : 'cm-w-task'), line: true });
						ranges.push({ from, to, value: onCaret ? marker : checkbox(done, readonly) });
					} else if (/^\d/.test(list[2])) {
						ranges.push({ from, to, value: marker });
					} else {
						ranges.push({ from, to, value: onCaret ? marker : bullet });
					}
					body = list[0].length;
				}
			}
		}
		const markers: [number, number][] = [];
		inlineRanges(text.slice(body), row.from + body, ranges, markers);
		for (const [from, to] of mergeSpans(markers)) ranges.push({ from, to, value: onCaret ? marker : hidden });
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
		active: [number, number] | null;
		constructor(view: EditorView) {
			this.active = caretLines(view.state);
			this.decorations = writingDecorations(view.state, view.viewport.to, this.active);
		}
		update(update: ViewUpdate) {
			const active = caretLines(update.state);
			const moved = active?.[0] !== this.active?.[0] || active?.[1] !== this.active?.[1];
			this.active = active;
			// The caret moving to another line changes which markers show.
			if (update.docChanged || update.viewportChanged || moved || update.startState.readOnly !== update.state.readOnly) this.decorations = writingDecorations(update.state, update.view.viewport.to, active);
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

/** The caret's line, for the block handle in the margin. */
export interface CaretLine {
	/** Client top and bottom of the line's first visual row. */
	top: number;
	bottom: number;
	/** The line is a heading (its marker already hangs in the margin, so no handle). */
	heading: boolean;
	/** Nothing but spaces on the line yet. */
	empty: boolean;
}

function measureCaret(view: EditorView): CaretLine | null {
	if (!view.hasFocus || view.state.readOnly) return null;
	const row = view.state.doc.lineAt(view.state.selection.main.head);
	const first = view.coordsAtPos(row.from, 1) ?? view.coordsAtPos(row.from, -1);
	if (!first) return null;
	return { top: first.top, bottom: first.bottom, heading: HEADING.test(row.text), empty: row.text.trim() === '' };
}

/** Reports the caret's line (or null while blurred or read-only) whenever it can have moved. */
export function caretReporter(report: (caret: CaretLine | null) => void): Extension {
	return ViewPlugin.fromClass(
		class {
			constructor(readonly view: EditorView) {
				this.schedule();
			}
			update(update: ViewUpdate) {
				if (update.selectionSet || update.docChanged || update.focusChanged || update.geometryChanged || update.viewportChanged) this.schedule();
			}
			schedule() {
				this.view.requestMeasure({ key: this, read: measureCaret, write: (caret) => report(caret) });
			}
			destroy() {
				report(null);
			}
		}
	);
}

/**
 * `/` typed on an empty line (only spaces before and after the caret) is typed as usual, then
 * `onSlash` opens the Insert menu; `insertAtSlash` consumes that `/` when an entry is chosen.
 */
export function slashTrigger(onSlash: (view: EditorView) => void): Extension {
	return EditorView.inputHandler.of((view, from, to, text) => {
		if (text !== '/' || from !== to || view.state.readOnly) return false;
		const row = view.state.doc.lineAt(from);
		if (row.text.trim() !== '') return false;
		view.dispatch({ changes: { from, to, insert: '/' }, selection: { anchor: from + 1 }, userEvent: 'input.type' });
		onSlash(view);
		return true;
	});
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
			{ key: 'Mod-Enter', run: (view) => toggleTask(view) },
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

/** The writing surface for a host: line styles, keys, an optional placeholder and `/`. */
export function writingSurface(options: { placeholder?: string; onBubbleKey?: () => boolean; onSlash?: (view: EditorView) => void } = {}): Extension {
	return [
		markdownLineStyles,
		writingKeymap(options.onBubbleKey),
		options.placeholder ? placeholderText(options.placeholder) : [],
		options.onSlash ? slashTrigger(options.onSlash) : []
	];
}
