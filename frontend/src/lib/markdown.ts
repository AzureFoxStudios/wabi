import { marked } from 'marked';
import Prism from 'prismjs';
import DOMPurify from 'dompurify';
import katex from 'katex';
import { emojis } from './emoji-store';
import type { MessageEntity } from './socket-types';

// Import Prism language support
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
// Removed PHP - causes tokenizePlaceholders error
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-css';

// Emote store (will be populated from server)
export const emotes = new Map<string, {
  name: string;
  url: string;
  type: 'static' | 'animated';
  uploadedBy: string;
  timestamp: number;
}>();

const MARKDOWN_RENDER_CACHE_LIMIT = 1500;
const markdownRenderCache = new Map<string, string>();
let emojiCacheVersion = 0;
let emoteCacheVersion = 0;
let emojiByName = new Map<string, { name: string; url: string }>();

function clearMarkdownRenderCache(): void {
	markdownRenderCache.clear();
}

function pruneMarkdownRenderCache(): void {
	while (markdownRenderCache.size > MARKDOWN_RENDER_CACHE_LIMIT) {
		const oldestKey = markdownRenderCache.keys().next().value;
		if (!oldestKey) break;
		markdownRenderCache.delete(oldestKey);
	}
}

emojis.subscribe((list) => {
	emojiCacheVersion += 1;
	clearMarkdownRenderCache();
	const next = new Map<string, { name: string; url: string }>();
	for (const e of list) {
		next.set(e.name, e);
	}
	emojiByName = next;
});

// Configure marked
marked.setOptions({
  breaks: true,
  gfm: true,
});

// Language aliases for common abbreviations
const languageAliases: Record<string, string> = {
  'js': 'javascript',
  'ts': 'typescript',
  'py': 'python',
  'rb': 'ruby',
  'sh': 'bash',
  'yml': 'yaml',
  'md': 'markdown',
  'c++': 'cpp',
  'csharp': 'csharp',
  'c#': 'csharp',
  'golang': 'go',
  'rs': 'rust',
};

// Custom renderer for code blocks with syntax highlighting
const renderer = {
  code(token: any) {
    const code = token.text;
    let lang = token.lang;

    // Map common aliases to full language names
    if (lang && languageAliases[lang.toLowerCase()]) {
      lang = languageAliases[lang.toLowerCase()];
    }

    if (lang && Prism.languages[lang]) {
      try {
        const highlighted = Prism.highlight(code, Prism.languages[lang], lang);
        return `<pre class="language-${lang}"><code class="language-${lang}">${highlighted}</code></pre>`;
      } catch (e) {
        console.error('Prism highlighting failed for', lang, ':', e);
        const escaped = code.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<pre class="language-${lang}"><code class="language-${lang}">${escaped}</code></pre>`;
      }
    }
    const escaped = code.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre><code>${escaped}</code></pre>`;
  },
  link(token: any) {
    const href = token?.href || '';
    const title = token?.title ? ` title="${escapeHtml(String(token.title))}"` : '';
    const text = token?.text || href;
    if (!isSafeUrl(href)) {
      return escapeHtml(text);
    }
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${title}>${text}</a>`;
  }
};

marked.use({ renderer });

/**
 * Parse markdown and replace emotes
 */
function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

const SAFE_URL_PROTOCOLS = /^(https?:|mailto:|tel:|#|\/)/i;

function isSafeUrl(url: string): boolean {
	const trimmed = url.trim();
	if (!trimmed) return false;
	return SAFE_URL_PROTOCOLS.test(trimmed);
}

type MathSlot = { token: string; tex: string; displayMode: boolean };

/**
 * Protect fenced + inline code so math extractors never touch $ inside code.
 * Returns text with code regions replaced by opaque tokens, plus restore map.
 */
function protectCodeRegions(text: string): {
	text: string;
	restorations: Array<{ token: string; original: string }>;
} {
	const restorations: Array<{ token: string; original: string }> = [];
	let i = 0;

	const stash = (original: string): string => {
		const token = `WABI_CODE_${i++}_X`;
		restorations.push({ token, original });
		return token;
	};

	// Fenced code first (``` ... ```), then inline `...`
	let out = text.replace(/```[\s\S]*?```/g, (m) => stash(m));
	out = out.replace(/`[^`\n]+`/g, (m) => stash(m));
	return { text: out, restorations };
}

function restoreCodeRegions(
	text: string,
	restorations: Array<{ token: string; original: string }>
): string {
	let out = text;
	// Restore in reverse so nested-looking tokens stay stable
	for (let i = restorations.length - 1; i >= 0; i--) {
		const { token, original } = restorations[i];
		out = out.split(token).join(original);
	}
	return out;
}

/**
 * Extract TeX math to opaque placeholders before marked mangles _, *, \\.
 * Supports $$...$$, $...$, \\[...\\], \\(...\\), and \\begin{env}...\\end{env}.
 * Caller must protect code regions first.
 */
function extractMathPlaceholders(text: string): { text: string; slots: MathSlot[] } {
	const slots: MathSlot[] = [];
	let out = text;

	const take = (tex: string, displayMode: boolean): string => {
		const token = `WABIMATH${slots.length}X`;
		slots.push({ token, tex, displayMode });
		return token;
	};

	// Display $$...$$ (non-greedy, allow newlines)
	out = out.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => take(tex, true));

	// \\[ ... \\]
	out = out.replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex: string) => take(tex, true));

	// \\begin{env}...\\end{env}
	out = out.replace(
		/\\begin\{([a-zA-Z*]+)\}([\s\S]*?)\\end\{\1\}/g,
		(m) => take(m, true)
	);

	// \\( ... \\)
	out = out.replace(/\\\(([\s\S]+?)\\\)/g, (_m, tex: string) => take(tex, false));

	// Inline $...$ — single-line, non-empty, no leading/trailing space inside
	// Avoid currency like $5 by requiring a non-digit start after $
	out = out.replace(
		/(?<![\\$])\$([^\s$][^$\n]*?[^\s$])\$(?!\$)/g,
		(_m, tex: string) => take(tex, false)
	);
	// Single-char math: $x$
	out = out.replace(/(?<![\\$])\$([^\s$])\$(?!\$)/g, (_m, tex: string) => take(tex, false));

	return { text: out, slots };
}

function renderMathSlots(html: string, slots: MathSlot[]): string {
	if (!slots.length) return html;
	let out = html;
	for (const slot of slots) {
		let rendered: string;
		try {
			rendered = katex.renderToString(slot.tex, {
				throwOnError: false,
				displayMode: slot.displayMode,
				output: 'html',
				strict: 'ignore'
			});
		} catch {
			rendered = `<code class="katex-error">${escapeHtml(slot.tex)}</code>`;
		}
		// KaTeX injects AFTER DOMPurify so inline styles/spans are not stripped
		out = out.split(slot.token).join(rendered);
	}
	return out;
}

function injectMessageEntityPlaceholders(
	text: string,
	entities: MessageEntity[] = []
): { preparedText: string; replacements: Array<{ token: string; html: string }> } {
	if (!entities.length) {
		return {
			preparedText: text,
			replacements: []
		};
	}

	const sorted = [...entities]
		.sort((a, b) => a.start - b.start || a.end - b.end);

	let cursor = 0;
	let prepared = '';
	const replacements: Array<{ token: string; html: string }> = [];

	sorted.forEach((entity, index) => {
		if (
			entity.start < cursor ||
			entity.start < 0 ||
			entity.end <= entity.start ||
			entity.end > text.length
		) {
			return;
		}

		const displayText = entity.displayText || text.slice(entity.start, entity.end) || entity.label;
		const token = `WABI_ENTITY_${index}_${entity.targetId.toUpperCase()}`;
		const kind = entity.kind;

		let html: string;
		if (kind === 'place') {
			html =
				`<span class="mention-token mention-token-${kind}" ` +
				`data-place-id="${escapeHtml(entity.targetId)}"` +
				`data-place-layer-id="${escapeHtml(entity.layerId || '')}" ` +
				`data-place-poi-id="${escapeHtml(entity.poiId || '')}" ` +
				`data-place-name="${escapeHtml(entity.label)}" ` +
				`data-ref-kind="${escapeHtml(kind)}" ` +
				`data-ref-id="${escapeHtml(entity.targetId)}" ` +
				`data-ref-label="${escapeHtml(entity.label)}">` +
				`${escapeHtml(displayText)}` +
				`</span>`;
		} else {
			html =
				`<span class="mention-token mention-token-${kind}" ` +
				`data-ref-kind="${escapeHtml(kind)}" ` +
				`data-ref-id="${escapeHtml(entity.targetId)}" ` +
				`data-ref-label="${escapeHtml(entity.label)}">` +
				`${escapeHtml(displayText)}` +
				`</span>`;
		}

		prepared += text.slice(cursor, entity.start);
		prepared += token;
		replacements.push({ token, html });
		cursor = entity.end;
	});

	prepared += text.slice(cursor);
	return {
		preparedText: prepared,
		replacements
	};
}

export function parseMessage(text: string, entities: MessageEntity[] = []): string {
	const cacheKey = `${emojiCacheVersion}:${emoteCacheVersion}:${text}:${entities.length > 0 ? JSON.stringify(entities) : ''}`;
	const cached = markdownRenderCache.get(cacheKey);
	if (cached !== undefined) {
		markdownRenderCache.delete(cacheKey);
		markdownRenderCache.set(cacheKey, cached);
		return cached;
	}

	const { preparedText, replacements } = injectMessageEntityPlaceholders(text, entities);
	text = preparedText;

	// 1) Protect code so math extractors never rewrite $ inside fences/backticks
	const codeProtected = protectCodeRegions(text);
	text = codeProtected.text;

	// 2) Extract math → opaque tokens (before marked mangles TeX)
	const mathExtracted = extractMathPlaceholders(text);
	text = mathExtracted.text;
	const mathSlots = mathExtracted.slots;

	// 3) Mentions while code is still protected (C1) — never rewrite #/@ inside fences/backticks
	text = text.replace(
		/(^|[\s(])@(everyone|here|all|[a-zA-Z0-9._-]{2,32})\b/g,
		(_match, prefix: string, mention: string) =>
			`${prefix}<span class="mention-token">@${mention}</span>`
	);
	// Clickable #channel (no space after # → not a markdown header).
	// MessageList routes data-ref-kind=channel → navigateToRef; name→id resolve stays there.
	text = text.replace(
		/(^|[\s(])#([a-zA-Z][a-zA-Z0-9._-]{0,31})\b/g,
		(_match, prefix: string, name: string) =>
			`${prefix}<span class="mention-token mention-token-channel" ` +
			`data-ref-kind="channel" ` +
			`data-ref-id="${escapeHtml(name)}" ` +
			`data-ref-label="#${escapeHtml(name)}">#${escapeHtml(name)}</span>`
	);

	// 4) Restore code regions for marked/Prism
	text = restoreCodeRegions(text, codeProtected.restorations);

	// Preprocess spoiler tags ||text|| before markdown parsing
	// Replace with span that can be clicked to reveal
	text = text.replace(/\|\|(.+?)\|\|/g, '<span class="spoiler" data-spoiler="true">$1</span>');

	// Discord-style code block preprocessing: ensure closing ``` is on its own line
	// Matches: ```lang\ncode``` and converts to: ```lang\ncode\n```
	text = text.replace(/```(\w+)\n([\s\S]*?)```/g, (match, lang, code) => {
		// If code doesn't end with newline, add one before closing backticks
		if (!code.endsWith('\n')) {
			return '```' + lang + '\n' + code + '\n```';
		}
		return match;
	});

	// First, parse markdown - use parseInline for single-line or parse for multi-line
	let html: string;
	try {
		const result = marked.parse(text, { async: false });
		html = typeof result === 'string' ? result : String(result);
	} catch (e) {
		console.error('Markdown parse error:', e);
		html = text; // Fallback to plain text
	}

	// Replace emote codes with images (custom emotes uploaded by users)
	html = html.replace(/:([a-zA-Z0-9_+-]+):/g, (match, emoteName) => {
		const emote = emotes.get(emoteName);
		if (emote && isSafeUrl(emote.url)) {
			return `<img src="${escapeHtml(emote.url)}" alt=":${escapeHtml(emoteName)}:" class="emote ${emote.type === 'animated' ? 'emote-animated' : ''}" title=":${escapeHtml(emoteName)}:">`;
		}
		// If not an emote, check if it's an emoji (O(1) Map lookup)
		const emoji = emojiByName.get(emoteName);
		if (emoji && isSafeUrl(emoji.url)) {
			return `<img src="${escapeHtml(emoji.url)}" alt=":${escapeHtml(emoji.name)}:" class="emoji-inline" title=":${escapeHtml(emoji.name)}:">`;
		}
		return match; // Return original if neither emote nor emoji found
	});

	for (const replacement of replacements) {
		html = html.split(replacement.token).join(replacement.html);
	}

	// Sanitize HTML to prevent XSS (math still opaque tokens — safe plain text)
	const clean = DOMPurify.sanitize(html, {
		ALLOWED_TAGS: [
			'p',
			'br',
			'strong',
			'em',
			'u',
			's',
			'del',
			'code',
			'pre',
			'a',
			'img',
			'blockquote',
			'ul',
			'ol',
			'li',
			'h1',
			'h2',
			'h3',
			'h4',
			'h5',
			'h6',
			'hr',
			'span'
		],
		ALLOWED_ATTR: [
			'href',
			'src',
			'alt',
			'class',
			'title',
			'target',
			'rel',
			'data-spoiler',
			'data-place-id',
			'data-place-layer-id',
			'data-place-poi-id',
			'data-place-name',
			'data-ref-kind',
			'data-ref-id',
			'data-ref-label'
		],
		FORBID_TAGS: ['style', 'script'],
		FORBID_ATTR: ['style', 'onerror', 'onload']
	});

	// 4) Inject trusted KaTeX HTML AFTER sanitize (keeps styles; no FORBID_ATTR widen)
	const withMath = renderMathSlots(clean, mathSlots);

	markdownRenderCache.set(cacheKey, withMath);
	pruneMarkdownRenderCache();
	return withMath;
}

/**
 * Add emote to the store
 */
export function addEmote(emote: {
  name: string;
  url: string;
  type: 'static' | 'animated';
  uploadedBy: string;
  timestamp: number;
}) {
  emotes.set(emote.name, emote);
	emoteCacheVersion += 1;
	clearMarkdownRenderCache();
}

/**
 * Remove emote from the store
 */
export function removeEmote(emoteName: string) {
  emotes.delete(emoteName);
	emoteCacheVersion += 1;
	clearMarkdownRenderCache();
}

/**
 * Get all emotes as array
 */
export function getAllEmotes() {
  return Array.from(emotes.values());
}

/**
 * Initialize emotes from server data
 */
export function initEmotes(serverEmotes: any[]) {
  emotes.clear();
  serverEmotes.forEach(emote => {
    emotes.set(emote.name, emote);
  });
	emoteCacheVersion += 1;
	clearMarkdownRenderCache();
}
