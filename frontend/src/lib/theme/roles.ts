/**
 * Design roles
 *
 * The redesign asks the active theme for *roles*, never fixed colors: a surface,
 * a raised and a sunken surface, a lift for objects in flow, three text levels, two
 * accents (one for thin lines and icons, one that stamps sealed/security things and is
 * kept at least SEAL_MIN_GAP hue degrees away from the first), an online and a danger
 * color, and three status marks. Every Theme — built-in or custom — can answer, so a
 * new palette needs no redesign work. People's own colors go through `identityInk`.
 *
 * Roles are emitted as `--w-*` custom properties. The prefix keeps them clear of the
 * legacy `--bg-*` / `--surface-*` / `--accent` namespaces that are still in use.
 *
 * "Character" is the part of a theme that is not color: corner radius, border weight,
 * shadow style and grain. It is set as `data-char` on the root and styled in
 * `styles/character.css`.
 */

import { writable, type Readable } from 'svelte/store';
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

function hexOf([r, g, b]: Rgb): string {
	return '#' + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
}

/** Any color `parseColor` understands, as lower-case `#rrggbb` (or null when it cannot be read). */
export function toHex(color: string): string | null {
	const rgb = parseColor(color);
	return rgb ? hexOf(rgb) : null;
}

/** Mix two colors in sRGB and return `#rrggbb`; `t` is the share of `b`. */
function mixHex(a: string, b: string, t: number): string {
	const x = parseColor(a);
	const y = parseColor(b);
	if (!x || !y) return a;
	return hexOf([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as Rgb);
}

const delinear = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** sRGB to OKLCH as `[L 0..1, C, hue in degrees]`. Unreadable colors come back as black. */
export function toOklch(color: string): [number, number, number] {
	const [r, g, b] = (parseColor(color) ?? [0, 0, 0]).map(linear);
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}

function oklchToLinearRgb(L: number, C: number, h: number): [number, number, number] {
	const A = C * Math.cos((h * Math.PI) / 180);
	const B = C * Math.sin((h * Math.PI) / 180);
	const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
	const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
	const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
}

/** OKLCH to `#rrggbb`, giving up chroma (never lightness or hue) until the color fits in sRGB. */
export function fromOklch(L: number, C: number, h: number): string {
	for (let chroma = C; chroma > 0; chroma -= 0.004) {
		const rgb = oklchToLinearRgb(L, chroma, h);
		if (rgb.every((x) => x >= -0.0005 && x <= 1.0005)) return hexOf(rgb.map(delinear) as Rgb);
	}
	return hexOf(oklchToLinearRgb(L, 0, h).map(delinear) as Rgb);
}

/** Circular distance between two colors' OKLCH hues, in degrees (0..180). */
export function hueGap(a: string, b: string): number {
	const d = Math.abs(toOklch(a)[2] - toOklch(b)[2]) % 360;
	return d > 180 ? 360 - d : d;
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

/**
 * The seal says *who can read it*, the accent says *what is selected*: they must never share a hue.
 * When a theme's own seal sits within SEAL_MIN_GAP OKLCH degrees of its accent, the first of these
 * that is far enough away stands in: vermilion (shuniku), crimson lake, indigo ink.
 */
export const SEAL_CANDIDATES = ['#D9543C', '#C23A5C', '#3D6FB6'];
export const SEAL_MIN_GAP = 30;

/** Below this OKLCH chroma a color is grey: its hue means nothing, so it cannot carry the seal. */
const ACHROMATIC = 0.03;

function sealStandsApart(seal: string, accent: string): boolean {
	if (toOklch(seal)[1] < ACHROMATIC) return false;
	if (toOklch(accent)[1] < ACHROMATIC) return true;
	return hueGap(seal, accent) >= SEAL_MIN_GAP;
}

/** Seal color for a theme: its own seal when that stands apart from the accent, else the first candidate that does. */
function pickSeal(themeSeal: string, accent: string, surfaces: string[], text: string, min: number): string {
	const own = ensureContrastOnAll(themeSeal, surfaces, text, 3);
	if (sealStandsApart(own, accent)) return ensureContrastOnAll(own, surfaces, text, min);
	const candidate = SEAL_CANDIDATES.find((c) => sealStandsApart(c, accent)) ?? SEAL_CANDIDATES[0];
	return ensureContrastOnAll(candidate, surfaces, text, min);
}

/** The quiet panel (sidebar, companion, overlays): halfway between the page and the raised surface. */
function quietSurface(theme: Theme): string {
	return mix(theme.colors.bgSecondary, theme.colors.bgTertiary, 0.5);
}

export function deriveRoles(theme: Theme): RoleTokens {
	const c = theme.colors;
	const { line, seal: sealColor } = assignAccents(theme);
	const text = c.textPrimary;
	const char = characterFor(theme);
	const light = isLightTheme(theme);
	const lineMix = char === 'contrast' ? 60 : 11;
	const bg2 = quietSurface(theme);
	// Every surface a role can sit on: the page, the quiet panel, the raised panel and the sunken field well.
	const surfaces = [c.bgSecondary, bg2, c.bgTertiary, c.modalBg];

	// Text-grade colors (accent and danger can both be set as text) must read at 4.5:1 on every surface.
	// Marks and control edges need 3:1 (WCAG 1.4.11). Each nudges toward the text color, the most legible neighbor.
	const accent = ensureContrastOnAll(line, surfaces, text, 4.5);
	const danger = ensureContrastOnAll(c.colorDanger, surfaces, text, 4.5);
	// High Contrast holds the seal to text grade, because its chips and permission rows are read, not glanced at.
	const seal = pickSeal(sealColor, accent, surfaces, text, char === 'contrast' ? 4.5 : 3);
	const online = ensureContrastOnAll(c.statusOnline, surfaces, text, 3);
	const lineStrong = char === 'contrast' ? text : ensureContrastOnAll(mix(c.bgSecondary, text, 0.22), surfaces, text, 3);
	// Objects you can pick up (cards, attachments, the composer). In dark modes the quiet panel; in light a
	// paper step brighter than the page, so a card lifts off it instead of sinking into it.
	const lift = light && char !== 'contrast' ? mixHex(c.bgSecondary, '#ffffff', 0.7) : bg2;

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
		'--w-lift': lift,
		// Status marks: 7px dots and glyphs that always come with a word, so 3:1 (WCAG 1.4.11) is enough.
		'--w-warn': ensureContrastOnAll(c.colorWarning, surfaces, text, 3),
		'--w-info': ensureContrastOnAll(c.colorInfo, surfaces, text, 3),
		'--w-ok': ensureContrastOnAll(c.colorSuccess, surfaces, text, 3),
		'--w-scrim': light ? 'rgba(240, 238, 232, 0.62)' : 'rgba(6, 8, 9, 0.58)',
	};
}

/**
 * Identity colors are user data (any hex) and are never painted raw: a pastel picked on a dark theme is
 * 1.5:1 on Daylight paper. Each one becomes, per theme:
 * - `ink`: the same hue, OKLCH lightness clamped to the mode and chroma capped (reduced further until it
 *   fits sRGB), then nudged to 4.5:1 on the page, the quiet panel and the raised surface (names, mentions);
 * - `disc`: the color mixed 30% (light 26%) into the quiet panel (avatar placeholders);
 * - `initial`: the ink nudged to 4.5:1 on that disc.
 */
export interface IdentityInk {
	ink: string;
	disc: string;
	initial: string;
}

const IDENTITY_LIGHTNESS = { light: [0.3, 0.5], dark: [0.76, 0.9], contrast: [0.84, 0.97] } as const;

function computeIdentityInk(source: string, theme: Theme): IdentityInk {
	const c = theme.colors;
	const light = isLightTheme(theme);
	const range = light ? IDENTITY_LIGHTNESS.light : characterFor(theme) === 'contrast' ? IDENTITY_LIGHTNESS.contrast : IDENTITY_LIGHTNESS.dark;
	const bg2 = quietSurface(theme);
	const text = c.textPrimary;
	const [L, C, h] = toOklch(source);
	const shaped = fromOklch(Math.min(range[1], Math.max(range[0], L)), Math.min(C, light ? 0.15 : 0.13), h);
	const ink = toHex(ensureContrastOnAll(shaped, [c.bgSecondary, bg2, c.bgTertiary], text, 4.5)) ?? shaped;
	const disc = mixHex(bg2, source, light ? 0.26 : 0.3);
	const initial = toHex(ensureContrastOnAll(ink, [disc], text, 4.5)) ?? ink;
	return { ink, disc, initial };
}

/** Memo per theme (keyed by everything the ink depends on, so a recolored custom theme gets fresh ink) and color. */
const identityMemo = new Map<string, Map<string, IdentityInk | null>>();

export function identityInk(color: string, theme: Theme): IdentityInk | null {
	const c = theme.colors;
	const themeKey = [theme.id, characterFor(theme), c.bgSecondary, c.bgTertiary, c.textPrimary].join('|');
	let byColor = identityMemo.get(themeKey);
	if (!byColor) {
		if (identityMemo.size >= 24) identityMemo.clear();
		byColor = new Map();
		identityMemo.set(themeKey, byColor);
	}
	const key = color.trim().toLowerCase();
	if (byColor.has(key)) return byColor.get(key) ?? null;
	const source = toHex(key);
	const result = source ? computeIdentityInk(source, theme) : null;
	if (byColor.size >= 4096) byColor.clear();
	byColor.set(key, result);
	return result;
}

const appliedThemeStore = writable<Theme | null>(null);
let lastAppliedTheme: Theme | null = null;

/**
 * The theme whose roles are on the document right now. Helpers that compute colors per theme (identity
 * ink) follow this rather than the preference store, so they always match what is on screen, including
 * previews and the showcase, which apply a theme without saving it.
 */
export const appliedTheme: Readable<Theme | null> = { subscribe: appliedThemeStore.subscribe };

/** Apply roles and character to the document root. Safe to call on every theme change. */
export function applyRoles(theme: Theme, root: HTMLElement = document.documentElement): void {
	for (const [name, value] of Object.entries(deriveRoles(theme))) {
		root.style.setProperty(name, value);
	}
	root.setAttribute('data-char', characterFor(theme));
	root.setAttribute('data-mode', isLightTheme(theme) ? 'light' : 'dark');
	// Re-applying the same theme (every preference change does) must not wake every name on screen.
	if (typeof document !== 'undefined' && root === document.documentElement && theme !== lastAppliedTheme) {
		lastAppliedTheme = theme;
		appliedThemeStore.set(theme);
	}
}
