import { describe, expect, test } from 'bun:test';
import { THEMES } from './themes';
import {
	SEAL_CANDIDATES,
	SEAL_MIN_GAP,
	assignAccents,
	characterFor,
	contrastRatio,
	deriveRoles,
	fromOklch,
	hueGap,
	isLightTheme,
	luminance,
	readableOn,
	toHex,
	toOklch,
} from './roles';
import type { Theme } from './themeTypes';

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

describe('seal, lift and status marks (spec §5.4)', () => {
	const themes = Object.values(THEMES);

	test('all 17 built-in themes are covered', () => {
		expect(themes.length).toBe(17);
	});

	test('the seal never shares a hue with the accent', () => {
		for (const theme of themes) {
			const roles = deriveRoles(theme);
			const gap = hueGap(roles['--w-seal'], roles['--w-accent']);
			if (gap < SEAL_MIN_GAP) throw new Error(`${theme.id}: seal ${roles['--w-seal']} is ${gap.toFixed(1)}° from accent ${roles['--w-accent']}`);
		}
	});

	test('the seal reads at 3:1 on every surface, 4.5:1 in High Contrast', () => {
		for (const theme of themes) {
			const roles = deriveRoles(theme);
			const min = characterFor(theme) === 'contrast' ? 4.5 : 3;
			for (const surface of surfacesOf(roles)) {
				expect(contrastRatio(roles['--w-seal'], surface)).toBeGreaterThanOrEqual(min);
			}
		}
	});

	test('the soft seal follows the seal', () => {
		for (const theme of themes) {
			const roles = deriveRoles(theme);
			expect(roles['--w-seal-soft']).toBe(`color-mix(in srgb, ${roles['--w-seal']} 14%, transparent)`);
		}
	});

	test('the four reference themes match the contract table', () => {
		const table: Record<string, { accent: string; seal: string; onBg: number }> = {
			'wabi-ink': { accent: '#d6ad5f', seal: '#e0553f', onBg: 4.92 },
			light: { accent: '#ac500a', seal: '#c23a5c', onBg: 4.92 },
			dark: { accent: '#b698ff', seal: '#d9543c', onBg: 4.48 },
			'high-contrast': { accent: '#ffb000', seal: '#d9543c', onBg: 5.28 },
		};
		for (const [id, row] of Object.entries(table)) {
			const roles = deriveRoles(THEMES[id]);
			expect(toHex(roles['--w-accent'])).toBe(row.accent);
			expect(toHex(roles['--w-seal'])).toBe(row.seal);
			expect(Number(contrastRatio(roles['--w-seal'], roles['--w-bg']).toFixed(2))).toBe(row.onBg);
		}
	});

	test('a theme whose seal is a shade of its accent gets the first candidate that stands apart', () => {
		const light = THEMES.light;
		const sameHue: Theme = { ...light, colors: { ...light.colors, accentSecondaryHex: light.colors.accentHex } };
		expect(toHex(deriveRoles(sameHue)['--w-seal'])).toBe(SEAL_CANDIDATES[1].toLowerCase()); // vermilion is only 9° from burnt orange
		const grey: Theme = { ...THEMES.dark, colors: { ...THEMES.dark.colors, accentHex: '#b698ff', accentSecondaryHex: '#4a4a4a' } };
		expect(toHex(deriveRoles(grey)['--w-seal'])).toBe(SEAL_CANDIDATES[0].toLowerCase()); // a grey seal carries no hue
	});

	test('custom accents keep the seal apart after the final contrast nudge', () => {
		// Mixing toward the text color moves the hue, and High Contrast mixes furthest (to 4.5:1). This pair
		// once ended at 29.6°: its own seal stood apart at 3:1 and drifted under the gap at 4.5:1.
		const hc = THEMES['high-contrast'];
		const drifted: Theme = { ...hc, colors: { ...hc.colors, accentHex: '#5a064f', accentSecondaryHex: '#21103f' } };
		const roles = deriveRoles(drifted);
		expect(hueGap(roles['--w-seal'], roles['--w-accent'])).toBeGreaterThanOrEqual(SEAL_MIN_GAP);
		expect(contrastRatio(roles['--w-seal'], roles['--w-bg'])).toBeGreaterThanOrEqual(4.5);

		// Reproducible random accent pairs (mulberry32) on four bases, light, dark and contrast.
		let a = 0x5ea1 >>> 0;
		const next = () => {
			a = (a + 0x6d2b79f5) >>> 0;
			let t = a;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const hex = () => '#' + Math.floor(next() * 0x1000000).toString(16).padStart(6, '0');
		for (const base of [THEMES['wabi-ink'], THEMES.light, THEMES.dark, hc]) {
			for (let i = 0; i < 100; i++) {
				const custom: Theme = { ...base, id: 'custom', colors: { ...base.colors, accentHex: hex(), accentSecondaryHex: hex() } };
				const r = deriveRoles(custom);
				const seal = r['--w-seal'];
				const accent = r['--w-accent'];
				const accentIsGrey = toOklch(accent)[1] < 0.03;
				if (!accentIsGrey && hueGap(seal, accent) < SEAL_MIN_GAP) {
					throw new Error(`${base.id} ${custom.colors.accentHex}/${custom.colors.accentSecondaryHex}: seal ${seal} is ${hueGap(seal, accent).toFixed(1)}° from ${accent}`);
				}
				const min = characterFor(custom) === 'contrast' ? 4.5 : 3;
				for (const surface of surfacesOf(r)) expect(contrastRatio(seal, surface)).toBeGreaterThanOrEqual(min);
			}
		}
	});

	test('lift is the quiet panel in dark modes and a paper step above the page in light', () => {
		for (const theme of themes) {
			const roles = deriveRoles(theme);
			if (isLightTheme(theme) && characterFor(theme) !== 'contrast') {
				expect(luminance(roles['--w-lift'])).toBeGreaterThanOrEqual(luminance(roles['--w-bg']));
			} else {
				expect(roles['--w-lift']).toBe(roles['--w-bg2']);
			}
		}
		expect(deriveRoles(THEMES.light)['--w-lift']).toBe('#fefdfc');
	});

	test('warn, info and ok marks reach 3:1 on every surface', () => {
		for (const theme of themes) {
			const roles = deriveRoles(theme);
			for (const surface of surfacesOf(roles)) {
				for (const token of ['--w-warn', '--w-info', '--w-ok']) {
					expect(contrastRatio(roles[token], surface)).toBeGreaterThanOrEqual(3);
				}
			}
		}
	});
});

describe('OKLCH helpers', () => {
	test('round-trip an in-gamut color', () => {
		for (const color of ['#d9543c', '#c23a5c', '#3d6fb6', '#98d8c8', '#101315', '#ffffff']) {
			const [L, C, h] = toOklch(color);
			expect(fromOklch(L, C, h)).toBe(color);
		}
	});

	test('out-of-gamut chroma is reduced, keeping lightness and hue', () => {
		const out = fromOklch(0.7, 0.4, 150);
		const [L, C, h] = toOklch(out);
		expect(Math.abs(L - 0.7)).toBeLessThan(0.01);
		expect(C).toBeLessThan(0.4);
		expect(hueGap(out, fromOklch(0.7, 0.05, 150))).toBeLessThan(3);
	});

	test('hue gap is circular and symmetric', () => {
		expect(hueGap('#d9543c', '#d9543c')).toBe(0);
		expect(hueGap('#d9543c', '#3d6fb6')).toBeCloseTo(hueGap('#3d6fb6', '#d9543c'), 6);
		for (const [a, b] of [['#ff0000', '#ff00ff'], ['#ff0000', '#00ffff'], ['#ac500a', '#c23a5c']]) {
			expect(hueGap(a, b)).toBeGreaterThanOrEqual(0);
			expect(hueGap(a, b)).toBeLessThanOrEqual(180);
		}
	});
});
