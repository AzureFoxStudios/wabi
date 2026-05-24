import DOMPurify from 'dompurify';
import { parseMessage } from '$lib/markdown';
import type { ReaderDocumentFormat } from '$lib/readerWorkspace';

const SANITIZE_CONFIG = {
	USE_PROFILES: { html: true }
};

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function renderPlainText(content: string): string {
	const normalized = content.replace(/\r\n/g, '\n').trim();
	if (!normalized) return '<p></p>';
	return normalized
		.split(/\n{2,}/)
		.map((block) => `<p>${block.split('\n').map((line) => escapeHtml(line)).join('<br>')}</p>`)
		.join('');
}

export function renderReaderHtml(content: string, format: ReaderDocumentFormat): string {
	if (!content.trim()) {
		return '<p class="reader-empty-copy">No content loaded yet.</p>';
	}
	if (format === 'markdown') return parseMessage(content);
	if (format === 'html') return DOMPurify.sanitize(content, SANITIZE_CONFIG);
	return renderPlainText(content);
}

export function countWords(value: string): number {
	return value
		.trim()
		.split(/\s+/)
		.filter(Boolean).length;
}

export function formatSourceLabel(source: string): string {
	if (source === 'local-temp') return 'Local file';
	if (source === 'pasted') return 'Pasted';
	if (source === 'chat') return 'Chat';
	if (source === 'notes') return 'Notes';
	return 'Reader';
}
