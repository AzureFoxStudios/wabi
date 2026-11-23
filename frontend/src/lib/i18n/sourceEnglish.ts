/**
 * Test helper: contract tests guard the English words a surface says by reading its
 * component source. Since copy moved into locale catalogs, a component says
 * `{$_('settings.scope_device')}` where it once said the words themselves, so a plain
 * `toContain('Saved on this device')` no longer sees them. `inEnglish` puts the English
 * catalog's words back in place of each `$_('key')` call, so those guards keep checking the
 * words a person reads. Keys missing from the catalog are left as written (and so still fail
 * a guard that expects words), and `{placeholders}` stay literal.
 *
 * Not imported by app code.
 */
import catalog from './locales/en.json';

const flat = new Map<string, string>();
(function walk(node: unknown, path: string) {
	if (typeof node === 'string') flat.set(path, node);
	else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
})(catalog, '');

/** English words for a catalog key, or undefined when the catalog has no such string. */
export const englishFor = (key: string): string | undefined => flat.get(key);

/** Index just past the `)` closing the call whose `(` is at `open`, skipping strings and nesting. */
function closeOf(source: string, open: number): number {
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		const ch = source[i];
		if (ch === '"' || ch === "'" || ch === '`') {
			for (i++; i < source.length && source[i] !== ch; i++) if (source[i] === '\\') i++;
		} else if (ch === '(') depth++;
		else if (ch === ')' && --depth === 0) return i + 1;
	}
	return -1;
}

const CALL = /\$[_t]\(\s*(['"])([\w.-]+)\1\s*(?=[,)])/g;

export function inEnglish(source: string): string {
	let out = '', last = 0;
	for (const match of source.matchAll(CALL)) {
		const start = match.index!, text = flat.get(match[2]);
		if (text === undefined || start < last) continue;
		const end = closeOf(source, start + 2);
		if (end < 0) continue;
		const wrapped = source[start - 1] === '{' && source[end] === '}';
		let from = start, to = end, words: string;
		if (wrapped) {
			from = start - 1; to = end + 1;
			words = source[from - 1] === '=' ? `"${text.replace(/"/g, '&quot;')}"` : text;
		} else words = `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
		out += source.slice(last, from) + words;
		last = to;
	}
	return out + source.slice(last);
}
