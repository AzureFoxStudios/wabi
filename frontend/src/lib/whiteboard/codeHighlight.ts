import Prism from 'prismjs';
// Register the same grammar set the chat markdown renderer loads, so board
// code cards highlight the same languages. Already in the app bundle.
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-css';

/** A run of same-colored text on one line; type '' means plain text. */
export interface HighlightRun {
	text: string;
	type: string;
}

export type HighlightedLine = HighlightRun[];

/**
 * VS Code-dark palette mirroring $lib/prism-theme.css so board code cards match
 * chat code blocks. Unknown token types fall back to plain.
 */
export const CODE_CARD_BG = '#1e1e1e';
export const CODE_CARD_BORDER = '#3c3c3c';
export const CODE_TEXT_COLOR = '#d4d4d4';
export const CODE_LANGUAGE_TAG_COLOR = '#6a9955';

export const TOKEN_COLORS: Record<string, string> = {
	'': CODE_TEXT_COLOR,
	comment: '#6a9955',
	prolog: '#6a9955',
	doctype: '#6a9955',
	cdata: '#6a9955',
	keyword: '#c586c0',
	'class-name': '#4ec9b0',
	selector: '#d7ba7d',
	boolean: '#b5cea8',
	number: '#b5cea8',
	constant: '#b5cea8',
	symbol: '#b5cea8',
	deleted: '#c586c0',
	string: '#ce9178',
	char: '#ce9178',
	'attr-value': '#ce9178',
	regex: '#d16969',
	important: '#569cd6',
	variable: '#9cdcfe',
	'attr-name': '#9cdcfe',
	builtin: '#4ec9b0',
	'type-builtin': '#4ec9b0',
	function: '#dcdcaa',
	'function-variable': '#dcdcaa',
	property: '#9cdcfe',
	tag: '#569cd6',
	operator: '#d4d4d4',
	punctuation: '#d4d4d4',
	entity: '#ce9178',
	url: '#ce9178',
	inserted: '#b5cea8'
};

export function tokenColor(type: string): string {
	return TOKEN_COLORS[type] || CODE_TEXT_COLOR;
}

/** Languages whose grammars are registered above (aliases resolved). */
export const SUPPORTED_CODE_LANGUAGES: ReadonlyArray<string> = [
	'javascript', 'typescript', 'python', 'java', 'c', 'cpp', 'csharp',
	'go', 'rust', 'ruby', 'bash', 'json', 'css', 'markup', 'clike'
];

export function normalizeCodeLanguage(language: string): string {
	const aliasMap: Record<string, string> = {
		js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
		ts: 'typescript', tsx: 'typescript',
		py: 'python', python3: 'python',
		rb: 'ruby', rust: 'rust', rs: 'rust',
		sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
		yml: 'yaml', md: 'markdown',
		'c++': 'cpp', cxx: 'cpp',
		golang: 'go', 'c#': 'csharp', cs: 'csharp',
		html: 'markup', xml: 'markup', svg: 'markup'
	};
	const lowered = (language || '').trim().toLowerCase();
	const aliased = aliasMap[lowered] || lowered;
	if (SUPPORTED_CODE_LANGUAGES.includes(aliased) && Prism.languages[aliased]) return aliased;
	return '';
}

interface CacheEntry {
	lines: HighlightedLine[];
	charCount: number;
}

const CACHE_MAX_ENTRIES = 40;
const CACHE_MAX_CHARS = 1_500_000;
const cache = new Map<string, CacheEntry>();
let cacheChars = 0;

function cacheStore(key: string, lines: HighlightedLine[], charCount: number): void {
	cache.set(key, { lines, charCount });
	cacheChars += charCount;
	while (cache.size > CACHE_MAX_ENTRIES || cacheChars > CACHE_MAX_CHARS) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		const entry = cache.get(oldest);
		cache.delete(oldest);
		cacheChars -= entry?.charCount || 0;
	}
}

function flattenToken(content: unknown, type: string, target: HighlightedLine[], line: HighlightedLine): HighlightedLine {
	let current = line;
	if (typeof content === 'string') {
		const parts = content.split('\n');
		for (let i = 0; i < parts.length; i++) {
			if (i > 0) {
				target.push(current);
				current = [];
			}
			if (parts[i]) current.push({ text: parts[i], type });
		}
	} else if (Array.isArray(content)) {
		for (const nested of content) {
			current = flattenToken(nested, type, target, current);
		}
	} else if (content && typeof content === 'object' && 'content' in (content as Record<string, unknown>)) {
		const token = content as { type: string; content: unknown };
		current = flattenToken(token.content, token.type || type, target, current);
	}
	return current;
}

/**
 * Tokenize a code block into per-line colored runs. Results are cached — the
 * render loop calls this every frame, tokenizing 60×/s would be criminal.
 * Unknown languages return plain single-run lines (still correct text).
 */
export function highlightCodeLines(code: string, language: string): HighlightedLine[] {
	const normalized = normalizeCodeLanguage(language);
	const key = `${normalized}:${code}`;
	const hit = cache.get(key);
	if (hit) {
		// Refresh LRU position.
		cache.delete(key);
		cache.set(key, hit);
		return hit.lines;
	}

	let lines: HighlightedLine[];
	if (!normalized) {
		lines = code.split('\n').map((text) => [{ text, type: '' }]);
	} else {
		const target: HighlightedLine[] = [];
		let line: HighlightedLine = [];
		try {
			const tokens = Prism.tokenize(code, Prism.languages[normalized]);
			for (const token of tokens) {
				line = flattenToken(token, '', target, line);
			}
		} catch {
			// A grammar blowing up must never take down the board render.
			return code.split('\n').map((text) => [{ text, type: '' }]);
		}
		target.push(line);
		lines = target;
	}

	cacheStore(key, lines, code.length);
	return lines;
}

export function clearHighlightCache(): void {
	cache.clear();
	cacheChars = 0;
}
