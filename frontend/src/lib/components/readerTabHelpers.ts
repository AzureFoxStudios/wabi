import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import type { ReaderDocumentFormat } from '$lib/readerWorkspace';

// A private parser instance avoids inheriting chat-only extensions and line-break rules.
const readerMarkdown = new Marked({ gfm: true, breaks: false, async: false });
const SANITIZE_CONFIG = {
	USE_PROFILES: { html: true },
	ALLOW_DATA_ATTR: false,
	FORBID_ATTR: ['style', 'class', 'contenteditable', 'autofocus', 'tabindex'],
	FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base']
};

export function escapeReaderHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function renderReaderPlainText(content: string): string {
	const normalized = content.replace(/\r\n?/g, '\n').trim();
	if (!normalized) return '<p></p>';
	return normalized.split(/\n[\t ]*\n+/)
		.map((block) => `<p>${block.split('\n').map(escapeReaderHtml).join('<br>')}</p>`).join('\n');
}

export function renderReaderHtml(content: string, format: ReaderDocumentFormat): string {
	if (!content.trim()) return '<p>No content loaded yet.</p>';
	if (format === 'text') return renderReaderPlainText(content);
	// DOMPurify is browser-only; never emit unsanitized HTML during SSR.
	if (typeof DOMPurify.sanitize !== 'function') return renderReaderPlainText(content);
	const html = format === 'markdown' ? readerMarkdown.parse(content, { async: false }) : content;
	return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}

export function countWords(value: string): number {
	return value.trim().split(/\s+/).filter(Boolean).length;
}

export function formatSourceLabel(source: string): string {
	if (source === 'local-temp') return 'Local file';
	if (source === 'pasted') return 'Pasted';
	if (source === 'chat') return 'Chat';
	if (source === 'notes') return 'Notes';
	return 'Reader';
}
