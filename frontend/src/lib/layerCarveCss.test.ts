import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Layer carve (wave 0a): the shared skins became index files and every surface owns its skin
// under styles/surfaces/. The index files' import order is the cascade order.
const srcDir = fileURLToPath(new URL('../', import.meta.url));
const stylesDir = join(srcDir, 'styles');
const INDEXES = ['styles.css', 'shell.css', 'stage-skin.css', 'panels-skin.css'];
const CARVED = [
	'sidebar.css',
	'stagebar.css',
	'composer.css',
	'headings.css',
	'stream-skin.css',
	'panel.css',
	'calls.css',
	'reading.css',
	'chat-legacy.css',
].map((name) => `surfaces/${name}`);
const IMPORT = /@import\s+(?:url\()?['"]([^'"]+)['"]\)?\s*;/g;

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const readStyle = (path: string) => readFileSync(join(stylesDir, path), 'utf8');

/** Relative @imports of a stylesheet, as paths relative to styles/. */
function importsOf(path: string): string[] {
	return [...stripComments(readStyle(path)).matchAll(IMPORT)]
		.map((match) => match[1])
		.filter((target) => target.startsWith('.'))
		.map((target) => normalize(join(dirname(path), target)));
}

/** Stylesheets +layout.svelte imports, as paths relative to styles/. */
function layoutSheets(): string[] {
	const layout = readFileSync(join(srcDir, 'routes/+layout.svelte'), 'utf8');
	return [...layout.matchAll(/import\s+['"]\.\.\/styles\/([^'"]+\.css)['"]/g)].map((match) => match[1]);
}

/** Every relative @import reached from the layout's stylesheets, in cascade order (with repeats). */
function importGraph(): string[] {
	const seen: string[] = [];
	const walk = (path: string) => {
		seen.push(path);
		if (!existsSync(join(stylesDir, path))) return;
		for (const target of importsOf(path)) walk(target);
	};
	for (const sheet of layoutSheets()) walk(sheet);
	return seen;
}

function cssFiles(dir: string): string[] {
	return readdirSync(dir, { recursive: true, encoding: 'utf8' })
		.filter((name) => name.endsWith('.css'))
		.map((name) => join(dir, name));
}

describe('layer carve: the shared skins are index files', () => {
	for (const file of INDEXES) {
		test(`${file} holds only @import statements and comments`, () => {
			if (!existsSync(join(stylesDir, file))) return; // retired once surfaces import directly
			const rest = stripComments(readStyle(file)).replace(IMPORT, '').trim();
			expect(rest).toBe('');
		});
	}

	test('every @import in the layout graph resolves to a file', () => {
		const missing = importGraph().filter((path) => !existsSync(join(stylesDir, path)));
		expect(missing).toEqual([]);
	});

	test('each carved surface skin is imported exactly once, so its rules are not repeated later in the cascade', () => {
		const graph = importGraph();
		const counts = Object.fromEntries(CARVED.map((path) => [path, graph.filter((p) => p === path).length]));
		expect(counts).toEqual(Object.fromEntries(CARVED.map((path) => [path, 1])));
		const surfaces = graph.filter((path) => path.startsWith('surfaces/'));
		expect(surfaces.length).toBe(new Set(surfaces).size);
	});

	test('legacy inline chat rules keep their cascade slot: last in styles.css', () => {
		expect(importsOf('styles.css').at(-1)).toBe('surfaces/chat-legacy.css');
	});
});

describe('identity ink replaces the light-mode name filter (chat#11)', () => {
	test('no stylesheet dims names with filter: brightness', () => {
		const offenders: string[] = [];
		for (const file of cssFiles(srcDir)) {
			const css = stripComments(readFileSync(file, 'utf8'));
			for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
				if (/\.profile-name-text|\.username\b/.test(selector) && /filter\s*:\s*brightness/.test(body)) {
					offenders.push(`${relative(srcDir, file)}: ${selector.trim().replace(/\s+/g, ' ')}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
