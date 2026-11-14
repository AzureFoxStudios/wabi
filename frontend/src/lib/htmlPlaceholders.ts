/**
 * Placeholders that renderers put into text before markdown parsing and replace with trusted
 * markup afterwards (math, wiki links).
 *
 * The rules (docs/audits/2026-11-hostile-server-audit.md, findings M1 and F1):
 * - a marker carries a random nonce per render, so text a member types can never match one;
 * - markers are replaced only in text nodes, on a parsed DOM, never by string replacement;
 * - an attribute that contains a marker is never edited: in `title`/`alt` the marker becomes the
 *   plain text it stood for; any other attribute holding one is removed whole. Removing just
 *   the marker from `href="ja{marker}vascript:…"` would leave `javascript:` behind a sanitizer
 *   that already approved the value;
 * - the caller sanitizes the result last. Nothing may rewrite attribute text after that.
 */

const TEXT_ATTRIBUTES = new Set(['title', 'alt', 'aria-label']);

/** A fresh nonce of letters and digits only, so markdown, mentions and emoji parsing leave it alone. */
export function placeholderNonce(): string {
	// getRandomValues works in insecure (plain-http) contexts too; no weaker fallback.
	const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type PlaceholderSlot = {
	/** Trusted markup for a text position (it is parsed, so it must be well formed). */
	html: () => string;
	/** Plain text for a title/alt attribute. */
	text: string;
};

/**
 * Replace every marker matched by `pattern` (global) whose exact text is a key of `slots`.
 * Markers that are not keys are left untouched. Needs a DOM; without one (server rendering) it
 * returns '' rather than guess.
 */
export function substitutePlaceholders(html: string, pattern: RegExp, slots: Map<string, PlaceholderSlot>): string {
	if (!slots.size || !html) return html;
	// Without a DOM there is no safe way to tell a text position from an attribute: substituting
	// by string could rebuild `javascript:` out of `ja{marker}vascript:`. Render nothing instead.
	if (typeof document === 'undefined') return '';
	const known = (value: string) => [...value.matchAll(pattern)].some((match) => slots.has(match[0]));
	const template = document.createElement('template');
	template.innerHTML = html;
	for (const element of Array.from(template.content.querySelectorAll('*'))) {
		for (const attribute of Array.from(element.attributes)) {
			if (!known(attribute.value)) continue;
			if (TEXT_ATTRIBUTES.has(attribute.name.toLowerCase())) {
				element.setAttribute(attribute.name, attribute.value.replace(pattern, (token) => slots.get(token)?.text ?? token));
			} else {
				element.removeAttribute(attribute.name);
			}
		}
	}
	const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
	const textNodes: Text[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (known(node.nodeValue ?? '')) textNodes.push(node as Text);
	}
	for (const node of textNodes) {
		const value = node.nodeValue ?? '';
		const fragment = document.createDocumentFragment();
		let cursor = 0;
		for (const match of value.matchAll(pattern)) {
			const slot = slots.get(match[0]);
			if (!slot) continue;
			const index = match.index ?? 0;
			fragment.append(value.slice(cursor, index));
			const rendered = document.createElement('template');
			rendered.innerHTML = slot.html();
			fragment.append(rendered.content);
			cursor = index + match[0].length;
		}
		fragment.append(value.slice(cursor));
		node.replaceWith(fragment);
	}
	return template.innerHTML;
}

