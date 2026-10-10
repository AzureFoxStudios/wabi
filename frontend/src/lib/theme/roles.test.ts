import { describe, expect, test } from 'bun:test';
import { THEMES } from './themes';
import { assignAccents, contrastRatio, deriveRoles, isLightTheme } from './roles';

describe('design roles', () => {
	test('faint text stays readable on every theme', () => {
		for (const theme of Object.values(THEMES)) {
			const roles = deriveRoles(theme);
			expect(contrastRatio(roles['--w-faint'], theme.colors.bgSecondary)).toBeGreaterThanOrEqual(4.45);
			expect(contrastRatio(roles['--w-faint'], theme.colors.bgTertiary)).toBeGreaterThanOrEqual(4.45);
		}
	});

	test('every built-in theme yields the full role set', () => {
		const expected = Object.keys(deriveRoles(THEMES.dark)).sort();
		for (const theme of Object.values(THEMES)) {
			expect(Object.keys(deriveRoles(theme)).sort()).toEqual(expected);
		}
	});

	test('the line accent is never the less legible of the two accents', () => {
		for (const theme of Object.values(THEMES)) {
			const { line, seal } = assignAccents(theme);
			const surface = theme.colors.bgSecondary;
			expect(contrastRatio(line, surface)).toBeGreaterThanOrEqual(contrastRatio(seal, surface));
		}
	});

	test('light themes are detected from the surface, not the id', () => {
		expect(isLightTheme(THEMES.light)).toBe(true);
		expect(isLightTheme(THEMES.dark)).toBe(false);
	});

	test('Joker and High Contrast carry their character', () => {
		expect(THEMES.joker.character).toBe('pixel');
		expect(THEMES['high-contrast'].character).toBe('contrast');
	});
});
