/**
 * Design roles
 *
 * The redesign asks the active theme for *roles*, never fixed colors: a surface,
 * a raised and a sunken surface, three text levels, two accents (one for thin
 * lines and icons, one that stamps sealed/security things), an online and a danger
 * color. Every Theme — built-in or custom — can answer, so a new palette needs no
 * redesign work.
 *
 * Roles are emitted as `--w-*` custom properties. The prefix keeps them clear of the
 * legacy `--bg-*` / `--surface-*` / `--accent` namespaces that are still in use.
 *
 * "Character" is the part of a theme that is not color: corner radius, border weight,
 * shadow style and grain. It is set as `data-char` on the root and styled in
 * `styles/character.css`.
 */

import type { Theme, ThemeCharacter } from './themeTypes';

export type RoleTokens = Record<string, string>;

type Rgb = [number, number, number];

function parseColor(value: string | undefined): Rgb | null {
	if (!value) return null;
	const v = value.trim();
	const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
	if (hex) {
		const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
		return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
	}
	const rgb = v.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
	if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
	return null;
}

function linear(channel: number): number {
	const c = channel / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(color: string): number {
	const rgb = parseColor(color);
	if (!rgb) return 0;
	return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

export function contrastRatio(a: string, b: string): number {
	const x = luminance(a);
	const y = luminance(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function mix(a: string, b: string, t: number): string {
	const x = parseColor(a);
	const y = parseColor(b);
	if (!x || !y) return a;
	const channel = (i: number) => Math.round(x[i] + (y[i] - x[i]) * t);
	return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

/** Light themes are detected from their surface, not their id, so custom themes work too. */
export function isLightTheme(theme: Theme): boolean {
	return luminance(theme.colors.bgSecondary) > 0.4;
}

export function characterFor(theme: Theme): ThemeCharacter {
	return theme.character ?? 'soft';
}

/**
 * Two accents, assigned by legibility: the one that reads better against the surface
 * draws thin lines, icons and active states; the other stamps sealed things.
 */
export function assignAccents(theme: Theme): { line: string; seal: string } {
	const surface = theme.colors.bgSecondary;
	const primary = theme.colors.accentHex;
	const secondary = theme.colors.accentSecondaryHex || primary;
	return contrastRatio(primary, surface) >= contrastRatio(secondary, surface)
		? { line: primary, seal: secondary }
		: { line: secondary, seal: primary };
}

/**
 * Nudge `color` toward `toward` until it reaches `min` contrast on every surface in `surfaces`
 * (or give up after 20 steps). A role that sits on several surfaces must pass on all of them.
 */
export function ensureContrastOnAll(color: string, surfaces: string[], toward: string, min: number): string {
	const meets = (candidate: string) => surfaces.every((surface) => contrastRatio(candidate, surface) >= min);
	if (!parseColor(color) || meets(color)) return color;
	for (let step = 1; step <= 20; step++) {
		const next = mix(color, toward, step / 20);
		if (meets(next)) return next;
	}
	return toward;
}

/** Nudge `color` toward `toward` until it reaches `min` contrast on `surface` (or give up after 20 steps). */
export function ensureContrast(color: string, surface: string, toward: string, min: number): string {
	return ensureContrastOnAll(color, [surface], toward, min);
}

/** Text for a filled control: the first of these that reads at 4.5:1 on the fill, otherwise the best of them. */
const ON_FILL_CANDIDATES = ['#101315', '#000000', '#ffffff'];

export function readableOn(fill: string): string {
	let best = ON_FILL_CANDIDATES[0];
	let bestRatio = 0;
	for (const candidate of ON_FILL_CANDIDATES) {
		const ratio = contrastRatio(candidate, fill);
		if (ratio >= 4.5) return candidate;
		if (ratio > bestRatio) {
			best = candidate;
			bestRatio = ratio;
		}
	}
	return best;
}

export function deriveRoles(theme: Theme): RoleTokens {
	const c = theme.colors;
	const { line, seal: sealColor } = assignAccents(theme);
	const text = c.textPrimary;
	const char = characterFor(theme);
	const light = isLightTheme(theme);
	const lineMix = char === 'contrast' ? 60 : 11;
	const bg2 = mix(c.bgSecondary, c.bgTertiary, 0.5);
	// Every surface a role can sit on: the page, the quiet panel, the raised panel and the sunken field well.
	const surfaces = [c.bgSecondary, bg2, c.bgTertiary, c.modalBg];

	// Text-grade colors (accent and danger can both be set as text) must read at 4.5:1 on every surface.
	// Marks and control edges need 3:1 (WCAG 1.4.11). Each nudges toward the text color, the most legible neighbor.
	const accent = ensureContrastOnAll(line, surfaces, text, 4.5);
	const danger = ensureContrastOnAll(c.colorDanger, surfaces, text, 4.5);
	const seal = ensureContrastOnAll(sealColor, surfaces, text, 3);
	const online = ensureContrastOnAll(c.statusOnline, surfaces, text, 3);
	const lineStrong = char === 'contrast' ? text : ensureContrastOnAll(mix(c.bgSecondary, text, 0.22), surfaces, text, 3);

	return {
		'--w-bg': c.bgSecondary,
		'--w-bg2': bg2,
		'--w-raise': c.bgTertiary,
		'--w-sink': c.modalBg,
		'--w-text': text,
		'--w-mute': c.textSecondary,
		// --w-faint is still small *text* (times, kickers, counts), so it is kept readable (>= 4.5:1).
		// --w-deco is the theme's own faintest tone, for borders and glyphs that are purely decorative.
		'--w-faint': ensureContrast(ensureContrast(c.textTertiary, c.bgSecondary, c.textPrimary, 4.5), c.bgTertiary, c.textPrimary, 4.5),
		'--w-deco': c.textTertiary,
		'--w-line': `color-mix(in srgb, ${text} ${lineMix}%, transparent)`,
		'--w-line-strong': lineStrong,
		'--w-accent': accent,
		// The community's signature color; MainLayout overrides it per server from branding.
		'--w-sig': accent,
		'--w-accent-soft': `color-mix(in srgb, ${accent} 16%, transparent)`,
		'--w-on-accent': readableOn(accent),
		'--w-seal': seal,
		'--w-seal-soft': `color-mix(in srgb, ${seal} 14%, transparent)`,
		'--w-online': online,
		'--w-danger': danger,
		'--w-scrim': light ? 'rgba(240, 238, 232, 0.62)' : 'rgba(6, 8, 9, 0.58)',
	};
}

/** Apply roles and character to the document root. Safe to call on every theme change. */
export function applyRoles(theme: Theme, root: HTMLElement = document.documentElement): void {
	for (const [name, value] of Object.entries(deriveRoles(theme))) {
		root.style.setProperty(name, value);
	}
	root.setAttribute('data-char', characterFor(theme));
	root.setAttribute('data-mode', isLightTheme(theme) ? 'light' : 'dark');
}
