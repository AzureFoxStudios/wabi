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

const FONT_SANS =
	'"Zen Kaku Gothic New", "Hiragino Sans", "Yu Gothic", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const FONT_SERIF = '"Shippori Mincho", "Hiragino Mincho ProN", "Yu Mincho", Georgia, serif';
const FONT_MONO = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export function deriveRoles(theme: Theme): RoleTokens {
	const c = theme.colors;
	const { line: accent, seal } = assignAccents(theme);
	const text = c.textPrimary;
	const char = characterFor(theme);
	const light = isLightTheme(theme);
	const lineMix = char === 'contrast' ? 60 : 11;

	return {
		'--w-bg': c.bgSecondary,
		'--w-bg2': mix(c.bgSecondary, c.bgTertiary, 0.5),
		'--w-raise': c.bgTertiary,
		'--w-sink': c.modalBg,
		'--w-text': text,
		'--w-mute': c.textSecondary,
		// The faintest text level is decoration only; muted copy uses --w-mute.
		'--w-faint': c.textTertiary,
		'--w-line': `color-mix(in srgb, ${text} ${lineMix}%, transparent)`,
		'--w-line-strong': char === 'contrast' ? text : `color-mix(in srgb, ${text} 22%, transparent)`,
		'--w-accent': accent,
		'--w-accent-soft': `color-mix(in srgb, ${accent} 16%, transparent)`,
		'--w-on-accent': luminance(accent) > 0.35 ? '#101315' : '#ffffff',
		'--w-seal': seal,
		'--w-seal-soft': `color-mix(in srgb, ${seal} 14%, transparent)`,
		'--w-online': c.statusOnline,
		'--w-danger': c.colorDanger,
		'--w-scrim': light ? 'rgba(240, 238, 232, 0.62)' : 'rgba(6, 8, 9, 0.58)',
		'--w-serif': FONT_SERIF,
		'--w-sans': FONT_SANS,
		'--w-mono': FONT_MONO,
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
