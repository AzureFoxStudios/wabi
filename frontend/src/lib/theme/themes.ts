/**
 * Theme Definitions
 * Derived from compact BasePalettes via the buildTokens derivation engine.
 * This file maintains backward compatibility — all existing imports work unchanged.
 *
 * Curated core set: 8 themes × ~20 colors + derivation engine.
 */

import { buildTheme } from './buildTokens';
import { ALL_PALETTES, DEFAULT_PALETTE } from './palettes';
import type { Theme, ThemeColors, ThemeGradients } from './themeTypes';

// Build all themes from compact palettes
const allThemes = ALL_PALETTES.map(buildTheme);

// Export individual themes for direct import
export const darkTheme = allThemes.find(t => t.id === 'dark')!;
export const lightTheme = allThemes.find(t => t.id === 'light')!;
export const blueTheme = allThemes.find(t => t.id === 'blue')!;
export const highContrastTheme = allThemes.find(t => t.id === 'high-contrast')!;
export const forestTheme = allThemes.find(t => t.id === 'forest')!;
export const emberTheme = allThemes.find(t => t.id === 'ember')!;
export const sakuraTheme = allThemes.find(t => t.id === 'sakura')!;
export const spaceTheme = allThemes.find(t => t.id === 'space')!;
export const balatroTheme = allThemes.find(t => t.id === 'balatro')!;
export const spireTheme = allThemes.find(t => t.id === 'spire')!;
export const matrixTheme = allThemes.find(t => t.id === 'matrix')!;
export const warpTheme = allThemes.find(t => t.id === 'warp')!;

// Registry for lookup
export const THEMES: Record<string, Theme> = Object.fromEntries(
	allThemes.map(t => [t.id, t])
);

// Default theme: Nebula (dark)
export const DEFAULT_THEME = darkTheme;

// Alias map for legacy/renamed theme IDs so old stored preferences still resolve.
const THEME_ALIASES: Record<string, string> = {
	'midnight-blue': 'blue',
	'midnight': 'blue',
	'vscode-high-contrast': 'high-contrast',
	'professional': 'light',
	'paper-dawn': 'light',
	'slate-signal': 'blue',
	'catppuccin-mocha': 'sakura',
	'dracula': 'sakura',
	'nord': 'blue',
	'tokyo-night': 'blue',
	'graphite-lime': 'forest',
};

// Get theme by ID
export function getThemeById(id: string): Theme {
	const resolved = THEME_ALIASES[id] || id;
	return THEMES[resolved] || DEFAULT_THEME;
}

export type { Theme, ThemeColors, ThemeGradients } from './themeTypes';
