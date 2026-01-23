/**
 * Theme Definitions
 * Predefined theme configurations for Wabi
 */

export interface ThemeColors {
	// Background colors
	bgPrimary: string;
	bgSecondary: string;
	bgTertiary: string;
	bgHover: string;

	// Text colors
	textPrimary: string;
	textSecondary: string;
	textTertiary: string;

	// Accent colors
	accent: string;
	accentHex: string;
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

	// Modal colors
	modalBg: string;
	modalHeaderBg: string;
	modalText: string;

	// Dark mode variants
	darkBgPrimary: string;
	darkBgSecondary: string;

	// Error state
	error: string;
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

export interface Theme {
	id: string;
	name: string;
	description: string;
	colors: ThemeColors;
	gradients: ThemeGradients;
}

// ===== DARK THEME (Current Nebula Cosmic) =====
export const darkTheme: Theme = {
	id: 'dark',
	name: 'Dark (Nebula Cosmic)',
	description: 'Deep space purple with starry accents',
	colors: {
		bgPrimary: 'linear-gradient(to right, #0f0c29 0%, #302b63 100%)',
		bgSecondary: '#1a1a2e',
		bgTertiary: '#24243e',
		bgHover: '#302b63',

		textPrimary: '#e0e0ff',
		textSecondary: '#b3b3ff',
		textTertiary: '#9999ff',

		accent: 'linear-gradient(to right, #ff00ff 0%, #ff69b4 100%)',
		accentHex: '#ff00ff',
		accentHover: 'linear-gradient(to right, #ff69b4 0%, #ff1493 100%)',

		uiBgLight: '#302b63',
		uiBgLighter: '#24243e',
		uiText: '#b3b3ff',
		uiTextDark: '#e0e0ff',

		statusOnline: '#00ff7f',
		statusAway: '#ffd700',
		statusBusy: '#ff0000',
		statusOffline: '#708090',

		colorSuccess: '#00ff7f',
		colorInfo: '#00bfff',
		colorWarning: '#ffd700',
		colorDanger: '#ff0000',

		modalBg: '#0f0c29',
		modalHeaderBg: '#24243e',
		modalText: '#e0e0ff',

		darkBgPrimary: '#000000',
		darkBgSecondary: '#0f0c29',

		error: '#ff1493'
	},
	gradients: {
		primary: 'linear-gradient(to right, #0f0c29 0%, #302b63 100%)',
		accent: 'linear-gradient(to right, #ff00ff 0%, #ff69b4 100%)',
		accentHover: 'linear-gradient(to right, #ff69b4 0%, #ff1493 100%)',
		dialogDark: 'linear-gradient(135deg, #1a1535 0%, #2a2050 100%)',
		fadeBottomDark: 'linear-gradient(to bottom, rgba(36, 36, 62, 0.8), rgba(26, 26, 46, 0.6))',
		fadeRightTransparent: 'linear-gradient(to right, transparent, #1a1a2e)',
		lineGlow: 'linear-gradient(90deg, transparent, rgba(123, 104, 238, 0.1), transparent)',
		fadeTopDark: 'linear-gradient(to top, rgba(0, 0, 0, 0.8), transparent)',
		accentSubtle: 'linear-gradient(135deg, rgba(255, 0, 255, 0.1) 0%, rgba(255, 105, 180, 0.1) 100%)',
		accentMedium: 'linear-gradient(135deg, rgba(255, 0, 255, 0.25) 0%, rgba(255, 105, 180, 0.25) 100%)',
		scrollbar: 'linear-gradient(to bottom, #7b68ee 0%, #9370db 100%)',
		scrollbarHover: 'linear-gradient(to bottom, #9370db 0%, #8a2be2 100%)',
		loadingDark: 'linear-gradient(135deg, #000000 0%, #0f0c29 100%)'
	}
};

// ===== LIGHT THEME =====
export const lightTheme: Theme = {
	id: 'light',
	name: 'Light',
	description: 'Clean and bright with soft accents',
	colors: {
		bgPrimary: 'linear-gradient(to right, #f0f0f5 0%, #e8e8f0 100%)',
		bgSecondary: '#ffffff',
		bgTertiary: '#f5f5f8',
		bgHover: '#e8e8f0',

		textPrimary: '#1a1a2e',
		textSecondary: '#4a4a6a',
		textTertiary: '#6a6a8a',

		accent: 'linear-gradient(to right, #6200ea 0%, #7c4dff 100%)',
		accentHex: '#6200ea',
		accentHover: 'linear-gradient(to right, #7c4dff 0%, #9575ff 100%)',

		uiBgLight: '#e8e8f0',
		uiBgLighter: '#f5f5f8',
		uiText: '#4a4a6a',
		uiTextDark: '#1a1a2e',

		statusOnline: '#00c853',
		statusAway: '#ffa000',
		statusBusy: '#d32f2f',
		statusOffline: '#757575',

		colorSuccess: '#00c853',
		colorInfo: '#0091ea',
		colorWarning: '#ffa000',
		colorDanger: '#d32f2f',

		modalBg: '#ffffff',
		modalHeaderBg: '#f5f5f8',
		modalText: '#1a1a2e',

		darkBgPrimary: '#f0f0f5',
		darkBgSecondary: '#ffffff',

		error: '#d32f2f'
	},
	gradients: {
		primary: 'linear-gradient(to right, #f0f0f5 0%, #e8e8f0 100%)',
		accent: 'linear-gradient(to right, #6200ea 0%, #7c4dff 100%)',
		accentHover: 'linear-gradient(to right, #7c4dff 0%, #9575ff 100%)',
		dialogDark: 'linear-gradient(135deg, #ffffff 0%, #f5f5f8 100%)',
		fadeBottomDark: 'linear-gradient(to bottom, rgba(245, 245, 248, 0.8), rgba(255, 255, 255, 0.6))',
		fadeRightTransparent: 'linear-gradient(to right, transparent, #ffffff)',
		lineGlow: 'linear-gradient(90deg, transparent, rgba(98, 0, 234, 0.1), transparent)',
		fadeTopDark: 'linear-gradient(to top, rgba(0, 0, 0, 0.1), transparent)',
		accentSubtle: 'linear-gradient(135deg, rgba(98, 0, 234, 0.1) 0%, rgba(124, 77, 255, 0.1) 100%)',
		accentMedium: 'linear-gradient(135deg, rgba(98, 0, 234, 0.25) 0%, rgba(124, 77, 255, 0.25) 100%)',
		scrollbar: 'linear-gradient(to bottom, #7c4dff 0%, #6200ea 100%)',
		scrollbarHover: 'linear-gradient(to bottom, #9575ff 0%, #7c4dff 100%)',
		loadingDark: 'linear-gradient(135deg, #f0f0f5 0%, #ffffff 100%)'
	}
};

// ===== MIDNIGHT BLUE THEME =====
export const midnightBlueTheme: Theme = {
	id: 'midnight-blue',
	name: 'Midnight Blue',
	description: 'Deep ocean blues with cyan highlights',
	colors: {
		bgPrimary: 'linear-gradient(to right, #0a1929 0%, #1a2332 100%)',
		bgSecondary: '#0d1b2a',
		bgTertiary: '#1b263b',
		bgHover: '#1a2332',

		textPrimary: '#e0f2fe',
		textSecondary: '#bae6fd',
		textTertiary: '#7dd3fc',

		accent: 'linear-gradient(to right, #06b6d4 0%, #0ea5e9 100%)',
		accentHex: '#06b6d4',
		accentHover: 'linear-gradient(to right, #0ea5e9 0%, #38bdf8 100%)',

		uiBgLight: '#1a2332',
		uiBgLighter: '#1b263b',
		uiText: '#bae6fd',
		uiTextDark: '#e0f2fe',

		statusOnline: '#10b981',
		statusAway: '#f59e0b',
		statusBusy: '#ef4444',
		statusOffline: '#6b7280',

		colorSuccess: '#10b981',
		colorInfo: '#0ea5e9',
		colorWarning: '#f59e0b',
		colorDanger: '#ef4444',

		modalBg: '#0a1929',
		modalHeaderBg: '#1b263b',
		modalText: '#e0f2fe',

		darkBgPrimary: '#000000',
		darkBgSecondary: '#0a1929',

		error: '#ef4444'
	},
	gradients: {
		primary: 'linear-gradient(to right, #0a1929 0%, #1a2332 100%)',
		accent: 'linear-gradient(to right, #06b6d4 0%, #0ea5e9 100%)',
		accentHover: 'linear-gradient(to right, #0ea5e9 0%, #38bdf8 100%)',
		dialogDark: 'linear-gradient(135deg, #0d1b2a 0%, #1b263b 100%)',
		fadeBottomDark: 'linear-gradient(to bottom, rgba(27, 38, 59, 0.8), rgba(13, 27, 42, 0.6))',
		fadeRightTransparent: 'linear-gradient(to right, transparent, #0d1b2a)',
		lineGlow: 'linear-gradient(90deg, transparent, rgba(6, 182, 212, 0.1), transparent)',
		fadeTopDark: 'linear-gradient(to top, rgba(0, 0, 0, 0.8), transparent)',
		accentSubtle: 'linear-gradient(135deg, rgba(6, 182, 212, 0.1) 0%, rgba(14, 165, 233, 0.1) 100%)',
		accentMedium: 'linear-gradient(135deg, rgba(6, 182, 212, 0.25) 0%, rgba(14, 165, 233, 0.25) 100%)',
		scrollbar: 'linear-gradient(to bottom, #06b6d4 0%, #0ea5e9 100%)',
		scrollbarHover: 'linear-gradient(to bottom, #0ea5e9 0%, #38bdf8 100%)',
		loadingDark: 'linear-gradient(135deg, #000000 0%, #0a1929 100%)'
	}
};

// ===== VS CODE HIGH CONTRAST THEME =====
export const vscodeHighContrastTheme: Theme = {
	id: 'vscode-high-contrast',
	name: 'VS Code High Contrast',
	description: 'Pure black with electric blue accents and orange highlights',
	colors: {
		bgPrimary: '#000000',
		bgSecondary: '#0a0a0a',
		bgTertiary: '#000000',
		bgHover: '#1a1a1a',

		textPrimary: '#ffffff',
		textSecondary: '#d0d0d0',
		textTertiary: '#a0a0a0',

		accent: '#00bfff',
		accentHex: '0, 191, 255',
		accentHover: '#0099ff',

		uiBgLight: '#0a0a0a',
		uiBgLighter: '#1a1a1a',
		uiText: '#d0d0d0',
		uiTextDark: '#ffffff',

		statusOnline: '#00ff7f',
		statusAway: '#ffa500',
		statusBusy: '#ff3333',
		statusOffline: '#707070',

		colorSuccess: '#00ff7f',
		colorInfo: '#00bfff',
		colorWarning: '#ffa500',
		colorDanger: '#ff3333',

		modalBg: '#000000',
		modalHeaderBg: '#000000',
		modalText: '#ffffff',

		darkBgPrimary: '#000000',
		darkBgSecondary: '#0a0a0a',

		error: '#ff3333'
	},
	gradients: {
		primary: 'linear-gradient(to right, #000000 0%, #000000 100%)',
		accent: 'linear-gradient(to right, #00bfff 0%, #0099ff 100%)',
		accentHover: 'linear-gradient(to right, #0099ff 0%, #0077cc 100%)',
		dialogDark: 'linear-gradient(135deg, #000000 0%, #0a0a0a 100%)',
		fadeBottomDark: 'linear-gradient(to bottom, rgba(0, 0, 0, 0.95), rgba(0, 0, 0, 0.8))',
		fadeRightTransparent: 'linear-gradient(to right, transparent, #000000)',
		lineGlow: 'linear-gradient(90deg, transparent, rgba(0, 191, 255, 0.2), transparent)',
		fadeTopDark: 'linear-gradient(to top, rgba(0, 0, 0, 0.9), transparent)',
		accentSubtle: 'linear-gradient(135deg, rgba(0, 191, 255, 0.15) 0%, rgba(0, 153, 255, 0.15) 100%)',
		accentMedium: 'linear-gradient(135deg, rgba(0, 191, 255, 0.3) 0%, rgba(0, 153, 255, 0.3) 100%)',
		scrollbar: 'linear-gradient(to bottom, #00bfff 0%, #0099ff 100%)',
		scrollbarHover: 'linear-gradient(to bottom, #0099ff 0%, #0077cc 100%)',
		loadingDark: 'linear-gradient(135deg, #000000 0%, #0a0a0a 100%)'
	}
};

// ===== ALL THEMES REGISTRY =====
export const THEMES: Record<string, Theme> = {
	dark: darkTheme,
	light: lightTheme,
	'midnight-blue': midnightBlueTheme,
	'vscode-high-contrast': vscodeHighContrastTheme
};

// Default theme
export const DEFAULT_THEME = midnightBlueTheme;

// Get theme by ID
export function getThemeById(id: string): Theme {
	return THEMES[id] || DEFAULT_THEME;
}
