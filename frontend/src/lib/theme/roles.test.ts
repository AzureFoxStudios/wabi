import { describe, expect, test } from 'bun:test';
import { THEMES } from './themes';
import { assignAccents, contrastRatio, deriveRoles, isLightTheme, readableOn } from './roles';

/** The four surfaces a role can sit on: page, quiet panel, raised panel, sunken field well. */
const surfacesOf = (roles: Record<string, string>) => ['--w-bg', '--w-bg2', '--w-raise', '--w-sink'].map((token) => roles[token]);

describe('design roles', () => {
	test('faint text stays readable on every theme', () => {
		for (const theme of Object.values(THEMES)) {
			const roles = deriveRoles(theme);
			expect(contrastRatio(roles['--w-faint'], theme.colors.bgSecondary)).toBeGreaterThanOrEqual(4.45);
			expect(contrastRatio(roles['--w-faint'], theme.colors.bgTertiary)).toBeGreaterThanOrEqual(4.45);
		}
	});

	test('text, muted text, accent and danger read at 4.5:1 on every surface', () => {
		for (const theme of Object.values(THEMES)) {
			const roles = deriveRoles(theme);
			for (const surface of surfacesOf(roles)) {
				for (const token of ['--w-text', '--w-mute', '--w-faint', '--w-accent', '--w-danger']) {
					expect(contrastRatio(roles[token], surface)).toBeGreaterThanOrEqual(4.5);
				}
			}
		}
	});

	test('seals, presence dots and control edges reach 3:1 on every surface', () => {
		for (const theme of Object.values(THEMES)) {
			const roles = deriveRoles(theme);
			for (const surface of surfacesOf(roles)) {
				for (const token of ['--w-seal', '--w-online', '--w-line-strong']) {
					expect(contrastRatio(roles[token], surface)).toBeGreaterThanOrEqual(3);
				}
			}
		}
	});

	test('text on an accent fill reads at 4.5:1 on every theme', () => {
		for (const theme of Object.values(THEMES)) {
			const roles = deriveRoles(theme);
			expect(contrastRatio(roles['--w-on-accent'], roles['--w-accent'])).toBeGreaterThanOrEqual(4.5);
		}
	});

	test('readableOn picks the dark ink on bright fills and white on dark fills', () => {
		expect(readableOn('#f97316')).toBe('#101315'); // Embers accent: white would be 2.8:1
		expect(readableOn('#202020')).toBe('#ffffff');
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
