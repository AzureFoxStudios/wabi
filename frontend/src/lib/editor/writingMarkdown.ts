/**
 * Markdown edits behind the writing surface (design contract §7.15 selection bubble, §8.8 Insert
 * menu, D22): the wiki editor, the Notes editor and, later, Documents use these. They are pure
 * string functions so they are tested without an editor: each returns one replacement of the
 * original text (`from`/`to` in the old text, `insert`) and the selection to place afterwards
 * (`anchor`/`head` in the new text), which is exactly a CodeMirror transaction spec.
 *
 * - Inline marks toggle: a selection already inside (or made of) the mark loses it, anything else
 *   gains it. Whitespace at the ends of a selection stays outside the mark, because `**word **`
 *   is not bold in Markdown. Italic and bold share `*`, so a run of one or three stars is italic
 *   and two or more is bold.
 * - Line kinds (Paragraph, Heading 2/3, lists, Checklist, Quote) replace the block prefix of every
 *   selected line; choosing the kind every line already has turns them back into paragraphs.
 * - Blocks (Divider, Code block, Table, Schedule) go on their own lines with a blank line around
 *   them, because `---` straight under a paragraph would make it a heading.
 */

export type InlineMark = 'bold' | 'italic' | 'strike' | 'code';
export type LineKind = 'paragraph' | 'heading2' | 'heading3' | 'bullet' | 'numbered' | 'checklist' | 'quote';
export type BlockSnippet = 'divider' | 'code' | 'table' | 'schedule';
export type InsertKind = LineKind | BlockSnippet;

/** One replacement plus the selection after it. */
export interface TextEdit {
	from: number;
	to: number;
	insert: string;
	anchor: number;
	head: number;
}

/** A client rectangle (CodeMirror's `coordsAtPos` and `getBoundingClientRect` both fit). */
export interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export const INLINE_MARKERS: Readonly<Record<InlineMark, string>> = Object.freeze({
	bold: '**',
	italic: '*',
	strike: '~~',
	code: '`'
});

/** The table the wiki toolbar used to call "Schedule": time, what, where, who. */
export const SCHEDULE_TABLE =
	'| Time | What | Where | Who |\n| --- | --- | --- | --- |\n| 08:00 | Meet at the gate | Main entrance | Everyone |\n| 09:00 |  |  |  |\n| 10:00 |  |  |  |';
const PLAIN_TABLE = '| Column | Column |\n| --- | --- |\n|  |  |';

/** The Insert menu, in the order the contract lists it (§8.8). */
export const INSERT_KINDS: readonly { kind: InsertKind; label: string }[] = Object.freeze([
	{ kind: 'paragraph', label: 'Paragraph' },
	{ kind: 'heading2', label: 'Heading 2' },
	{ kind: 'heading3', label: 'Heading 3' },
	{ kind: 'bullet', label: 'Bulleted list' },
	{ kind: 'numbered', label: 'Numbered list' },
	{ kind: 'checklist', label: 'Checklist' },
	{ kind: 'quote', label: 'Quote' },
	{ kind: 'divider', label: 'Divider' },
	{ kind: 'code', label: 'Code block' },
	{ kind: 'table', label: 'Table' },
	{ kind: 'schedule', label: 'Schedule table' }
]);

const LINE_KINDS: ReadonlySet<string> = new Set<LineKind>(['paragraph', 'heading2', 'heading3', 'bullet', 'numbered', 'checklist', 'quote']);

export function isLineKind(kind: InsertKind): kind is LineKind {
	return LINE_KINDS.has(kind);
}

export function applyTextEdit(text: string, edit: TextEdit): string {
	return text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
}

function clampRange(text: string, a: number, b: number): [number, number] {
	const from = Math.max(0, Math.min(Math.min(a, b), text.length));
	const to = Math.max(from, Math.min(Math.max(a, b), text.length));
	return [from, to];
}

/** How many `char`s run from `index` in direction `step` (±1). */
function run(text: string, index: number, char: string, step: 1 | -1): number {
	let count = 0;
	for (let at = index; at >= 0 && at < text.length && text[at] === char; at += step) count += 1;
	return count;
}

function carries(mark: InlineMark, stars: number): boolean {
	if (mark === 'italic') return stars === 1 || stars >= 3;
	if (mark === 'code') return stars >= 1;
	return stars >= 2;
}

const isSpace = (char: string | undefined) => char !== undefined && /\s/.test(char);

/** Which marks already wrap the (trimmed) selection, for the bubble's pressed keys. */
export function activeMarks(text: string, selFrom: number, selTo: number): Record<InlineMark, boolean> {
	let [from, to] = clampRange(text, selFrom, selTo);
	while (from < to && isSpace(text[from])) from += 1;
	while (to > from && isSpace(text[to - 1])) to -= 1;
	const result = { bold: false, italic: false, strike: false, code: false };
	if (from === to || text.slice(from, to).includes('\n')) return result;
	for (const mark of Object.keys(INLINE_MARKERS) as InlineMark[]) {
		const char = INLINE_MARKERS[mark][0];
		const outside = Math.min(run(text, from - 1, char, -1), run(text, to, char, 1));
		const selected = text.slice(from, to);
		const inside = Math.min(run(selected, 0, char, 1), run(selected, selected.length - 1, char, -1));
		result[mark] = carries(mark, outside) || (selected.length > 2 * INLINE_MARKERS[mark].length && carries(mark, inside));
	}
	return result;
}

// A list, quote or heading prefix stays outside an inline mark on its line.
const BLOCK_PREFIX = /^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)?/;

function wrapLines(selected: string, marker: string): string {
	return selected
		.split('\n')
		.map((line, index) => {
			if (!line.trim()) return line;
			const lead = index === 0 ? line.length - line.trimStart().length : (BLOCK_PREFIX.exec(line)?.[0].length ?? 0);
			const trail = line.length - line.trimEnd().length;
			const core = line.slice(lead, line.length - trail);
			return core ? `${line.slice(0, lead)}${marker}${core}${marker}${line.slice(line.length - trail)}` : line;
		})
		.join('\n');
}

/** Bold, Italic, Strikethrough, Inline code: wrap or unwrap the selection. */
export function toggleInlineMark(text: string, selFrom: number, selTo: number, mark: InlineMark): TextEdit {
	const marker = INLINE_MARKERS[mark];
	const size = marker.length;
	const char = marker[0];
	const [rawFrom, rawTo] = clampRange(text, selFrom, selTo);
	let from = rawFrom;
	let to = rawTo;
	while (from < to && isSpace(text[from])) from += 1;
	while (to > from && isSpace(text[to - 1])) to -= 1;
	if (from === to) {
		// Nothing to wrap: a pair of markers with the caret between them.
		const at = rawFrom;
		return { from: at, to: rawTo, insert: marker + marker, anchor: at + size, head: at + size };
	}
	const selected = text.slice(from, to);
	if (selected.includes('\n')) {
		const insert = wrapLines(selected, marker);
		return { from, to, insert, anchor: from, head: from + insert.length };
	}
	const outside = Math.min(run(text, from - 1, char, -1), run(text, to, char, 1));
	if (carries(mark, outside)) {
		return { from: from - size, to: to + size, insert: selected, anchor: from - size, head: to - size };
	}
	const inside = Math.min(run(selected, 0, char, 1), run(selected, selected.length - 1, char, -1));
	if (selected.length > 2 * size && carries(mark, inside)) {
		const inner = selected.slice(size, selected.length - size);
		return { from, to, insert: inner, anchor: from, head: from + inner.length };
	}
	return { from, to, insert: marker + selected + marker, anchor: from + size, head: to + size };
}

const URL_LIKE = /^(?:https?:\/\/|www\.)\S+$/i;

/** Link (Ctrl Shift K): `[text](https://)` with the address selected, ready to paste over. */
export function linkSelection(text: string, selFrom: number, selTo: number): TextEdit {
	const [rawFrom, rawTo] = clampRange(text, selFrom, selTo);
	let from = rawFrom;
	let to = rawTo;
	while (from < to && isSpace(text[from])) from += 1;
	while (to > from && isSpace(text[to - 1])) to -= 1;
	const selected = text.slice(from, to);
	if (!selected) {
		const insert = '[link text](https://)';
		return { from: rawFrom, to: rawTo, insert, anchor: rawFrom + 1, head: rawFrom + 10 };
	}
	if (URL_LIKE.test(selected)) {
		const insert = `[${selected}](${selected})`;
		return { from, to, insert, anchor: from + 1, head: from + 1 + selected.length };
	}
	const insert = `[${selected}](https://)`;
	const address = from + selected.length + 3;
	return { from, to, insert, anchor: address, head: address + 'https://'.length };
}

function lineStartAt(text: string, pos: number): number {
	return text.lastIndexOf('\n', pos - 1) + 1;
}

function lineEndAt(text: string, pos: number): number {
	const end = text.indexOf('\n', pos);
	return end < 0 ? text.length : end;
}

const KIND_TEST: Record<Exclude<LineKind, 'paragraph'>, RegExp> = {
	heading2: /^\s*##\s/,
	heading3: /^\s*###\s/,
	bullet: /^\s*[-*+]\s+(?!\[[ xX]\]\s)/,
	numbered: /^\s*\d+[.)]\s/,
	checklist: /^\s*[-*+]\s+\[[ xX]\]\s/,
	quote: /^\s*>/
};

function prefixFor(kind: LineKind, index: number): string {
	switch (kind) {
		case 'heading2':
			return '## ';
		case 'heading3':
			return '### ';
		case 'bullet':
			return '- ';
		case 'numbered':
			return `${index + 1}. `;
		case 'checklist':
			return '- [ ] ';
		case 'quote':
			return '> ';
		default:
			return '';
	}
}

/** Turn the selected lines into one kind of block (or back into paragraphs). */
export function setLineKind(text: string, selFrom: number, selTo: number, kind: LineKind): TextEdit {
	const [from, rawTo] = clampRange(text, selFrom, selTo);
	// A selection that ends at the very start of a line does not reach into that line.
	const to = rawTo > from && text[rawTo - 1] === '\n' ? rawTo - 1 : rawTo;
	const start = lineStartAt(text, from);
	const end = lineEndAt(text, to);
	const lines = text.slice(start, end).split('\n');
	const written = lines.filter((line) => line.trim());
	const already = kind !== 'paragraph' && written.length > 0 && written.every((line) => KIND_TEST[kind].test(line));
	const target: LineKind = already ? 'paragraph' : kind;
	let counter = 0;
	const prefixLengths: [number, number][] = [];
	const next = lines.map((line) => {
		if (!line.trim() && lines.length > 1) {
			prefixLengths.push([0, 0]);
			return line;
		}
		const match = BLOCK_PREFIX.exec(line);
		const old = match ? match[0] : '';
		const indent = /^\s*/.exec(old)?.[0] ?? '';
		const prefix = indent + prefixFor(target, counter++);
		prefixLengths.push([old.length, prefix.length]);
		return prefix + line.slice(old.length);
	});
	const insert = next.join('\n');
	if (lines.length === 1 && from === rawTo) {
		// A caret keeps its place in the line's words.
		const [oldLength, newLength] = prefixLengths[0];
		const offset = Math.max(0, from - start - oldLength);
		const caret = start + newLength + offset;
		return { from: start, to: end, insert, anchor: caret, head: caret };
	}
	return { from: start, to: end, insert, anchor: start, head: start + insert.length };
}

/** Divider, Code block, Table or Schedule table on its own lines below the caret's line. */
export function insertBlockSnippet(text: string, selFrom: number, selTo: number, kind: BlockSnippet): TextEdit {
	const [, to] = clampRange(text, selFrom, selTo);
	const start = lineStartAt(text, to);
	const end = lineEndAt(text, to);
	// An empty caret line becomes the block; otherwise the block goes after the line.
	const from = text.slice(start, end).trim() ? end : start;
	const replaceTo = end;
	const before = text.slice(0, from);
	const after = text.slice(replaceTo);
	// A blank line above unless the block starts the text or already follows one.
	const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
	const snippet = kind === 'divider' ? '---' : kind === 'code' ? '```\n\n```' : kind === 'table' ? PLAIN_TABLE : SCHEDULE_TABLE;
	// A blank line below, and a line to keep writing on after a divider.
	const trail = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
	const insert = lead + snippet + trail;
	const base = from + lead.length;
	if (kind === 'code') {
		const inside = base + 4;
		return { from, to: replaceTo, insert, anchor: inside, head: inside };
	}
	if (kind === 'table') {
		return { from, to: replaceTo, insert, anchor: base + 2, head: base + 2 + 'Column'.length };
	}
	const caret = base + snippet.length + trail.length;
	return { from, to: replaceTo, insert, anchor: caret, head: caret };
}

/** One Insert menu entry: a line kind or a block. */
export function insertKind(text: string, selFrom: number, selTo: number, kind: InsertKind): TextEdit {
	return isLineKind(kind) ? setLineKind(text, selFrom, selTo, kind) : insertBlockSnippet(text, selFrom, selTo, kind);
}

/** Inline text (an uploaded image's Markdown) in place of the selection, caret after it. */
export function insertInline(text: string, selFrom: number, selTo: number, snippet: string): TextEdit {
	const [from, to] = clampRange(text, selFrom, selTo);
	return { from, to, insert: snippet, anchor: from + snippet.length, head: from + snippet.length };
}

/**
 * Where the selection bubble goes (§7.15): 8px below the selection's last line box, left-aligned
 * to the selection start; above the first line box when fewer than 52px remain below inside the
 * scroll viewport. It never covers the selected text, and stays inside the viewport sideways.
 * All boxes are client coordinates; the result is too.
 */
export function placeSelectionBubble(
	start: Box,
	end: Box,
	viewport: Box,
	size: { width: number; height: number },
	gap = 8,
	minBelow = 52
): { left: number; top: number; above: boolean } {
	const above = viewport.bottom - end.bottom < minBelow && start.top - gap - size.height >= viewport.top;
	const top = above ? start.top - gap - size.height : end.bottom + gap;
	const maxLeft = Math.max(viewport.left + 4, viewport.right - size.width - 4);
	const left = Math.min(Math.max(start.left, viewport.left + 4), maxLeft);
	return { left, top, above };
}
