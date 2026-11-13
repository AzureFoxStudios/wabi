import DOMPurify from 'dompurify';
import { Marked, type Tokens } from 'marked';
import { normalizeReaderCodeLanguage } from '$lib/readerCode';
import { neutralizeRemoteMediaHtml } from '$lib/privacy/remoteMedia';
import type { ReaderDocumentFormat } from '$lib/readerWorkspace';

// A private parser instance avoids inheriting chat-only extensions and line-break rules.
const readerMarkdown = new Marked({ gfm: true, breaks: false, async: false });
readerMarkdown.use({
	renderer: {
		code(token: Tokens.Code): string {
			const language = normalizeReaderCodeLanguage(token.lang?.split(/\s+/)[0]);
			return `<pre data-reader-language="${escapeReaderHtml(language)}"><code>${escapeReaderHtml(token.text)}</code></pre>`;
		}
	}
});

const SANITIZE_CONFIG = {
	USE_PROFILES: { html: true },
	ALLOW_DATA_ATTR: false,
	ADD_ATTR: ['data-reader-language'],
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

export function renderReaderCode(content: string): string {
	const normalized = content.replace(/\r\n?/g, '\n');
	return `<pre data-reader-code-document="true"><code>${escapeReaderHtml(normalized)}</code></pre>`;
}

export type ReaderRenderOptions = {
	/**
	 * false for a document opened from content that stays on the device (a long message under
	 * experimental encryption): images from other hosts and every audio/video element (any origin)
	 * become links (privacy/remoteMedia.ts).
	 */
	remoteMedia?: boolean;
};

export function renderReaderHtml(content: string, format: ReaderDocumentFormat, options: ReaderRenderOptions = {}): string {
	if (!content.trim()) return '<p>No content loaded yet.</p>';
	if (format === 'text') return renderReaderPlainText(content);
	if (format === 'code') return renderReaderCode(content);
	// DOMPurify is browser-only; never emit unsanitized HTML during SSR.
	if (typeof DOMPurify.sanitize !== 'function') return renderReaderPlainText(content);
	const html = format === 'markdown' ? readerMarkdown.parse(content, { async: false }) : content;
	const clean = DOMPurify.sanitize(html, SANITIZE_CONFIG);
	return options.remoteMedia === false ? neutralizeRemoteMediaHtml(clean, { noAudioVideo: true }) : clean;
}

export function countWords(value: string): number {
	return value.trim().split(/\s+/).filter(Boolean).length;
}

export function formatSourceLabel(source: string): string {
	if (source === 'local-temp') return 'Local file';
	if (source === 'pasted') return 'Pasted';
	if (source === 'chat') return 'Chat';
	if (source === 'notes') return 'Notes';
	if (source === 'document') return 'Wabi document';
	return 'Reader';
}
