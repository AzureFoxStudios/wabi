/**
 * Theme Type Definitions
 * Shared types for the theme system
 */

export interface ThemeColors {
	// Background colors
	bgPrimary: string;
	bgSecondary: string;
	bgTertiary: string;
	bgHover: string;

	// Background RGB variants (for opacity usage)
	bgPrimaryRgb: string;
	bgSecondaryRgb: string;
	bgTertiaryRgb: string;

	// Text colors
	textPrimary: string;
	textSecondary: string;
	textTertiary: string;

	// Text RGB variants
	textPrimaryRgb: string;
	textSecondaryRgb: string;
	textTertiaryRgb: string;

	// Text inverse (for dark-on-light themes)
	textInverseRgb: string;
	textMutedRgb: string;

	// Accent colors
	accent: string;            // Gradient string for backgrounds
	accentHex: string;         // Solid color of accent (palette.accent)
	accentSecondaryHex: string;// Solid color of secondary accent (palette.accentSecondary)
	accentRgb: string;
	accentHover: string;

	// UI colors
	uiBgLight: string;
	uiBgLighter: string;
	uiText: string;
	uiTextDark: string;

	// Status colors
	statusOnline: string;
	statusAway: string;
	statusBusy: string;
	statusOffline: string;

	// Semantic colors
	colorSuccess: string;
	colorInfo: string;
	colorWarning: string;
	colorDanger: string;

	// Semantic color RGB variants
	colorSuccessRgb: string;
	colorInfoRgb: string;
	colorWarningRgb: string;
	colorDangerRgb: string;

	// Modal colors
	modalBg: string;
	modalHeaderBg: string;
	modalText: string;
	modalOverlay: string;
	modalBorder: string;

	// Dark mode variants
	darkBgPrimary: string;
	darkBgSecondary: string;

	// Error state
	error: string;

	// Border color
	border: string;
	borderRgb: string;
}

export interface ThemeGradients {
	primary: string;
	accent: string;
	accentHover: string;
	dialogDark: string;
	fadeBottomDark: string;
	fadeRightTransparent: string;
	lineGlow: string;
	fadeTopDark: string;
	accentSubtle: string;
	accentMedium: string;
	scrollbar: string;
	scrollbarHover: string;
	loadingDark: string;
}

export interface AmbientConfig {
	effect: string;
	color?: string;
	/** Secondary effect color (used by multi-color effects like Balatro). */
	color2?: string;
	/** Tertiary effect color (used by multi-color effects like Balatro). */
	color3?: string;
	intensity?: number;
	size?: number;
	speed?: number;
	/** Surface translucency so the ambient canvas blends through (0..1). Default 0.85. */
	frostOpacity?: number;
	/** Backdrop blur radius in px applied to surfaces. Default 12. */
	frostBlur?: number;
}

export interface Theme {
	id: string;
	name: string;
	description: string;
	colors: ThemeColors;
	gradients: ThemeGradients;
	ambient?: AmbientConfig;
}
