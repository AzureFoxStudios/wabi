/**
 * Paste for the writing surface: HTML copied from Word, a web page or Google Docs becomes
 * Markdown (bold, italic, strike, inline code, headings, links, bulleted and numbered lists,
 * simple tables, quotes, code blocks, line breaks) instead of raw markup.
 *
 * Safe by construction: the HTML is parsed by `DOMParser` into an inert document (no script
 * runs, nothing loads), `fromDom` copies it into a small plain tree, and `htmlToMarkdown` only
 * ever emits text. Scripts, styles and other non-content elements are dropped; unknown elements
 * keep their text. Links keep only http, https, mailto and tel addresses. No HTML is inserted.
 *
 * The converter works over `PasteNode` (a tree of plain objects), so it is tested without a DOM.
 * Plain-text pastes, pastes inside fenced code, and Ctrl Shift V (paste as plain text) keep the
 * browser's own text paste.
 */
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { fencedLines } from './writingBlocks';
import { escapeCellPipes } from './tableCell';

export interface PasteNode {
	/** Lower-case tag name, or '#text'. */
	tag: string;
	text?: string;
	attrs?: Record<string, string>;
	children?: PasteNode[];
}

const DROP = new Set(['script', 'style', 'head', 'title', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'canvas', 'audio', 'video', 'link', 'meta', 'button', 'select', 'textarea', 'form']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'figure', 'figcaption', 'address', 'details', 'summary', 'dl', 'dt', 'dd', 'fieldset']);
const SAFE_LINK = /^(?:https?:|mailto:|tel:)/i;
const MAX_DEPTH = 60;

/** Copy a DOM node into a PasteNode tree (comments and non-element nodes are skipped). */
export function fromDom(node: Node, depth = 0): PasteNode | null {
	if (node.nodeType === 3) return { tag: '#text', text: node.nodeValue ?? '' };
	if (node.nodeType !== 1 || depth > MAX_DEPTH) return null;
	const element = node as Element;
	const tag = element.tagName.toLowerCase();
	if (DROP.has(tag)) return null;
	const attrs: Record<string, string> = {};
	for (const name of ['href', 'style', 'class', 'type', 'checked', 'alt']) {
		const value = element.getAttribute(name);
		if (value !== null) attrs[name] = value;
	}
	const children: PasteNode[] = [];
	for (const child of Array.from(element.childNodes)) {
		const copy = fromDom(child, depth + 1);
		if (copy) children.push(copy);
	}
	return { tag, attrs, children };
}

export interface Converted {
	markdown: string;
	/** The HTML carried formatting or structure; false means plain text would have done. */
	formatted: boolean;
}

interface Ctx {
	formatted: boolean;
}

const attr = (node: PasteNode, name: string) => node.attrs?.[name] ?? '';
const style = (node: PasteNode) => attr(node, 'style').toLowerCase().replace(/\s+/g, '');

function isBold(node: PasteNode): boolean {
	if (node.tag === 'b' || node.tag === 'strong') return !/font-weight:(normal|400|300|lighter)/.test(style(node));
	const weight = /font-weight:(bold|bolder|[5-9]00)/.exec(style(node));
	return !!weight;
}
function isItalic(node: PasteNode): boolean {
	if (node.tag === 'i' || node.tag === 'em' || node.tag === 'cite') return !/font-style:normal/.test(style(node));
	return /font-style:italic/.test(style(node));
}
function isStrike(node: PasteNode): boolean {
	return node.tag === 's' || node.tag === 'del' || node.tag === 'strike' || /text-decoration[a-z-]*:[^;]*line-through/.test(style(node));
}

function escapeText(text: string): string {
	return text
		.replace(/\\/g, '\\\\')
		.replace(/\*/g, '\\*')
		.replace(/`/g, '\\`')
		.replace(/\[/g, '\\[')
		.replace(/\]/g, '\\]')
		.replace(/~~/g, '\\~\\~')
		.replace(/(^|[^\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, (m) => m.replace('_', '\\_'));
}

/** Wrap `inner` in `mark`, keeping edge spaces outside so `** bold **` never forms. */
function wrap(inner: string, mark: string): string {
	const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
	return match[2] ? `${match[1]}${mark}${match[2]}${mark}${match[3]}` : inner;
}

function plainText(node: PasteNode): string {
	if (node.tag === '#text') return node.text ?? '';
	if (node.tag === 'br') return '\n';
	return (node.children ?? []).map(plainText).join('');
}

function inline(nodes: PasteNode[], ctx: Ctx): string {
	return nodes.map((node) => inlineNode(node, ctx)).join('');
}

function inlineNode(node: PasteNode, ctx: Ctx): string {
	if (node.tag === '#text') return escapeText((node.text ?? '').replace(/[\s ]+/g, ' '));
	if (node.tag === 'br') {
		ctx.formatted = true;
		return '  \n';
	}
	if (/mso-list:ignore/.test(style(node))) return '';
	if (node.tag === 'img') return attr(node, 'alt') ? escapeText(attr(node, 'alt')) : '';
	if (node.tag === 'input') return '';
	const children = node.children ?? [];
	if (node.tag === 'code' || node.tag === 'kbd' || node.tag === 'samp' || node.tag === 'tt') {
		const code = plainText(node).replace(/\s+/g, ' ').trim();
		if (!code) return '';
		ctx.formatted = true;
		const fence = code.includes('`') ? '``' : '`';
		return `${fence}${code.includes('`') ? ` ${code} ` : code}${fence}`;
	}
	let out = inline(children, ctx);
	if (node.tag === 'a') {
		const href = attr(node, 'href').trim();
		const label = out.trim();
		if (SAFE_LINK.test(href) && label) {
			ctx.formatted = true;
			const address = href.replace(/[()\s<>]/g, (char) => encodeURIComponent(char));
			return `${out.match(/^\s*/)![0]}[${label}](${address})${out.match(/\s*$/)![0]}`;
		}
		return out;
	}
	if (isStrike(node)) {
		ctx.formatted = true;
		out = wrap(out, '~~');
	}
	if (isItalic(node)) {
		ctx.formatted = true;
		out = wrap(out, '*');
	}
	if (isBold(node)) {
		ctx.formatted = true;
		out = wrap(out, '**');
	}
	return out;
}

const INLINE_BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'blockquote', 'pre', 'hr', 'tr']);
const isBlockNode = (node: PasteNode) => INLINE_BLOCK_TAGS.has(node.tag) || BLOCK.has(node.tag);

/** Hard breaks keep their two trailing spaces except at the end. */
const tidy = (text: string) => {
	const lead = text.trimStart();
	// Trailing blank lines go entirely; otherwise only trailing spaces do. No
	// regular expression here: a nested quantifier anchored at the end is slow on
	// long runs of whitespace.
	if (lead.endsWith('\n')) return lead.trimEnd();
	let end = lead.length;
	while (end > 0 && lead[end - 1] === ' ') end--;
	return lead.slice(0, end);
};

/** Block nodes to Markdown blocks (strings; the caller joins them with blank lines). */
function blocks(nodes: PasteNode[], ctx: Ctx): string[] {
	const out: string[] = [];
	let run: PasteNode[] = [];
	const flush = () => {
		if (!run.length) return;
		const text = tidy(inline(run, ctx));
		run = [];
		// A paragraph that merely looks like a marker stays a paragraph.
		if (text.trim()) out.push(text.replace(/^(?:(#{1,6}|[-+>])(?=\s)|(\d+)(?=[.)]\s))/, (_m, mark, digits) => (mark ? `\\${mark}` : `${digits}\\`)));
	};
	for (let i = 0; i < nodes.length; i += 1) {
		const node = nodes[i];
		if (node.tag === '#text' || !isBlockNode(node)) {
			run.push(node);
			continue;
		}
		flush();
		if (isWordListItem(node)) {
			const group: PasteNode[] = [];
			while (i < nodes.length && (isWordListItem(nodes[i]) || (nodes[i].tag === '#text' && !(nodes[i].text ?? '').trim()))) {
				if (nodes[i].tag !== '#text') group.push(nodes[i]);
				i += 1;
			}
			i -= 1;
			out.push(wordList(group, ctx));
			continue;
		}
		const block = blockNode(node, ctx);
		if (block !== null) out.push(...block);
	}
	flush();
	return out;
}

function blockNode(node: PasteNode, ctx: Ctx): string[] | null {
	const children = node.children ?? [];
	const heading = /^h([1-6])$/.exec(node.tag);
	if (heading) {
		const text = tidy(inline(children, ctx)).replace(/\s*\n\s*/g, ' ');
		if (!text.trim()) return null;
		ctx.formatted = true;
		// Headings carry their own weight; bold markers inside would only add noise.
		return [`${'#'.repeat(Number(heading[1]))} ${text.replace(/^\*\*(.+)\*\*$/, '$1')}`];
	}
	switch (node.tag) {
		case 'ul':
		case 'ol': {
			const list = listBlock(node, ctx);
			return list ? [list] : null;
		}
		case 'table': {
			const table = tableBlock(node, ctx);
			if (table) ctx.formatted = true;
			return table ? [table] : null;
		}
		case 'blockquote': {
			const inner = blocks(children, ctx).join('\n\n');
			if (!inner.trim()) return null;
			ctx.formatted = true;
			return [inner.split('\n').map((row) => (row ? `> ${row}` : '>')).join('\n')];
		}
		case 'pre': {
			const code = plainText(node).replace(/\n+$/, '');
			if (!code.trim()) return null;
			ctx.formatted = true;
			const fence = code.includes('```') ? '~~~' : '```';
			return [`${fence}\n${code}\n${fence}`];
		}
		case 'hr':
			ctx.formatted = true;
			return ['---'];
		default:
			return blocks(children, ctx);
	}
}

function listBlock(list: PasteNode, ctx: Ctx): string {
	const ordered = list.tag === 'ol';
	const start = Number.parseInt(attr(list, 'start'), 10);
	let count = Number.isFinite(start) ? start : 1;
	const rows: string[] = [];
	for (const item of list.children ?? []) {
		if (item.tag !== 'li') continue;
		const marker = ordered ? `${count}. ` : '- ';
		const task = (item.children ?? []).find((child) => child.tag === 'input' && attr(child, 'type') === 'checkbox');
		const prefix = task ? ('checked' in (task.attrs ?? {}) ? '[x] ' : '[ ] ') : '';
		const parts = blocks(item.children ?? [], ctx);
		const pad = ' '.repeat(marker.length);
		const body = parts.join('\n').split('\n');
		rows.push(`${marker}${prefix}${body[0] ?? ''}`.trimEnd());
		for (const extra of body.slice(1)) rows.push(extra ? `${pad}${extra}` : '');
		count += 1;
	}
	if (rows.length) ctx.formatted = true;
	return rows.join('\n');
}

function isWordListItem(node: PasteNode): boolean {
	return node.tag === 'p' && /mso-list:l\d+level\d+/.test(style(node));
}
/** Word's own lists: paragraphs with an `mso-list` style and the bullet as ignorable text. */
function wordList(items: PasteNode[], ctx: Ctx): string {
	const counters: number[] = [];
	const rows: string[] = [];
	for (const item of items) {
		const level = Math.max(1, Number(/level(\d+)/.exec(style(item))?.[1] ?? 1));
		const lead = findIgnored(item).trim();
		const ordered = /^[\p{L}\p{N}]+[.)]$/u.test(lead);
		counters.length = level;
		const n = (counters[level - 1] = (counters[level - 1] ?? 0) + 1);
		const text = tidy(inline(item.children ?? [], ctx)).replace(/\s*\n\s*/g, ' ');
		rows.push(`${'  '.repeat(level - 1)}${ordered ? `${n}. ` : '- '}${text}`);
	}
	ctx.formatted = true;
	return rows.join('\n');
}
function findIgnored(node: PasteNode): string {
	if (/mso-list:ignore/.test(style(node))) return plainText(node);
	return (node.children ?? []).map(findIgnored).join('');
}

function tableBlock(table: PasteNode, ctx: Ctx): string | null {
	const rows: PasteNode[] = [];
	const collect = (nodes: PasteNode[]) => {
		for (const node of nodes) {
			if (node.tag === 'tr') rows.push(node);
			else if (node.tag === 'thead' || node.tag === 'tbody' || node.tag === 'tfoot') collect(node.children ?? []);
		}
	};
	collect(table.children ?? []);
	const cells = rows.map((row) =>
		(row.children ?? [])
			.filter((cell) => cell.tag === 'td' || cell.tag === 'th')
			.map((cell) => tidy(inline(cell.children ?? [], ctx)).replace(/\s*\n\s*/g, ' ')).map(escapeCellPipes).map((cell) => cell.trim())
	);
	const width = Math.max(0, ...cells.map((row) => row.length));
	if (!width || !cells.length) return null;
	const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`;
	return [line(cells[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...cells.slice(1).map(line)].join('\n');
}

/** Convert an HTML tree to Markdown. */
export function htmlToMarkdown(root: PasteNode): Converted {
	const ctx: Ctx = { formatted: false };
	const markdown = blocks(root.children ?? [], ctx).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
	return { markdown, formatted: ctx.formatted };
}

/** Parse an HTML string (inertly) and convert it; null when it is empty or too large. */
export function convertHtml(html: string): Converted | null {
	if (!html || html.length > 2_000_000 || typeof DOMParser === 'undefined') return null;
	const doc = new DOMParser().parseFromString(html, 'text/html');
	const root = fromDom(doc.body);
	if (!root) return null;
	const converted = htmlToMarkdown(root);
	return converted.markdown ? converted : null;
}

/**
 * Paste handler: formatted HTML becomes Markdown at the selection (one undo step). Falls through
 * to the browser's paste for plain text, an HTML that carried no formatting, fenced code, a
 * read-only page, and Ctrl Shift V.
 */
export function writingPaste(): Extension {
	let plainUntil = 0;
	return EditorView.domEventHandlers({
		keydown(event) {
			if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v') plainUntil = Date.now() + 1500;
			return false;
		},
		paste(event, view) {
			if (Date.now() < plainUntil) {
				plainUntil = 0;
				return false;
			}
			if (view.state.readOnly) return false;
			const html = event.clipboardData?.getData('text/html') ?? '';
			if (!html) return false;
			const fenced = fencedLines(view.state);
			if (view.state.selection.ranges.some((range) => fenced.has(view.state.doc.lineAt(range.head).number))) return false;
			const converted = convertHtml(html);
			if (!converted || !converted.formatted) return false;
			event.preventDefault();
			view.dispatch({ ...view.state.replaceSelection(converted.markdown), userEvent: 'input.paste', scrollIntoView: true });
			return true;
		}
	});
}
