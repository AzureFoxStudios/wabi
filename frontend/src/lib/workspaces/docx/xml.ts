/**
 * A small XML reader for Office files, written so that a hostile file has nothing to exploit.
 *
 * It understands elements, attributes, text, CDATA, comments and the five predefined entities plus
 * numeric character references, and nothing else: a DOCTYPE or any ENTITY declaration is refused,
 * so there are no external entities (XXE) and no entity expansion ("billion laughs"). Depth, size
 * and node count are capped. It does no I/O and has no dependency, so it runs the same in the
 * browser and in tests.
 */
export interface XmlElement {
	name: string;
	attrs: Record<string, string>;
	children: (XmlElement | string)[];
}

export class XmlError extends Error {}

const MAX_LENGTH = 24 * 1024 * 1024;
const MAX_DEPTH = 200;
const MAX_NODES = 3_000_000;

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(text: string): string {
	if (!text.includes('&')) return text;
	return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (_all, body: string) => {
		if (body[0] === '#') {
			const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new XmlError('Invalid character reference.');
			return String.fromCodePoint(code);
		}
		if (body in NAMED) return NAMED[body];
		throw new XmlError('This file uses an XML entity that is not supported.');
	});
}

const NAME = /^[A-Za-z_][\w.:-]*/;

export function parseXml(source: string): XmlElement {
	if (source.length > MAX_LENGTH) throw new XmlError('The document is too large to read safely.');
	if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new XmlError('This file declares XML entities or a DOCTYPE, which are not supported.');
	const root: XmlElement = { name: '#document', attrs: {}, children: [] };
	const stack: XmlElement[] = [root];
	let nodes = 0;
	let at = 0;
	const n = source.length;
	while (at < n) {
		const open = source.indexOf('<', at);
		if (open < 0) { addText(source.slice(at)); break; }
		if (open > at) addText(source.slice(at, open));
		if (source.startsWith('<!--', open)) {
			const end = source.indexOf('-->', open + 4);
			if (end < 0) throw new XmlError('Unterminated comment.');
			at = end + 3;
		} else if (source.startsWith('<![CDATA[', open)) {
			const end = source.indexOf(']]>', open + 9);
			if (end < 0) throw new XmlError('Unterminated CDATA section.');
			const top = stack[stack.length - 1];
			top.children.push(source.slice(open + 9, end));
			at = end + 3;
		} else if (source.startsWith('<?', open)) {
			const end = source.indexOf('?>', open + 2);
			if (end < 0) throw new XmlError('Unterminated processing instruction.');
			at = end + 2;
		} else if (source.startsWith('</', open)) {
			const end = source.indexOf('>', open + 2);
			if (end < 0) throw new XmlError('Unterminated closing tag.');
			const name = source.slice(open + 2, end).trim();
			const top = stack.pop();
			if (!top || stack.length === 0 || top.name !== name) throw new XmlError('Mismatched closing tag.');
			at = end + 1;
		} else {
			const parsed = readTag(source, open);
			if (++nodes > MAX_NODES) throw new XmlError('The document has too many elements to read safely.');
			stack[stack.length - 1].children.push(parsed.element);
			if (!parsed.selfClosing) {
				if (stack.length > MAX_DEPTH) throw new XmlError('The document is nested too deeply to read safely.');
				stack.push(parsed.element);
			}
			at = parsed.end;
		}
	}
	if (stack.length !== 1) throw new XmlError('Unclosed element.');
	const first = root.children.find((child): child is XmlElement => typeof child !== 'string');
	if (!first) throw new XmlError('The document is empty.');
	return first;

	function addText(raw: string) {
		if (raw === '') return;
		const top = stack[stack.length - 1];
		if (top === root) { if (raw.trim() !== '') throw new XmlError('Text outside the root element.'); return; }
		top.children.push(decode(raw));
	}
}

function readTag(source: string, open: number): { element: XmlElement; selfClosing: boolean; end: number } {
	let at = open + 1;
	const rest = source.slice(at, at + 256);
	const nameMatch = NAME.exec(rest);
	if (!nameMatch) throw new XmlError('Malformed tag.');
	const element: XmlElement = { name: nameMatch[0], attrs: {}, children: [] };
	at += nameMatch[0].length;
	for (;;) {
		while (at < source.length && /\s/.test(source[at])) at++;
		if (at >= source.length) throw new XmlError('Unterminated tag.');
		if (source[at] === '>') return { element, selfClosing: false, end: at + 1 };
		if (source[at] === '/' && source[at + 1] === '>') return { element, selfClosing: true, end: at + 2 };
		const attr = NAME.exec(source.slice(at, at + 256));
		if (!attr) throw new XmlError('Malformed attribute.');
		at += attr[0].length;
		while (at < source.length && /\s/.test(source[at])) at++;
		if (source[at] !== '=') throw new XmlError('Attribute without a value.');
		at++;
		while (at < source.length && /\s/.test(source[at])) at++;
		const quote = source[at];
		if (quote !== '"' && quote !== "'") throw new XmlError('Attribute value is not quoted.');
		const close = source.indexOf(quote, at + 1);
		if (close < 0) throw new XmlError('Unterminated attribute value.');
		element.attrs[attr[0]] = decode(source.slice(at + 1, close));
		at = close + 1;
	}
}

/** The element children only, optionally those with one name. */
export function elements(node: XmlElement | undefined, name?: string): XmlElement[] {
	if (!node) return [];
	return node.children.filter((child): child is XmlElement => typeof child !== 'string' && (name === undefined || child.name === name));
}

export function firstElement(node: XmlElement | undefined, name: string): XmlElement | undefined {
	return node ? elements(node, name)[0] : undefined;
}

/** All the text inside a node, in order. */
export function textOf(node: XmlElement): string {
	return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
}
