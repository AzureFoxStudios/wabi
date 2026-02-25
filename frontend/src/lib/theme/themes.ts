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

	// Accent colors
	accent: string;
	accentHex: string;
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

export interface Theme {
	id: string;
	name: string;
	description: string;
	colors: ThemeColors;
	gradients: ThemeGradients;
}

// ===== DARK THEME (Nebula Cosmic - Default) =====
export const darkTheme: Theme = {
	id: 'dark',
	name: 'Nebula Cosmic',
	description: 'Vibrant space-inspired theme with magenta accents. Perfect for creative, late-night sessions.',
	colors: {
		bgPrimary: 'linear-gradient(to right, #0f0c29 0%, #302b63 100%)',
		bgSecondary: '#1a1a2e',
		bgTertiary: '#24243e',
		bgHover: '#302b63',

		bgPrimaryRgb: '15, 12, 41',
		bgSecondaryRgb: '26, 26, 46',
		bgTertiaryRgb: '36, 36, 62',

		textPrimary: '#e0e0ff',
		textSecondary: '#b3b3ff',
		textTertiary: '#9999ff',

		textPrimaryRgb: '224, 224, 255',
		textSecondaryRgb: '179, 179, 255',
		textTertiaryRgb: '153, 153, 255',

		accent: 'linear-gradient(to right, #ff00ff 0%, #ff69b4 100%)',
		accentHex: '#ff00ff',
		accentRgb: '255, 0, 255',
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
		modalOverlay: 'rgba(0, 0, 0, 0.6)',
		modalBorder: 'rgba(255, 0, 255, 0.1)',

		darkBgPrimary: '#000000',
		darkBgSecondary: '#0f0c29',

		error: '#ff1493',

		border: '#302b63',
		borderRgb: '48, 43, 99'
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
	description: 'Clean and bright with soft purple accents. Great for daytime use.',
	colors: {
		bgPrimary: 'linear-gradient(to right, #f0f0f5 0%, #e8e8f0 100%)',
		bgSecondary: '#ffffff',
		bgTertiary: '#f5f5f8',
		bgHover: '#e8e8f0',

		bgPrimaryRgb: '240, 240, 245',
		bgSecondaryRgb: '255, 255, 255',
		bgTertiaryRgb: '245, 245, 248',

		textPrimary: '#000000',
		textSecondary: '#2a2a4a',
		textTertiary: '#4a4a6a',

		textPrimaryRgb: '0, 0, 0',
		textSecondaryRgb: '42, 42, 74',
		textTertiaryRgb: '74, 74, 106',

		accent: 'linear-gradient(to right, #6200ea 0%, #7c4dff 100%)',
		accentHex: '#6200ea',
		accentRgb: '98, 0, 234',
		accentHover: 'linear-gradient(to right, #7c4dff 0%, #9575ff 100%)',

		uiBgLight: '#e8e8f0',
		uiBgLighter: '#f5f5f8',
		uiText: '#2a2a4a',
		uiTextDark: '#000000',

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
		modalText: '#000000',
		modalOverlay: 'rgba(0, 0, 0, 0.4)',
		modalBorder: 'rgba(98, 0, 234, 0.1)',

		darkBgPrimary: '#f0f0f5',
		darkBgSecondary: '#ffffff',

		error: '#d32f2f',

		border: '#e8e8f0',
		borderRgb: '232, 232, 240'
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
	description: 'Deep ocean blues with cyan highlights. Professional and calming.',
	colors: {
		bgPrimary: 'linear-gradient(to right, #0a1929 0%, #1a2332 100%)',
		bgSecondary: '#0d1b2a',
		bgTertiary: '#1b263b',
		bgHover: '#1a2332',

		bgPrimaryRgb: '10, 25, 41',
		bgSecondaryRgb: '13, 27, 42',
		bgTertiaryRgb: '27, 38, 59',

		textPrimary: '#e0f2fe',
		textSecondary: '#bae6fd',
		textTertiary: '#7dd3fc',

		textPrimaryRgb: '224, 242, 254',
		textSecondaryRgb: '186, 230, 253',
		textTertiaryRgb: '125, 211, 252',

		accent: 'linear-gradient(to right, #06b6d4 0%, #0ea5e9 100%)',
		accentHex: '#06b6d4',
		accentRgb: '6, 182, 212',
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
		modalOverlay: 'rgba(0, 0, 0, 0.6)',
		modalBorder: 'rgba(6, 182, 212, 0.1)',

		darkBgPrimary: '#000000',
		darkBgSecondary: '#0a1929',

		error: '#ef4444',

		border: '#1a2332',
		borderRgb: '26, 35, 50'
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
	description: 'Pure black with electric blue accents. Maximum contrast for accessibility.',
	colors: {
		bgPrimary: '#000000',
		bgSecondary: '#0a0a0a',
		bgTertiary: '#000000',
		bgHover: '#1a1a1a',

		bgPrimaryRgb: '0, 0, 0',
		bgSecondaryRgb: '10, 10, 10',
		bgTertiaryRgb: '0, 0, 0',

		textPrimary: '#ffffff',
		textSecondary: '#d0d0d0',
		textTertiary: '#a0a0a0',

		textPrimaryRgb: '255, 255, 255',
		textSecondaryRgb: '208, 208, 208',
		textTertiaryRgb: '160, 160, 160',

		accent: '#00bfff',
		accentHex: '#00bfff',
		accentRgb: '0, 191, 255',
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
		modalOverlay: 'rgba(0, 0, 0, 0.8)',
		modalBorder: 'rgba(0, 191, 255, 0.2)',

		darkBgPrimary: '#000000',
		darkBgSecondary: '#0a0a0a',

		error: '#ff3333',

		border: '#1a1a1a',
		borderRgb: '26, 26, 26'
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

// ===== PROFESSIONAL THEME (Clean, minimal, high-contrast) =====
export const professionalTheme: Theme = {
	id: 'professional',
	name: 'Professional',
	description: 'Clean, minimal design for focused work. High contrast and professional aesthetic.',
	colors: {
		bgPrimary: '#f5f5f5',
		bgSecondary: '#ffffff',
		bgTertiary: '#f0f0f0',
		bgHover: '#e8e8e8',

		bgPrimaryRgb: '245, 245, 245',
		bgSecondaryRgb: '255, 255, 255',
		bgTertiaryRgb: '240, 240, 240',

		textPrimary: '#111111',
		textSecondary: '#374151',
		textTertiary: '#6b7280',

		textPrimaryRgb: '17, 17, 17',
		textSecondaryRgb: '55, 65, 81',
		textTertiaryRgb: '107, 114, 128',

		accent: '#4f46e5',
		accentHex: '#4f46e5',
		accentRgb: '79, 70, 229',
		accentHover: '#4338ca',

		uiBgLight: '#e8e8e8',
		uiBgLighter: '#f0f0f0',
		uiText: '#374151',
		uiTextDark: '#111111',

		statusOnline: '#059669',
		statusAway: '#d97706',
		statusBusy: '#dc2626',
		statusOffline: '#6b7280',

		colorSuccess: '#059669',
		colorInfo: '#0284c7',
		colorWarning: '#d97706',
		colorDanger: '#dc2626',

		modalBg: '#ffffff',
		modalHeaderBg: '#f0f0f0',
		modalText: '#111111',
		modalOverlay: 'rgba(0, 0, 0, 0.4)',
		modalBorder: 'rgba(79, 70, 229, 0.1)',

		darkBgPrimary: '#f5f5f5',
		darkBgSecondary: '#ffffff',

		error: '#dc2626',

		border: '#e0e0e0',
		borderRgb: '224, 224, 224'
	},
	gradients: {
		primary: '#f5f5f5',
		accent: '#4f46e5',
		accentHover: '#4338ca',
		dialogDark: 'linear-gradient(135deg, #ffffff 0%, #f0f0f0 100%)',
		fadeBottomDark: 'linear-gradient(to bottom, rgba(240, 240, 240, 0.8), rgba(255, 255, 255, 0.6))',
		fadeRightTransparent: 'linear-gradient(to right, transparent, #ffffff)',
		lineGlow: 'linear-gradient(90deg, transparent, rgba(79, 70, 229, 0.1), transparent)',
		fadeTopDark: 'linear-gradient(to top, rgba(0, 0, 0, 0.1), transparent)',
		accentSubtle: 'linear-gradient(135deg, rgba(79, 70, 229, 0.1) 0%, rgba(59, 130, 246, 0.1) 100%)',
		accentMedium: 'linear-gradient(135deg, rgba(79, 70, 229, 0.2) 0%, rgba(59, 130, 246, 0.2) 100%)',
		scrollbar: '#4f46e5',
		scrollbarHover: '#4338ca',
		loadingDark: 'linear-gradient(135deg, #f5f5f5 0%, #ffffff 100%)'
	}
};

// ===== CATPPUCCIN MOCHA THEME =====
export const catppuccinMochaTheme: Theme = {
	id: 'catppuccin-mocha',
	name: 'Catppuccin Mocha',
	description: 'Soothing dark pastel palette. One of the most popular Discord themes ever made.',
	colors: {
		bgPrimary: 'linear-gradient(to right, #181825 0%, #1e1e2e 100%)',
		bgSecondary: '#181825',
		bgTertiary: '#313244',
		bgHover: '#45475a',

		bgPrimaryRgb: '24, 24, 37',
		bgSecondaryRgb: '24, 24, 37',
		bgTertiaryRgb: '49, 50, 68',

		textPrimary: '#cdd6f4',
		textSecondary: '#bac2de',
		textTertiary: '#a6adc8',

		textPrimaryRgb: '205, 214, 244',
		textSecondaryRgb: '186, 194, 222',
		textTertiaryRgb: '166, 173, 200',

		accent: 'linear-gradient(to right, #cba6f7 0%, #b4befe 100%)',
		accentHex: '#cba6f7',
		accentRgb: '203, 166, 247',
		accentHover: 'linear-gradient(to right, #b4befe 0%, #cba6f7 100%)',

		uiBgLight: '#45475a',
		uiBgLighter: '#313244',
		uiText: '#bac2de',
		uiTextDark: '#cdd6f4',

		statusOnline: '#a6e3a1',
		statusAway: '#f9e2af',
		statusBusy: '#f38ba8',
		statusOffline: '#6c7086',

		colorSuccess: '#a6e3a1',
		colorInfo: '#89dceb',
		colorWarning: '#f9e2af',
		colorDanger: '#f38ba8',

		modalBg: '#181825',
		modalHeaderBg: '#313244',
		modalText: '#cdd6f4',
		modalOverlay: 'rgba(0, 0, 0, 0.6)',
		modalBorder: 'rgba(203, 166, 247, 0.15)',

		darkBgPrimary: '#11111b',
		darkBgSecondary: '#181825',

		error: '#f38ba8',

		border: '#45475a',
		borderRgb: '69, 71, 90'
	},
	gradients: {
		primary: 'linear-gradient(to right, #181825 0%, #1e1e2e 100%)',
		accent: 'linear-gradient(to right, #cba6f7 0%, #b4befe 100%)',
		accentHover: 'linear-gradient(to right, #b4befe 0%, #cba6f7 100%)',
		dialogDark: 'linear-gradient(135deg, #181825 0%, #313244 100%)',
		fadeBottomDark: 'linear-gradient(to bottom, rgba(49, 50, 68, 0.8), rgba(24, 24, 37, 0.6))',
		fadeRightTransparent: 'linear-gradient(to right, transparent, #181825)',
		lineGlow: 'linear-gradient(90deg, transparent, rgba(203, 166, 247, 0.1), transparent)',
		fadeTopDark: 'linear-gradient(to top, rgba(0, 0, 0, 0.8), transparent)',
		accentSubtle: 'linear-gradient(135deg, rgba(203, 166, 247, 0.1) 0%, rgba(180, 190, 254, 0.1) 100%)',
		accentMedium: 'linear-gradient(135deg, rgba(203, 166, 247, 0.25) 0%, rgba(180, 190, 254, 0.25) 100%)',
		scrollbar: 'linear-gradient(to bottom, #cba6f7 0%, #b4befe 100%)',
		scrollbarHover: 'linear-gradient(to bottom, #b4befe 0%, #cba6f7 100%)',
		loadingDark: 'linear-gradient(135deg, #11111b 0%, #1e1e2e 100%)'
	}
};

// ===== DRACULA THEME =====
export const draculaTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	description: 'The iconic dark theme. Deep purple-gray with vampire pink and vivid neon greens.',
	colors: {
		bgPrimary: 'linear-gradient(to right, #21222c 0%, #282a36 100%)',
		bgSecondary: '#21222c',
		bgTertiary: '#343746',
		bgHover: '#44475a',

		bgPrimaryRgb: '33, 34, 44',
		bgSecondaryRgb: '33, 34, 44',
		bgTertiaryRgb: '52, 55, 70',

		textPrimary: '#f8f8f2',
		textSecondary: '#cfcfcf',
		textTertiary: '#9999a0',

		textPrimaryRgb: '248, 248, 242',
		textSecondaryRgb: '207, 207, 207',
		textTertiaryRgb: '153, 153, 160',

		accent: 'linear-gradient(to right, #bd93f9 0%, #ff79c6 100%)',
		accentHex: '#bd93f9',
		accentRgb: '189, 147, 249',
		accentHover: 'linear-gradient(to right, #ff79c6 0%, #ff92d0 100%)',

		uiBgLight: '#44475a',
		uiBgLighter: '#343746',
		uiText: '#cfcfcf',
		uiTextDark: '#f8f8f2',

		statusOnline: '#50fa7b',
		statusAway: '#f1fa8c',
		statusBusy: '#ff5555',
		statusOffline: '#6272a4',

		colorSuccess: '#50fa7b',
		colorInfo: '#8be9fd',
		colorWarning: '#f1fa8c',
		colorDanger: '#ff5555',

		modalBg: '#21222c',
		modalHeaderBg: '#343746',
		modalText: '#f8f8f2',
		modalOverlay: 'rgba(0, 0, 0, 0.65)',
		modalBorder: 'rgba(189, 147, 249, 0.15)',

		darkBgPrimary: '#191a21',
		darkBgSecondary: '#21222c',

		error: '#ff5555',

		border: '#44475a',
		borderRgb: '68, 71, 90'
	},
	gradients: {
		primary: 'linear-gradient(to right, #21222c 0%, #282a36 100%)',
		accent: 'linear-gradient(to right, #bd93f9 0%, #ff79c6 100%)',
		accentHover: 'linear-gradient(to right, #ff79c6 0%, #ff92d0 100%)',
		dialogDark: 'linear-gradient(135deg, #21222c 0%, #343746 100%)',
		fadeBottomDark: 'linear-gradient(to bottom, rgba(52, 55, 70, 0.8), rgba(33, 34, 44, 0.6))',
		fadeRightTransparent: 'linear-gradient(to right, transparent, #21222c)',
		lineGlow: 'linear-gradient(90deg, transparent, rgba(189, 147, 249, 0.1), transparent)',
		fadeTopDark: 'linear-gradient(to top, rgba(0, 0, 0, 0.8), transparent)',
		accentSubtle: 'linear-gradient(135deg, rgba(189, 147, 249, 0.1) 0%, rgba(255, 121, 198, 0.1) 100%)',
		accentMedium: 'linear-gradient(135deg, rgba(189, 147, 249, 0.25) 0%, rgba(255, 121, 198, 0.25) 100%)',
		scrollbar: 'linear-gradient(to bottom, #bd93f9 0%, #ff79c6 100%)',
		scrollbarHover: 'linear-gradient(to bottom, #ff79c6 0%, #ff92d0 100%)',
		loadingDark: 'linear-gradient(135deg, #191a21 0%, #282a36 100%)'
	}
};

// ===== NORD THEME =====
export const nordTheme: Theme = {
	id: 'nord',
	name: 'Nord',
	description: 'Arctic, north-bluish palette. Calm and clean with a Scandinavian feel.',
	colors: {
		bgPrimary: 'linear-gradient(to right, #242933 0%, #2e3440 100%)',
		bgSecondary: '#242933',
		bgTertiary: '#3b4252',
		bgHover: '#434c5e',

		bgPrimaryRgb: '36, 41, 51',
		bgSecondaryRgb: '36, 41, 51',
		bgTertiaryRgb: '59, 66, 82',

		textPrimary: '#eceff4',
		textSecondary: '#e5e9f0',
		textTertiary: '#d8dee9',

		textPrimaryRgb: '236, 239, 244',
		textSecondaryRgb: '229, 233, 240',
		textTertiaryRgb: '216, 222, 233',

		accent: 'linear-gradient(to right, #88c0d0 0%, #81a1c1 100%)',
		accentHex: '#88c0d0',
		accentRgb: '136, 192, 208',
		accentHover: 'linear-gradient(to right, #81a1c1 0%, #5e81ac 100%)',

		uiBgLight: '#434c5e',
		uiBgLighter: '#3b4252',
		uiText: '#e5e9f0',
		uiTextDark: '#eceff4',

		statusOnline: '#a3be8c',
		statusAway: '#ebcb8b',
		statusBusy: '#bf616a',
		statusOffline: '#4c566a',

		colorSuccess: '#a3be8c',
		colorInfo: '#88c0d0',
		colorWarning: '#ebcb8b',
		colorDanger: '#bf616a',

		modalBg: '#242933',
		modalHeaderBg: '#3b4252',
		modalText: '#eceff4',
		modalOverlay: 'rgba(0, 0, 0, 0.6)',
		modalBorder: 'rgba(136, 192, 208, 0.15)',

		darkBgPrimary: '#1a1f27',
		darkBgSecondary: '#242933',

		error: '#bf616a',

		border: '#434c5e',
		borderRgb: '67, 76, 94'
	},
	gradients: {
		primary: 'linear-gradient(to right, #242933 0%, #2e3440 100%)',
		accent: 'linear-gradient(to right, #88c0d0 0%, #81a1c1 100%)',
		accentHover: 'linear-gradient(to right, #81a1c1 0%, #5e81ac 100%)',
		dialogDark: 'linear-gradient(135deg, #242933 0%, #3b4252 100%)',
		fadeBottomDark: 'linear-gradient(to bottom, rgba(59, 66, 82, 0.8), rgba(36, 41, 51, 0.6))',
		fadeRightTransparent: 'linear-gradient(to right, transparent, #242933)',
		lineGlow: 'linear-gradient(90deg, transparent, rgba(136, 192, 208, 0.1), transparent)',
		fadeTopDark: 'linear-gradient(to top, rgba(0, 0, 0, 0.8), transparent)',
		accentSubtle: 'linear-gradient(135deg, rgba(136, 192, 208, 0.1) 0%, rgba(129, 161, 193, 0.1) 100%)',
		accentMedium: 'linear-gradient(135deg, rgba(136, 192, 208, 0.25) 0%, rgba(129, 161, 193, 0.25) 100%)',
		scrollbar: 'linear-gradient(to bottom, #88c0d0 0%, #81a1c1 100%)',
		scrollbarHover: 'linear-gradient(to bottom, #81a1c1 0%, #5e81ac 100%)',
		loadingDark: 'linear-gradient(135deg, #1a1f27 0%, #2e3440 100%)'
	}
};

// ===== TOKYO NIGHT THEME =====
export const tokyoNightTheme: Theme = {
	id: 'tokyo-night',
	name: 'Tokyo Night',
	description: 'City lights at midnight. Cool blues and lavenders with neon accents.',
	colors: {
		bgPrimary: 'linear-gradient(to right, #16161e 0%, #1a1b26 100%)',
		bgSecondary: '#16161e',
		bgTertiary: '#24283b',
		bgHover: '#2f3347',

		bgPrimaryRgb: '22, 22, 30',
		bgSecondaryRgb: '22, 22, 30',
		bgTertiaryRgb: '36, 40, 59',

		textPrimary: '#c0caf5',
		textSecondary: '#a9b1d6',
		textTertiary: '#787c99',

		textPrimaryRgb: '192, 202, 245',
		textSecondaryRgb: '169, 177, 214',
		textTertiaryRgb: '120, 124, 153',

		accent: 'linear-gradient(to right, #7aa2f7 0%, #bb9af7 100%)',
		accentHex: '#7aa2f7',
		accentRgb: '122, 162, 247',
		accentHover: 'linear-gradient(to right, #bb9af7 0%, #c678dd 100%)',

		uiBgLight: '#2f3347',
		uiBgLighter: '#24283b',
		uiText: '#a9b1d6',
		uiTextDark: '#c0caf5',

		statusOnline: '#9ece6a',
		statusAway: '#e0af68',
		statusBusy: '#f7768e',
		statusOffline: '#565f89',

		colorSuccess: '#9ece6a',
		colorInfo: '#7dcfff',
		colorWarning: '#e0af68',
		colorDanger: '#f7768e',

		modalBg: '#16161e',
		modalHeaderBg: '#24283b',
		modalText: '#c0caf5',
		modalOverlay: 'rgba(0, 0, 0, 0.65)',
		modalBorder: 'rgba(122, 162, 247, 0.15)',

		darkBgPrimary: '#0f0f14',
		darkBgSecondary: '#16161e',

		error: '#f7768e',

		border: '#2f3347',
		borderRgb: '47, 51, 71'
	},
	gradients: {
		primary: 'linear-gradient(to right, #16161e 0%, #1a1b26 100%)',
		accent: 'linear-gradient(to right, #7aa2f7 0%, #bb9af7 100%)',
		accentHover: 'linear-gradient(to right, #bb9af7 0%, #c678dd 100%)',
		dialogDark: 'linear-gradient(135deg, #16161e 0%, #24283b 100%)',
		fadeBottomDark: 'linear-gradient(to bottom, rgba(36, 40, 59, 0.8), rgba(22, 22, 30, 0.6))',
		fadeRightTransparent: 'linear-gradient(to right, transparent, #16161e)',
		lineGlow: 'linear-gradient(90deg, transparent, rgba(122, 162, 247, 0.1), transparent)',
		fadeTopDark: 'linear-gradient(to top, rgba(0, 0, 0, 0.8), transparent)',
		accentSubtle: 'linear-gradient(135deg, rgba(122, 162, 247, 0.1) 0%, rgba(187, 154, 247, 0.1) 100%)',
		accentMedium: 'linear-gradient(135deg, rgba(122, 162, 247, 0.25) 0%, rgba(187, 154, 247, 0.25) 100%)',
		scrollbar: 'linear-gradient(to bottom, #7aa2f7 0%, #bb9af7 100%)',
		scrollbarHover: 'linear-gradient(to bottom, #bb9af7 0%, #c678dd 100%)',
		loadingDark: 'linear-gradient(135deg, #0f0f14 0%, #1a1b26 100%)'
	}
};

// ===== FOREST THEME (Green Gradient) =====
export const forestTheme: Theme = {
	id: 'forest',
	name: 'Forest',
	description: 'Lush emerald greens with a deep woodland gradient. Natural and grounding.',
	colors: {
		bgPrimary: 'linear-gradient(to right, #0a1a0a 0%, #0f2a18 100%)',
		bgSecondary: '#0d1f0d',
		bgTertiary: '#162616',
		bgHover: '#1e3320',

		bgPrimaryRgb: '10, 26, 10',
		bgSecondaryRgb: '13, 31, 13',
		bgTertiaryRgb: '22, 38, 22',

		textPrimary: '#f0faf2',
		textSecondary: '#c8e6cc',
		textTertiary: '#96d4a0',

		textPrimaryRgb: '240, 250, 242',
		textSecondaryRgb: '200, 230, 204',
		textTertiaryRgb: '150, 212, 160',

		accent: 'linear-gradient(to right, #2ecc71 0%, #1abc9c 100%)',
		accentHex: '#2ecc71',
		accentRgb: '46, 204, 113',
		accentHover: 'linear-gradient(to right, #1abc9c 0%, #27ae60 100%)',

		uiBgLight: '#1e3320',
		uiBgLighter: '#162616',
		uiText: '#a7d7b0',
		uiTextDark: '#d4edda',

		statusOnline: '#2ecc71',
		statusAway: '#f39c12',
		statusBusy: '#e74c3c',
		statusOffline: '#55776a',

		colorSuccess: '#2ecc71',
		colorInfo: '#1abc9c',
		colorWarning: '#f39c12',
		colorDanger: '#e74c3c',

		modalBg: '#0a1a0a',
		modalHeaderBg: '#162616',
		modalText: '#d4edda',
		modalOverlay: 'rgba(0, 0, 0, 0.65)',
		modalBorder: 'rgba(46, 204, 113, 0.15)',

		darkBgPrimary: '#050e05',
		darkBgSecondary: '#0a1a0a',

		error: '#e74c3c',

		border: '#1e3320',
		borderRgb: '30, 51, 32'
	},
	gradients: {
		primary: 'linear-gradient(to right, #0a1a0a 0%, #0f2a18 100%)',
		accent: 'linear-gradient(to right, #2ecc71 0%, #1abc9c 100%)',
		accentHover: 'linear-gradient(to right, #1abc9c 0%, #27ae60 100%)',
		dialogDark: 'linear-gradient(135deg, #0d1f0d 0%, #162616 100%)',
		fadeBottomDark: 'linear-gradient(to bottom, rgba(22, 38, 22, 0.8), rgba(13, 31, 13, 0.6))',
		fadeRightTransparent: 'linear-gradient(to right, transparent, #0d1f0d)',
		lineGlow: 'linear-gradient(90deg, transparent, rgba(46, 204, 113, 0.1), transparent)',
		fadeTopDark: 'linear-gradient(to top, rgba(0, 0, 0, 0.8), transparent)',
		accentSubtle: 'linear-gradient(135deg, rgba(46, 204, 113, 0.1) 0%, rgba(26, 188, 156, 0.1) 100%)',
		accentMedium: 'linear-gradient(135deg, rgba(46, 204, 113, 0.25) 0%, rgba(26, 188, 156, 0.25) 100%)',
		scrollbar: 'linear-gradient(to bottom, #2ecc71 0%, #1abc9c 100%)',
		scrollbarHover: 'linear-gradient(to bottom, #1abc9c 0%, #27ae60 100%)',
		loadingDark: 'linear-gradient(135deg, #050e05 0%, #0f2a18 100%)'
	}
};

// ===== EMBER THEME (Warm sunset/orange gradient) =====
export const emberTheme: Theme = {
	id: 'ember',
	name: 'Ember',
	description: 'Warm sunset tones. Fiery orange and amber for a cozy, glowing vibe.',
	colors: {
		bgPrimary: 'linear-gradient(to right, #1a0a00 0%, #2a1200 100%)',
		bgSecondary: '#1f0f00',
		bgTertiary: '#2d1800',
		bgHover: '#3d2200',

		bgPrimaryRgb: '26, 10, 0',
		bgSecondaryRgb: '31, 15, 0',
		bgTertiaryRgb: '45, 24, 0',

		textPrimary: '#fde8cc',
		textSecondary: '#f5c98a',
		textTertiary: '#d4924c',

		textPrimaryRgb: '253, 232, 204',
		textSecondaryRgb: '245, 201, 138',
		textTertiaryRgb: '212, 146, 76',

		accent: 'linear-gradient(to right, #f97316 0%, #fb923c 100%)',
		accentHex: '#f97316',
		accentRgb: '249, 115, 22',
		accentHover: 'linear-gradient(to right, #ea6c0c 0%, #f97316 100%)',

		uiBgLight: '#3d2200',
		uiBgLighter: '#2d1800',
		uiText: '#f5c98a',
		uiTextDark: '#fde8cc',

		statusOnline: '#4ade80',
		statusAway: '#fbbf24',
		statusBusy: '#ef4444',
		statusOffline: '#78716c',

		colorSuccess: '#4ade80',
		colorInfo: '#60a5fa',
		colorWarning: '#fbbf24',
		colorDanger: '#ef4444',

		modalBg: '#1a0a00',
		modalHeaderBg: '#2d1800',
		modalText: '#fde8cc',
		modalOverlay: 'rgba(0, 0, 0, 0.65)',
		modalBorder: 'rgba(249, 115, 22, 0.15)',

		darkBgPrimary: '#100500',
		darkBgSecondary: '#1a0a00',

		error: '#ef4444',

		border: '#3d2200',
		borderRgb: '61, 34, 0'
	},
	gradients: {
		primary: 'linear-gradient(to right, #1a0a00 0%, #2a1200 100%)',
		accent: 'linear-gradient(to right, #f97316 0%, #fb923c 100%)',
		accentHover: 'linear-gradient(to right, #ea6c0c 0%, #f97316 100%)',
		dialogDark: 'linear-gradient(135deg, #1f0f00 0%, #2d1800 100%)',
		fadeBottomDark: 'linear-gradient(to bottom, rgba(45, 24, 0, 0.8), rgba(31, 15, 0, 0.6))',
		fadeRightTransparent: 'linear-gradient(to right, transparent, #1f0f00)',
		lineGlow: 'linear-gradient(90deg, transparent, rgba(249, 115, 22, 0.1), transparent)',
		fadeTopDark: 'linear-gradient(to top, rgba(0, 0, 0, 0.8), transparent)',
		accentSubtle: 'linear-gradient(135deg, rgba(249, 115, 22, 0.1) 0%, rgba(251, 146, 60, 0.1) 100%)',
		accentMedium: 'linear-gradient(135deg, rgba(249, 115, 22, 0.25) 0%, rgba(251, 146, 60, 0.25) 100%)',
		scrollbar: 'linear-gradient(to bottom, #f97316 0%, #fb923c 100%)',
		scrollbarHover: 'linear-gradient(to bottom, #ea6c0c 0%, #f97316 100%)',
		loadingDark: 'linear-gradient(135deg, #100500 0%, #2a1200 100%)'
	}
};

// ===== ALL THEMES REGISTRY =====
export const THEMES: Record<string, Theme> = {
	dark: darkTheme,
	light: lightTheme,
	'midnight-blue': midnightBlueTheme,
	'vscode-high-contrast': vscodeHighContrastTheme,
	professional: professionalTheme,
	'catppuccin-mocha': catppuccinMochaTheme,
	dracula: draculaTheme,
	nord: nordTheme,
	'tokyo-night': tokyoNightTheme,
	forest: forestTheme,
	ember: emberTheme
};

// Default theme: Nebula Cosmic (darkTheme)
export const DEFAULT_THEME = darkTheme;

// Get theme by ID
export function getThemeById(id: string): Theme {
	return THEMES[id] || DEFAULT_THEME;
}
