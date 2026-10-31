/**
 * The Settings › Appearance theme picker (design contract §8.9).
 *
 * - Themes are shown in kicker groups: CALM, ACCESSIBLE & EXPRESSIVE, then every other theme
 *   behind "Show all N themes". High Contrast and Joker are in the first view on purpose.
 * - Each preview is a miniature shell drawn from the theme's own roles (`deriveRoles`), so it
 *   shows that theme's real page, quiet panel, ink, signature, seal and corners rather than
 *   colours picked for the card. The roles are written as inline custom properties on the
 *   preview element, which scopes them to it (they win over the page's inherited roles).
 * - The character word beside the name says what kind of theme it is: `light`, `dark`,
 *   `pixel` (dot-matrix type), or `motion` (a strong ambient animation).
 */
import { characterFor, deriveRoles, isLightTheme } from './roles';
import type { Theme, ThemeCharacter } from './themeTypes';

export interface ThemePickerGroup {
	id: 'calm' | 'expressive' | 'more';
	/** Kicker text (rendered uppercase by .w-kicker). */
	label: string;
	themes: Theme[];
}

/** First view, in order. Ids that no longer exist are skipped. */
export const CALM_THEME_IDS = ['wabi-ink', 'light', 'dark', 'blue', 'forest'] as const;
export const EXPRESSIVE_THEME_IDS = ['high-contrast', 'joker', 'sakura', 'ember', 'space'] as const;

/** Ambient intensity from which a theme reads as a moving theme rather than a still one. */
export const MOTION_INTENSITY = 0.75;

/**
 * Per-character corner scale and edge width. They mirror styles/character.css (a test keeps the
 * two in step), because a preview has to draw a character other than the one on <html>.
 */
export const CHARACTER_METRICS: Record<ThemeCharacter, { rs: number; bw: number }> = {
	soft: { rs: 1, bw: 1 },
	ink: { rs: 0.7, bw: 1 },
	contrast: { rs: 0.5, bw: 1 },
	pixel: { rs: 0.2, bw: 2 }
};

/** The pixel character's title face (character.css `--w-serif` under data-char='pixel'). */
export const PIXEL_SERIF = "'Pixelify Sans', 'Courier New', monospace";
/** The base serif (typography.css :root). Previews restate it, so a pixel page still shows
 *  every other theme's "Aa" in Shippori. The preview draws only Latin, so no script variant. */
export const BASE_SERIF = "'Wabi Ellipsis', 'Shippori Mincho', 'Hiragino Mincho ProN', 'Yu Mincho', Georgia, serif";

export function themePickerGroups(themes: Record<string, Theme>): ThemePickerGroup[] {
	const pick = (ids: readonly string[]) => ids.map((id) => themes[id]).filter((theme): theme is Theme => Boolean(theme));
	const calm = pick(CALM_THEME_IDS);
	const expressive = pick(EXPRESSIVE_THEME_IDS);
	const shown = new Set([...calm, ...expressive].map((theme) => theme.id));
	const more = Object.values(themes).filter((theme) => !shown.has(theme.id));
	return [
		{ id: 'calm', label: 'Calm', themes: calm },
		{ id: 'expressive', label: 'Accessible & expressive', themes: expressive },
		{ id: 'more', label: 'More themes', themes: more }
	];
}

/** `light`, `dark`, `pixel` or `motion`; empty for High Contrast, whose name already says it. */
export function themeCharacterWord(theme: Theme): string {
	const character = characterFor(theme);
	if (character === 'pixel') return 'pixel';
	if (character === 'contrast') return '';
	if (isLightTheme(theme)) return 'light';
	const ambient = theme.ambient;
	if (ambient && ambient.effect !== 'none' && (ambient.intensity ?? 0) >= MOTION_INTENSITY) return 'motion';
	return 'dark';
}

/**
 * Inline style for a preview element: the theme's roles plus its character metrics
 * (`--tp-rs` corner scale, `--tp-bw` edge width, and its title face as `--w-serif`).
 * Values are role colours and color-mix() strings from deriveRoles; nothing here is user input.
 */
export function themePreviewStyle(theme: Theme): string {
	const character = characterFor(theme);
	const metrics = CHARACTER_METRICS[character] ?? CHARACTER_METRICS.soft;
	const declarations = Object.entries(deriveRoles(theme)).map(([name, value]) => `${name}: ${value}`);
	declarations.push(`--tp-rs: ${metrics.rs}`, `--tp-bw: ${metrics.bw}px`);
	declarations.push(`--w-serif: ${character === 'pixel' ? PIXEL_SERIF : BASE_SERIF}`);
	return declarations.join('; ');
}

/** Attributes that describe the previewed theme on its preview element. */
export function themePreviewAttributes(theme: Theme): { 'data-theme': string; 'data-char': ThemeCharacter; 'data-mode': 'light' | 'dark' } {
	return {
		'data-theme': theme.id,
		'data-char': characterFor(theme),
		'data-mode': isLightTheme(theme) ? 'light' : 'dark'
	};
}

/**
 * What choosing a theme in the picker does. A new theme applies at once and is saved after a
 * pause. Choosing the theme already shown does nothing, unless its last save failed: then it
 * saves again, so "choose it again" (or Try again) really retries.
 */
export function themeChoiceAction(chosenId: string, currentId: string, lastSaveFailed: boolean): 'apply' | 'retry' | 'none' {
	if (chosenId !== currentId) return 'apply';
	return lastSaveFailed ? 'retry' : 'none';
}
