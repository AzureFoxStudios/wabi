/**
 * Token Derivation Engine
 * Converts a compact BasePalette into a full Theme object
 * Backward compatible with existing themeManager.ts and component CSS
 */

import type { Theme, ThemeColors, ThemeGradients, AmbientConfig } from './themeTypes';

// ============================================================================
// Base Palette Definition
// ============================================================================

export interface BasePalette {
	id: string;
	name: string;
	description: string;
	// Background surfaces
	bgBase: string;          // Main surface (was bgSecondary)
	bgRaised: string;        // Elevated surface (was bgTertiary)
	bgSunken: string;        // Deepest surface (was modalBg)
	bgPrimary?: string;      // Optional gradient override for bgPrimary
	// Text
	textPrimary: string;
	textSecondary: string;
	textMuted: string;
	// Accent
	accent: string;
	accentSecondary: string;
	// Status
	statusOnline: string;
	statusAway: string;
	statusBusy: string;
	statusOffline: string;
	// Semantic
	success: string;
	info: string;
	warning: string;
	danger: string;
	// Ambient effect config
	ambient?: AmbientConfig;
	// Special overrides (for themes that don't follow standard patterns)
	overrides?: { colors?: Partial<ThemeColors>; gradients?: Partial<ThemeGradients> };
}

// ============================================================================
// Color Utilities
// ============================================================================

function hexToRgb(hex: string): string {
	const clean = hex.replace('#', '');
	const r = parseInt(clean.substring(0, 2), 16);
	const g = parseInt(clean.substring(2, 4), 16);
	const b = parseInt(clean.substring(4, 6), 16);
	return `${r}, ${g}, ${b}`;
}

function rgbFromString(color: string): string {
	if (color.startsWith('#')) return hexToRgb(color);
	if (color.startsWith('rgba(')) {
		const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
		if (match) return `${match[1]}, ${match[2]}, ${match[3]}`;
	}
	if (color.startsWith('rgb(')) {
		const match = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
		if (match) return `${match[1]}, ${match[2]}, ${match[3]}`;
	}
	return '0, 0, 0';
}

function lighten(hex: string, amount: number): string {
	const clean = hex.replace('#', '');
	let r = parseInt(clean.substring(0, 2), 16);
	let g = parseInt(clean.substring(2, 4), 16);
	let b = parseInt(clean.substring(4, 6), 16);
	r = Math.min(255, Math.floor(r + (255 - r) * amount));
	g = Math.min(255, Math.floor(g + (255 - g) * amount));
	b = Math.min(255, Math.floor(b + (255 - b) * amount));
	const toHex = (n: number) => n.toString(16).padStart(2, '0');
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function darken(hex: string, amount: number): string {
	const clean = hex.replace('#', '');
	let r = parseInt(clean.substring(0, 2), 16);
	let g = parseInt(clean.substring(2, 4), 16);
	let b = parseInt(clean.substring(4, 6), 16);
	r = Math.max(0, Math.floor(r * (1 - amount)));
	g = Math.max(0, Math.floor(g * (1 - amount)));
	b = Math.max(0, Math.floor(b * (1 - amount)));
	const toHex = (n: number) => n.toString(16).padStart(2, '0');
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function isDark(hex: string): boolean {
	const clean = hex.replace('#', '');
	const r = parseInt(clean.substring(0, 2), 16);
	const g = parseInt(clean.substring(2, 4), 16);
	const b = parseInt(clean.substring(4, 6), 16);
	const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return luminance < 0.5;
}

// ============================================================================
// Derivation Engine
// ============================================================================

export function buildTheme(palette: BasePalette): Theme {
	const isDarkTheme = isDark(palette.bgBase);
	const bgPrimary = palette.bgPrimary || `linear-gradient(to right, ${palette.bgSunken} 0%, ${palette.bgRaised} 100%)`;
	const bgSecondary = palette.bgBase;
	const bgTertiary = palette.bgRaised;
	const bgHover = isDarkTheme ? lighten(palette.bgBase, 0.15) : darken(palette.bgBase, 0.08);
	const accentHex = palette.accent.startsWith('#') ? palette.accent : palette.accentSecondary;
	const accentHover = isDarkTheme
		? `linear-gradient(to right, ${palette.accentSecondary} 0%, ${lighten(palette.accentSecondary, 0.15)} 100%)`
		: `linear-gradient(to right, ${palette.accentSecondary} 0%, ${darken(palette.accentSecondary, 0.1)} 100%)`;

	const colors: ThemeColors = {
		bgPrimary,
		bgSecondary,
		bgTertiary,
		bgHover,
		bgPrimaryRgb: rgbFromString(palette.bgSunken),
		bgSecondaryRgb: rgbFromString(palette.bgBase),
		bgTertiaryRgb: rgbFromString(palette.bgRaised),
		textPrimary: palette.textPrimary,
		textSecondary: palette.textSecondary,
		textTertiary: palette.textMuted,
		textPrimaryRgb: rgbFromString(palette.textPrimary),
		textSecondaryRgb: rgbFromString(palette.textSecondary),
		textTertiaryRgb: rgbFromString(palette.textMuted),
		textInverseRgb: isDarkTheme ? '255, 255, 255' : '0, 0, 0',
		textMutedRgb: rgbFromString(palette.textMuted),
		accent: `linear-gradient(to right, ${palette.accent} 0%, ${palette.accentSecondary} 100%)`,
		accentHex,
		accentSecondaryHex: palette.accentSecondary,
		accentRgb: rgbFromString(accentHex),
		accentHover,
		uiBgLight: palette.bgRaised,
		uiBgLighter: palette.bgBase,
		uiText: palette.textSecondary,
		uiTextDark: palette.textPrimary,
		statusOnline: palette.statusOnline,
		statusAway: palette.statusAway,
		statusBusy: palette.statusBusy,
		statusOffline: palette.statusOffline,
		colorSuccess: palette.success,
		colorInfo: palette.info,
		colorWarning: palette.warning,
		colorDanger: palette.danger,
		colorSuccessRgb: rgbFromString(palette.success),
		colorInfoRgb: rgbFromString(palette.info),
		colorWarningRgb: rgbFromString(palette.warning),
		colorDangerRgb: rgbFromString(palette.danger),
		modalBg: palette.bgSunken,
		modalHeaderBg: palette.bgRaised,
		modalText: palette.textPrimary,
		modalOverlay: isDarkTheme ? 'rgba(0, 0, 0, 0.6)' : 'rgba(0, 0, 0, 0.4)',
		modalBorder: `rgba(${rgbFromString(accentHex)}, 0.1)`,
		darkBgPrimary: isDarkTheme ? '#000000' : palette.bgBase,
		darkBgSecondary: isDarkTheme ? palette.bgSunken : palette.bgBase,
		error: palette.danger,
		border: palette.bgRaised,
		borderRgb: rgbFromString(palette.bgRaised),
	};

	const gradients: ThemeGradients = {
		primary: bgPrimary,
		accent: `linear-gradient(to right, ${palette.accent} 0%, ${palette.accentSecondary} 100%)`,
		accentHover,
		dialogDark: `linear-gradient(135deg, ${palette.bgBase} 0%, ${palette.bgRaised} 100%)`,
		fadeBottomDark: `linear-gradient(to bottom, rgba(${rgbFromString(palette.bgRaised)}, 0.8), rgba(${rgbFromString(palette.bgBase)}, 0.6))`,
		fadeRightTransparent: `linear-gradient(to right, transparent, ${palette.bgBase})`,
		lineGlow: `linear-gradient(90deg, transparent, rgba(${rgbFromString(palette.accentSecondary)}, 0.1), transparent)`,
		fadeTopDark: `linear-gradient(to top, rgba(0, 0, 0, ${isDarkTheme ? '0.8' : '0.1'}), transparent)`,
		accentSubtle: `linear-gradient(135deg, rgba(${rgbFromString(palette.accent)}, 0.1) 0%, rgba(${rgbFromString(palette.accentSecondary)}, 0.1) 100%)`,
		accentMedium: `linear-gradient(135deg, rgba(${rgbFromString(palette.accent)}, 0.25) 0%, rgba(${rgbFromString(palette.accentSecondary)}, 0.25) 100%)`,
		scrollbar: `linear-gradient(to bottom, ${palette.accent} 0%, ${palette.accentSecondary} 100%)`,
		scrollbarHover: `linear-gradient(to bottom, ${palette.accentSecondary} 0%, ${isDarkTheme ? lighten(palette.accentSecondary, 0.15) : darken(palette.accentSecondary, 0.1)} 100%)`,
		loadingDark: `linear-gradient(135deg, ${isDarkTheme ? '#000000' : palette.bgBase} 0%, ${palette.bgSunken} 100%)`,
	};

	// Apply overrides for themes that deviate from standard patterns
	if (palette.overrides) {
		Object.assign(colors, palette.overrides.colors || {});
		Object.assign(gradients, palette.overrides.gradients || {});
	}

	return {
		id: palette.id,
		name: palette.name,
		description: palette.description,
		colors,
		gradients,
		ambient: palette.ambient,
	};
}

// ============================================================================
// Convenience: Build all themes from palettes
// ============================================================================

export function buildAllThemes(palettes: BasePalette[]): Theme[] {
	return palettes.map(buildTheme);
}
