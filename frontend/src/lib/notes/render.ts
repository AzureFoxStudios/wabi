import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { parseNoteLinks } from './links';

const escape = (text: string) => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
// Independent instance: Notes must not reconfigure the shared chat renderer.
const markdown = new Marked({ renderer: { image: ({ text }) => escape(text) } });
/** Local wiki links are resolved by the workspace; Markdown cannot execute HTML. */
export function renderNote(text: string): string {
	if (typeof window === 'undefined') return '';
	const links = parseNoteLinks(text);
	const marker = `WABINOTELINK${crypto.randomUUID().replaceAll('-', '')}X`;
	let source = text;
	for (let index = links.length - 1; index >= 0; index--) {
		const link = links[index];
		source = source.slice(0, link.from) + `${marker}${index}X` + source.slice(link.to);
	}
	let html = markdown.parse(source, { async: false });
	for (const [index, link] of links.entries()) {
		html = html.replaceAll(`${marker}${index}X`, `<a href="#wabi-note-${index}">${escape(link.label ?? link.title)}</a>`);
	}
	return DOMPurify.sanitize(html, {
		ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a'],
		ALLOWED_ATTR: ['href', 'title', 'start'],
		ALLOW_DATA_ATTR: false
	});
}
