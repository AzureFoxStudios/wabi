import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from './locales/en.json';
import es from './locales/es.json';
import th from './locales/th.json';

/**
 * A label key written in a component but missing from the locale files is
 * shown to people raw ("cch.kind_gallery"). This walks the source for quoted
 * keys under the sections named below and requires each one in every locale.
 */
const SECTIONS = ['cch', 'dm', 'ulist', 'upop', 'wb', 'crt'];
const SRC = join(import.meta.dir, '..', '..');

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		if (!/\.(svelte|ts)$/.test(entry.name) || /\.test\.ts$/.test(entry.name)) return [];
		return [path];
	});
}

function usedKeys(): string[] {
	const pattern = new RegExp(`['"\`]((?:${SECTIONS.join('|')})\\.[a-z][a-z0-9_]*)['"\`]`, 'g');
	const keys = new Set<string>();
	for (const file of sourceFiles(SRC)) {
		for (const match of readFileSync(file, 'utf8').matchAll(pattern)) keys.add(match[1]);
	}
	return [...keys].sort();
}

describe('label keys used in the app', () => {
	const keys = usedKeys();
	for (const [name, locale] of Object.entries({ en, es, th } as unknown as Record<string, Record<string, Record<string, unknown>>>)) {
		test(`every one has ${name} text`, () => {
			expect(keys.length).toBeGreaterThan(100);
			const missing = keys.filter((key) => {
				const [section, leaf] = key.split('.');
				return typeof locale[section]?.[leaf] !== 'string';
			});
			expect(missing).toEqual([]);
		});
	}
});
