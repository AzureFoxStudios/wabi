import { parseMessage, sanitizeMessageHtml } from '$lib/markdown';
import { placeholderNonce, substitutePlaceholders } from '$lib/htmlPlaceholders';

export type WikiLinkTarget = { pageId: string | number } | null | undefined;

function escapeWikiText(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Wiki body: [[Title]] and [[Title|label]] become anchors AFTER markdown parsing (parseMessage
 * treats a "#wikipage-…" destination as a channel reference and breaks the surrounding link).
 *
 * The links are staged as per-render random markers, inserted in text positions only, and the
 * result is sanitized last. The old version string-replaced a fixed `wabiwikilinkx{n}x` over the
 * sanitized HTML, attributes included: `<a href="javawabiwikilinkx9xscript:…">` became a working
 * `javascript:` link (docs/audits/2026-11-hostile-server-audit.md, finding F1b).
 */
export function renderWikiBody(markdown: string, resolve: (title: string) => WikiLinkTarget): string {
	const nonce = placeholderNonce();
	const links = new Map<string, { html: () => string; text: string }>();
	// Code stays literal: only prose outside fences and inline code gets wiki links.
	const stage = (prose: string) => prose.replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_match, title: string, label?: string) => {
		const target = resolve(title);
		const shown = (label || title).trim();
		const text = escapeWikiText(shown);
		const html = target
			? `<a href="#wikipage-${escapeWikiText(String(target.pageId))}" class="wiki-link">${text}</a>`
			: `<a href="#wikipage-missing" class="wiki-link wiki-link-missing" title="No page with this title yet">${text}</a>`;
		const token = `wabiwikilink${nonce}n${links.size}x`;
		links.set(token, { html: () => html, text: shown });
		return token;
	});
	const staged = markdown.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, index) => (index % 2 === 1 ? part : stage(part))).join('');
	const rendered = parseMessage(staged, [], { allowTables: true });
	if (!links.size) return rendered;
	return sanitizeMessageHtml(substitutePlaceholders(rendered, /wabiwikilink[0-9a-f]+n\d+x/g, links), { allowTables: true });
}
