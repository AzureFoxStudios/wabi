/**
 * Theme Types
 * TypeScript type definitions for theme system
 */

export interface CustomTheme {
	colors?: {
		bgPrimary?: string;
		bgSecondary?: string;
		bgTertiary?: string;
		bgHover?: string;
		textPrimary?: string;
		textSecondary?: string;
		textTertiary?: string;
		accent?: string;
		accentHex?: string;
		accentHover?: string;
		[key: string]: string | undefined;
	};
	gradients?: {
		primary?: string;
		accent?: string;
		accentHover?: string;
		[key: string]: string | undefined;
	};
	[key: string]: any;
}

export interface ThemePreferences {
	theme_id: string;
	custom_theme?: CustomTheme | null;
	updated_at?: number;
}
