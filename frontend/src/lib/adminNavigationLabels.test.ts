import { describe, expect, test } from 'bun:test';
import { ADMIN_SECTIONS } from './adminNavigation';
import en from './i18n/locales/en.json';

describe('admin navigation labels', () => {
	test('every section names keys that exist, and no two sections share a label', () => {
		const words = (en as { admin_nav: Record<string, string> }).admin_nav;
		const labels = ADMIN_SECTIONS.map((section) => {
			expect(section.labelKey).toBe(`admin_nav.${section.id}`);
			expect(section.descriptionKey).toBe(`admin_nav.${section.id}_desc`);
			expect(words[section.id]).toBeTruthy();
			expect(words[`${section.id}_desc`]).toBeTruthy();
			return words[section.id];
		});
		expect(new Set(labels).size).toBe(labels.length);
	});
});
