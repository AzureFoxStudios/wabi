/** Source offsets use JavaScript/CodeMirror UTF-16 positions; `to` is exclusive. */
export interface NoteLink {
	from: number;
	to: number;
	title: string;
	label?: string;
	normalizedTitle: string;
}

/** Preserve display spelling separately; use this value for uniqueness and lookup. */
export function normalizeNoteTitle(title: string): string {
	return title.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

interface Range { from: number; to: number }
interface HtmlTag extends Range { name: string; closing: boolean; selfClosing: boolean }

const VOID_HTML_TAGS = new Set([
	'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

function escaped(text: string, offset: number): boolean {
	let slashes = 0;
	while (offset > 0 && text[--offset] === '\\') slashes++;
	return slashes % 2 === 1;
}

/** Fences may be indented, quoted or placed after a Markdown list marker. */
function fenceRanges(text: string): Range[] {
	const ranges: Range[] = [];
	let open: { from: number; marker: string; length: number } | undefined;
	let start = 0;
	while (start < text.length) {
		const newline = text.indexOf('\n', start);
		const end = newline < 0 ? text.length : newline + 1;
		const line = text.slice(start, end).replace(/\r?\n$/, '');
		const content = line.replace(/^(?:[ \t]{0,3}>[ \t]?)*[ \t]{0,3}(?:(?:[-+*]|\d+[.)])[ \t]+)?/, '');
		const fence = /^(`{3,}|~{3,})(.*)$/.exec(content);
		if (open) {
			if (fence && fence[1][0] === open.marker && fence[1].length >= open.length && /^\s*$/.test(fence[2])) {
				ranges.push({ from: open.from, to: end });
				open = undefined;
			}
		} else if (fence && (fence[1][0] !== '`' || !fence[2].includes('`'))) {
			open = { from: start, marker: fence[1][0], length: fence[1].length };
		}
		start = end;
	}
	if (open) ranges.push({ from: open.from, to: text.length });
	return ranges;
}

function htmlTag(text: string, from: number): HtmlTag | undefined {
	const head = /^<(\/?)([A-Za-z][\w:-]*)(?=[\s/>])/.exec(text.slice(from));
	if (!head) return;
	let quote: string | undefined;
	for (let i = from + head[0].length; i < text.length; i++) {
		const char = text[i];
		if (quote) {
			if (char === quote) quote = undefined;
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === '>') {
			const name = head[2].toLowerCase();
			return { from, to: i + 1, name, closing: head[1] === '/', selfClosing: text[i - 1] === '/' || VOID_HTML_TAGS.has(name) };
		} else if (char === '<') {
			return;
		}
	}
	// An unfinished tag/attribute remains literal HTML, not a notebook reference.
	return { from, to: text.length, name: head[2].toLowerCase(), closing: head[1] === '/', selfClosing: true };
}

function delimitedEnd(text: string, from: number, delimiter: string): number {
	const end = text.indexOf(delimiter, from);
	return end < 0 ? text.length : end + delimiter.length;
}

/** Exclude HTML bodies too, not just their opening and closing tag tokens. */
function htmlEnd(text: string, from: number): number | undefined {
	// Markdown autolinks are not elements; their URL is not notebook link text.
	const autolink = /^<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*|[^<>\s@]+@[^<>\s@]+)>/.exec(text.slice(from));
	if (autolink) return from + autolink[0].length;
	if (text.startsWith('<!--', from)) return delimitedEnd(text, from + 4, '-->');
	if (text.startsWith('<![CDATA[', from)) return delimitedEnd(text, from + 9, ']]>');
	if (text.startsWith('<?', from)) return delimitedEnd(text, from + 2, '?>');
	if (/^<![A-Z]/i.test(text.slice(from, from + 3))) return delimitedEnd(text, from + 2, '>');
	const root = htmlTag(text, from);
	if (!root) return;
	if (root.closing || root.selfClosing) return root.to;
	if (['script', 'style', 'textarea', 'title'].includes(root.name)) {
		const close = new RegExp(`</${root.name}\\s*>`, 'ig');
		close.lastIndex = root.to;
		return close.exec(text) ? close.lastIndex : text.length;
	}
	let depth = 1;
	let position = root.to;
	while (position < text.length) {
		const next = text.indexOf('<', position);
		if (next < 0) break;
		if (text.startsWith('<!--', next)) {
			position = delimitedEnd(text, next + 4, '-->');
			continue;
		}
		const tag = htmlTag(text, next);
		if (tag) {
			if (tag.name === root.name) {
				if (tag.closing) depth--;
				else if (!tag.selfClosing) depth++;
				if (depth === 0) return tag.to;
			}
			position = tag.to;
		} else position = next + 1;
	}
	// Conservatively leave an unclosed HTML element out of the notebook graph.
	return text.length;
}

/**
 * Parse the notebook's single-line [[Title]] / [[Title|label]] syntax.
 * This deliberately does not change chat Markdown or interpret HTML as links.
 */
export function parseNoteLinks(text: string): NoteLink[] {
	const links: NoteLink[] = [];
	const fences = fenceRanges(text);
	let fenceIndex = 0;
	// Index exact backtick run lengths once, avoiding repeated suffix scans on long notes.
	const ticks = new Map<number, { end: number; next?: number }>();
	const nextByLength = new Map<number, number>();
	const runs = [...text.matchAll(/`+/g)];
	for (let i = runs.length - 1; i >= 0; i--) {
		const run = runs[i];
		const start = run.index!;
		ticks.set(start, { end: start + run[0].length, next: nextByLength.get(run[0].length) });
		nextByLength.set(run[0].length, start);
	}
	for (let i = 0; i < text.length;) {
		while (fenceIndex < fences.length && fences[fenceIndex].to <= i) fenceIndex++;
		const fence = fences[fenceIndex];
		if (fence && i >= fence.from) { i = fence.to; continue; }
		const tick = ticks.get(i);
		if (tick) {
			if (!escaped(text, i) && tick.next !== undefined && (!fence || tick.next < fence.from)) {
				i = ticks.get(tick.next)!.end;
			} else i = tick.end;
			continue;
		}
		if (text[i] === '<' && !escaped(text, i)) {
			const end = htmlEnd(text, i);
			if (end !== undefined) { i = end; continue; }
		}
		if (!text.startsWith('[[', i) || escaped(text, i)) { i++; continue; }
		let end = i + 2;
		while (end < text.length && !/[\[\]\r\n]/.test(text[end])) end++;
		if (!text.startsWith(']]', end) || escaped(text, end)) { i = end > i + 2 ? end : i + 2; continue; }
		const body = text.slice(i + 2, end);
		const pipe = body.indexOf('|');
		const title = (pipe < 0 ? body : body.slice(0, pipe)).trim();
		const normalizedTitle = normalizeNoteTitle(title);
		if (normalizedTitle) {
			links.push({ from: i, to: end + 2, title, ...(pipe < 0 ? {} : { label: body.slice(pipe + 1) }), normalizedTitle });
		}
		i = end + 2;
	}
	return links;
}

/** Rename only parsed targets; explicit labels and all surrounding bytes survive. */
export function renameNoteLinks(text: string, oldNormalizedTitle: string, newTitle: string): string {
	if (!normalizeNoteTitle(newTitle) || /[\[\]|\r\n]/.test(newTitle)) throw new Error('Invalid note link title');
	const target = normalizeNoteTitle(oldNormalizedTitle);
	const matches = parseNoteLinks(text).filter((link) => link.normalizedTitle === target);
	const pieces: string[] = [];
	let position = 0;
	for (const link of matches) {
		const replacement = `[[${newTitle}${link.label === undefined ? '' : `|${link.label}`}]]`;
		pieces.push(text.slice(position, link.from), replacement);
		position = link.to;
	}
	pieces.push(text.slice(position));
	return pieces.join('');
}
