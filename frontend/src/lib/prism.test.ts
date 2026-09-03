import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Prism, { ensurePrismGrammars } from './prism';

describe('prism grammar loading', () => {
	test('pins the Prism core instance to the global', () => {
		expect(Prism).toBeDefined();
		expect((globalThis as { Prism?: unknown }).Prism).toBe(Prism);
	});

	test('ensurePrismGrammars registers grammars in dependency-safe order', async () => {
		await ensurePrismGrammars();
		expect(Prism.languages.javascript).toBeDefined();
		expect(Prism.languages.typescript).toBeDefined();
		expect(Prism.languages.c).toBeDefined();
		expect(Prism.languages.cpp).toBeDefined();
		expect(Prism.languages.csharp).toBeDefined();
		expect(Prism.languages.rust).toBeDefined();
		expect(Prism.languages.go).toBeDefined();
		expect(Prism.languages.ruby).toBeDefined();
		expect(Prism.languages.bash).toBeDefined();
		expect(Prism.languages.json).toBeDefined();
		expect(Prism.languages.css).toBeDefined();
		expect(Prism.languages.markdown).toBeDefined();

		const highlighted = Prism.highlight('let x = 1;', Prism.languages.rust, 'rust');
		expect(highlighted).toContain('token');
		expect(highlighted).toContain('let');
	});

	test('is idempotent (cached promise)', async () => {
		await Promise.all([ensurePrismGrammars(), ensurePrismGrammars()]);
		expect(Prism.languages.rust).toBeDefined();
	});
});

describe('prism import convention', () => {
	// Statically importing prismjs (or prismjs/components/*) outside of
	// lib/prism.ts reintroduces the Rollup eager-component / lazy-core
	// evaluation-order hazard that broke the app bundle on Tim 2026-09-02.
	function collectSourceFiles(dir: string, acc: string[] = []): string[] {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				collectSourceFiles(full, acc);
			} else if (/\.(ts|svelte)$/.test(entry.name)) {
				acc.push(full);
			}
		}
		return acc;
	}

	test('no prismjs imports outside lib/prism.ts', () => {
		const srcRoot = join(import.meta.dir, '..');
		const offenders: string[] = [];
		for (const file of collectSourceFiles(srcRoot)) {
			const rel = file.slice(srcRoot.length + 1);
			if (rel === 'lib/prism.ts' || rel === 'lib/prism.test.ts') continue;
			const content = readFileSync(file, 'utf8');
			if (/prismjs\/components/.test(content) || /from\s+['"]prismjs['"]/.test(content)) {
				offenders.push(rel);
			}
		}
		expect(offenders).toEqual([]);
	});
});
