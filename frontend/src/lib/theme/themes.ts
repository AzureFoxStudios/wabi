/**
 * Theme Definitions
 * Derived from compact BasePalettes via the buildTokens derivation engine.
 * This file maintains backward compatibility — all existing imports work unchanged.
 *
 * Previously: 14 themes × 84 hardcoded properties = 1,176 values
 * Now: 14 palettes × ~20 colors + derivation engine
 */

import { buildTheme } from './buildTokens';
import { ALL_PALETTES, DEFAULT_PALETTE } from './palettes';
import type { Theme, ThemeColors, ThemeGradients } from './themeTypes';

// Build all themes from compact palettes
const allThemes = ALL_PALETTES.map(buildTheme);

// Export individual themes for direct import
export const darkTheme = allThemes.find(t => t.id === 'dark')!;
export const lightTheme = allThemes.find(t => t.id === 'light')!;
export const midnightBlueTheme = allThemes.find(t => t.id === 'midnight-blue')!;
export const vscodeHighContrastTheme = allThemes.find(t => t.id === 'vscode-high-contrast')!;
export const professionalTheme = allThemes.find(t => t.id === 'professional')!;
export const slateSignalTheme = allThemes.find(t => t.id === 'slate-signal')!;
export const catppuccinMochaTheme = allThemes.find(t => t.id === 'catppuccin-mocha')!;
export const draculaTheme = allThemes.find(t => t.id === 'dracula')!;
export const nordTheme = allThemes.find(t => t.id === 'nord')!;
export const tokyoNightTheme = allThemes.find(t => t.id === 'tokyo-night')!;
export const forestTheme = allThemes.find(t => t.id === 'forest')!;
export const emberTheme = allThemes.find(t => t.id === 'ember')!;
export const paperDawnTheme = allThemes.find(t => t.id === 'paper-dawn')!;
export const graphiteLimeTheme = allThemes.find(t => t.id === 'graphite-lime')!;

// Registry for lookup
export const THEMES: Record<string, Theme> = Object.fromEntries(
	allThemes.map(t => [t.id, t])
);

// Default theme: Nebula Cosmic
export const DEFAULT_THEME = darkTheme;

// Get theme by ID
export function getThemeById(id: string): Theme {
	return THEMES[id] || DEFAULT_THEME;
}

export type { Theme, ThemeColors, ThemeGradients } from './themeTypes';
