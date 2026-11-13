/**
 * Browser smokes that build a temporary tree from a fixed file list (reader-browser-smoke.mjs,
 * reader-documents-browser-smoke.mjs) break when a copied file gains an import the list does not
 * carry (a missing `$lib/privacy/remoteMedia` once failed CI's reader job only in the browser).
 * This reads each script's copy list and aliases, and checks every `$lib/…` and relative import
 * of every copied file resolves to a copied file or an alias.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const frontend = path.resolve(import.meta.dir, '../..');
const SMOKES = ['scripts/reader-browser-smoke.mjs', 'scripts/reader-documents-browser-smoke.mjs'];
const EXTENSIONS = ['', '.ts', '.js', '.svelte', '/index.ts', '/index.js'];

function copyList(script: string): string[] {
	const block = script.match(/for\s*\(\s*const\s+relative\s+of\s*\[([\s\S]*?)\]\s*\)/)?.[1] ?? '';
	return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function aliases(script: string): string[] {
	const found = new Set<string>();
	for (const match of script.matchAll(/find:\s*'([^']+)'/g)) found.add(match[1]);
	const overrides = script.match(/const\s+overrides\s*=\s*\{([\s\S]*?)\};/)?.[1] ?? '';
	for (const match of overrides.matchAll(/'([^']+)'\s*:/g)) found.add(match[1]);
	return [...found];
}

/** Runtime imports only: `import type`/`export type` and `import('x').T` type positions are erased. */
function importsOf(source: string): string[] {
	const specifiers = new Set<string>();
	for (const match of source.matchAll(/(?:import|export)\s(?!type\s)[^'"`;]*?from\s*['"]([^'"]+)['"]/g)) specifiers.add(match[1]);
	for (const match of source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)(?!\s*\.)/g)) specifiers.add(match[1]);
	for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specifiers.add(match[1]);
	return [...specifiers];
}

function resolves(fromFile: string, specifier: string, copied: Set<string>, aliasKeys: string[]): boolean {
	if (aliasKeys.some((key) => key !== '$lib' && (specifier === key || specifier.startsWith(`${key}/`)))) return true;
	let target: string;
	if (specifier.startsWith('$lib/')) target = path.posix.join('src/lib', specifier.slice(5));
	else if (specifier.startsWith('.')) target = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
	else return true; // A package from node_modules.
	return EXTENSIONS.some((extension) => copied.has(`${target}${extension}`));
}

describe('temporary-tree browser smokes carry every import they need', () => {
	for (const smoke of SMOKES) {
		test(smoke, () => {
			const script = readFileSync(path.join(frontend, smoke), 'utf8');
			const list = copyList(script);
			expect(list.length).toBeGreaterThan(3);
			const copied = new Set(list);
			const aliasKeys = aliases(script);
			const missing: string[] = [];
			for (const relative of list) {
				expect(existsSync(path.join(frontend, relative)), `${relative} exists`).toBe(true);
				if (!/\.(ts|js|svelte)$/.test(relative)) continue;
				for (const specifier of importsOf(readFileSync(path.join(frontend, relative), 'utf8'))) {
					if (specifier.endsWith('.css')) continue;
					if (!resolves(relative, specifier, copied, aliasKeys)) missing.push(`${relative} → ${specifier}`);
				}
			}
			expect(missing).toEqual([]);
		});
	}
});
