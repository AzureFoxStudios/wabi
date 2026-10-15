import { afterEach, describe, expect, test } from 'bun:test';
import { get } from 'svelte/store';
import { THEMES } from './themes';
import { applyRoles, contrastRatio, deriveRoles, hueGap, identityInk, isLightTheme, toOklch } from './roles';
import { identityFor, identityStyle, identityTheme, inkFor } from './identity';

/** The showcase people (fixtures): pastels picked on a dark theme, the hard case for Daylight. */
const SHOWCASE: Record<string, string> = {
	mira: '#98d8c8',
	theo: '#edba89',
	nora: '#c0b0e8',
	jun: '#9bbddb',
	amara: '#e5a9ad',
	leo: '#bdd19b',
	sofia: '#dfc98f',
	iris: '#a7c8cf',
};

/** 64 reproducible random colors (mulberry32), so a failure names the same color every run. */
function seededColors(count: number, seed: number): string[] {
	let a = seed >>> 0;
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return Array.from({ length: count }, () => '#' + Math.floor(next() * 0x1000000).toString(16).padStart(6, '0'));
}

const RANDOM = seededColors(64, 0x5ea1);
const surfaces = (roles: Record<string, string>) => ['--w-bg', '--w-bg2', '--w-raise'].map((token) => roles[token]);

describe('identity ink (spec §5.5)', () => {
	test('names read at 4.5:1 on the page, the quiet panel and the raised surface, and initials on their disc', () => {
		for (const theme of Object.values(THEMES)) {
			const roles = deriveRoles(theme);
			for (const color of [...Object.values(SHOWCASE), ...RANDOM]) {
				const id = identityInk(color, theme);
				if (!id) throw new Error(`${theme.id}: no ink for ${color}`);
				for (const surface of surfaces(roles)) {
					const ratio = contrastRatio(id.ink, surface);
					if (ratio < 4.5) throw new Error(`${theme.id}: ${color} → ink ${id.ink} is ${ratio.toFixed(2)}:1 on ${surface}`);
				}
				const onDisc = contrastRatio(id.initial, id.disc);
				if (onDisc < 4.5) throw new Error(`${theme.id}: ${color} → initial ${id.initial} is ${onDisc.toFixed(2)}:1 on disc ${id.disc}`);
			}
		}
	});

	test('a name keeps its hue in every theme', () => {
		for (const theme of Object.values(THEMES)) {
			for (const color of Object.values(SHOWCASE)) {
				expect(hueGap(identityInk(color, theme)!.ink, color)).toBeLessThan(5);
			}
		}
	});

	test('Daylight turns dark-theme pastels into ink: the same hue, much darker than the original', () => {
		const light = THEMES.light;
		const bg = deriveRoles(light)['--w-bg'];
		for (const color of Object.values(SHOWCASE)) {
			const { ink } = identityInk(color, light)!;
			expect(contrastRatio(color, bg)).toBeLessThan(2.1); // the raw pastel: unreadable
			expect(toOklch(ink)[0]).toBeLessThanOrEqual(0.505); // clamped to L 0.30–0.50 (8-bit rounding aside)
			expect(contrastRatio(ink, bg)).toBeGreaterThanOrEqual(4.5);
		}
	});

	test('lightness is clamped per mode and chroma is capped', () => {
		for (const theme of Object.values(THEMES)) {
			const light = isLightTheme(theme);
			for (const color of ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#000000', '#ffffff']) {
				const { ink } = identityInk(color, theme)!;
				const [, C] = toOklch(ink);
				// The contrast nudge may mix toward the text color, which only lowers chroma further.
				expect(C).toBeLessThanOrEqual((light ? 0.15 : 0.13) + 0.01);
			}
		}
	});

	test('the reference themes reproduce the contract minimums', () => {
		const expected: Record<string, [number, number]> = {
			'wabi-ink': [8.2, 4.6],
			light: [5.0, 4.7],
			dark: [8.0, 4.5],
			'high-contrast': [11.8, 6.3],
			joker: [7.3, 4.5],
		};
		for (const [id, [nameMin, discMin]] of Object.entries(expected)) {
			const theme = THEMES[id];
			const roles = deriveRoles(theme);
			let names = Infinity;
			let discs = Infinity;
			for (const color of Object.values(SHOWCASE)) {
				const ink = identityInk(color, theme)!;
				names = Math.min(names, ...surfaces(roles).map((surface) => contrastRatio(ink.ink, surface)));
				discs = Math.min(discs, contrastRatio(ink.initial, ink.disc));
			}
			expect(Number(names.toFixed(1))).toBe(nameMin);
			expect(Number(discs.toFixed(1))).toBe(discMin);
		}
	});

	test('the disc is the identity mixed into the quiet panel', () => {
		const dark = identityInk('#ff0000', THEMES.dark)!;
		const light = identityInk('#ff0000', THEMES.light)!;
		const bg2Dark = deriveRoles(THEMES.dark)['--w-bg2'];
		const bg2Light = deriveRoles(THEMES.light)['--w-bg2'];
		// Closer to the panel than to the raw color: a tint, not a fill.
		expect(contrastRatio(dark.disc, bg2Dark)).toBeLessThan(contrastRatio(dark.disc, '#ff0000'));
		expect(contrastRatio(light.disc, bg2Light)).toBeLessThan(contrastRatio(light.disc, '#ff0000'));
	});

	test('unreadable colors yield nothing, and results are memoized per theme and color', () => {
		expect(identityInk('var(--status-offline)', THEMES.light)).toBeNull();
		expect(identityInk('', THEMES.light)).toBeNull();
		expect(identityInk('#98D8C8', THEMES.light)).toBe(identityInk(' #98d8c8', THEMES.light));
		expect(identityInk('#98d8c8', THEMES.light)).not.toBe(identityInk('#98d8c8', THEMES.dark));
		// A recolored custom theme under the same id gets fresh ink, not the cached one.
		const custom = { ...THEMES.dark, id: 'custom' };
		const recolored = { ...custom, colors: { ...custom.colors, bgSecondary: '#f4f1ea', bgTertiary: '#ebe6dc', textPrimary: '#1d211f' } };
		expect(identityInk('#98d8c8', custom)!.ink).not.toBe(identityInk('#98d8c8', recolored)!.ink);
	});
});

describe('identity store', () => {
	const realDocument = (globalThis as { document?: unknown }).document;
	afterEach(() => {
		(globalThis as { document?: unknown }).document = realDocument;
	});

	test('identityStyle emits scoped --ink, --disc and --on, or nothing', () => {
		const { ink, disc, initial } = identityInk('#c0b0e8', THEMES.light)!;
		expect(identityStyle('#c0b0e8', THEMES.light)).toBe(`--ink:${ink};--disc:${disc};--on:${initial};`);
		expect(identityStyle('', THEMES.light)).toBe('');
		expect(identityStyle(undefined, THEMES.light)).toBe('');
		expect(identityStyle('not a color', THEMES.light)).toBe('');
	});

	test('inkFor follows the theme applied to the document', () => {
		const root = { style: { setProperty: () => {} }, setAttribute: () => {} };
		(globalThis as { document?: unknown }).document = { documentElement: root };
		applyRoles(THEMES.light, root as unknown as HTMLElement);
		expect(get(identityTheme).id).toBe('light');
		expect(get(inkFor)('#98d8c8')).toBe(identityStyle('#98d8c8', THEMES.light));
		expect(get(identityFor)('#98d8c8')).toEqual(identityInk('#98d8c8', THEMES.light));
		applyRoles(THEMES['high-contrast'], root as unknown as HTMLElement);
		expect(get(identityTheme).id).toBe('high-contrast');
		expect(get(inkFor)('#98d8c8')).toBe(identityStyle('#98d8c8', THEMES['high-contrast']));
		expect(get(inkFor)(null)).toBe('');
	});

	test('a preview root does not move identity ink off the document theme', () => {
		const root = { style: { setProperty: () => {} }, setAttribute: () => {} };
		const preview = { style: { setProperty: () => {} }, setAttribute: () => {} };
		(globalThis as { document?: unknown }).document = { documentElement: root };
		applyRoles(THEMES.dark, root as unknown as HTMLElement);
		applyRoles(THEMES.light, preview as unknown as HTMLElement);
		expect(get(identityTheme).id).toBe('dark');
	});
});
