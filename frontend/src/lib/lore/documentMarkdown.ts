import { Marked } from 'marked';
import DOMPurify from 'dompurify';

/** A separate parser: document settings must not mutate the chat renderer. */
const parser = new Marked({ gfm: true, breaks: false });
export const DOCUMENT_TAGS = [
	'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'a', 'blockquote', 'ul', 'ol', 'li',
	'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td'
];
export function escapeDocumentText(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// A document must not silently load remote tracking images. Assets have their own preview.
parser.use({ renderer: { image(token) { return escapeDocumentText(token.text || '[Image]'); } } });
export function renderLoreDocument(markdown: string): string {
	if (typeof window === 'undefined') return '';
	try {
		const html = parser.parse(markdown, { async: false });
		return DOMPurify.sanitize(html, {
			ALLOWED_TAGS: DOCUMENT_TAGS,
			ALLOWED_ATTR: ['href', 'title', 'colspan', 'rowspan', 'scope', 'start'],
			ALLOW_DATA_ATTR: false,
			FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'svg', 'math'],
			FORBID_ATTR: ['style', 'src', 'srcset', 'onerror', 'onload']
		});
	} catch {
		return `<pre>${escapeDocumentText(markdown)}</pre>`;
	}
}
