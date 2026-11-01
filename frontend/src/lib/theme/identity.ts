/**
 * Identity ink for the theme on screen (spec §5.5).
 *
 * A person's chosen color is user data and is never painted raw. `identityInk` (roles.ts) turns it into a
 * name ink, an avatar disc and an initial that read in the current theme; this module hands those to
 * components as inline custom properties, scoped to the element that shows the person:
 *
 *   <span style={$inkFor(user.color)}>…</span>     →  --ink, --disc, --on
 *   .name   { color: var(--ink); }
 *   .avatar { background: var(--disc); color: var(--on); }
 *
 * The properties are never set globally. When the color is missing or unreadable the helper returns '' so
 * the element keeps its inherited text color.
 */

import { derived, type Readable } from 'svelte/store';
import type { Theme } from './themeTypes';
import { currentTheme } from './themeStore';
import { appliedTheme, identityInk, identityThemeKey, type IdentityInk } from './roles';

export type { IdentityInk } from './roles';

/** Inline custom properties for one person in one theme ('' when the color cannot be read). */
export function identityStyle(color: string | null | undefined, theme: Theme): string {
	if (!color) return '';
	const ink = identityInk(color, theme);
	return ink ? `--ink:${ink.ink};--disc:${ink.disc};--on:${ink.initial};` : '';
}

/**
 * The theme identity colors are computed for: the one applied to the document, falling back to the saved
 * preference before anything has been applied (first paint, tests).
 *
 * It only emits when the ink would change. Both sources re-emit far more often than that: every preference
 * change (loading flags, font toggles) re-derives `currentTheme`, a custom theme arrives as a fresh object each
 * time, and a store holding an object always notifies. Without this guard each of those would re-run every
 * name on screen for the same result.
 */
export const identityTheme: Readable<Theme> = (() => {
	let key: string | undefined;
	return derived([currentTheme, appliedTheme], ([$current, $applied], set: (theme: Theme) => void) => {
		const theme = $applied ?? $current;
		const next = identityThemeKey(theme);
		if (next === key) return;
		key = next;
		set(theme);
	});
})();

/** `$identityFor(color)` → `{ ink, disc, initial }` for the theme on screen, or null. Memoized in roles.ts. */
export const identityFor: Readable<(color: string | null | undefined) => IdentityInk | null> = derived(
	identityTheme,
	($theme) => (color) => (color ? identityInk(color, $theme) : null)
);

/** `$inkFor(color)` → `--ink:…;--disc:…;--on:…;` for the theme on screen, or ''. Memoized in roles.ts. */
export const inkFor: Readable<(color: string | null | undefined) => string> = derived(
	identityTheme,
	($theme) => (color) => identityStyle(color, $theme)
);
