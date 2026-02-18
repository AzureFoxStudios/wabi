/**
 * Theme Types
 * TypeScript type definitions for theme system
 */

export interface BackgroundImage {
	url: string;
	opacity?: number;
	blur?: number;
	size?: 'cover' | 'contain' | 'auto';
	position?: string;
	repeat?: 'no-repeat' | 'repeat' | 'repeat-x' | 'repeat-y';
	blend?: string;
}

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
	backgroundImage?: BackgroundImage;
	[key: string]: any;
}

export interface ThemePreferences {
	theme_id: string;
	custom_theme?: CustomTheme | null;
	uniform_font_enabled?: 0 | 1;
	uniform_font_family?: string;
	uniform_font_size?: string;
	uniform_font_weight?: string;
	uniform_font_style?: string;
	updated_at?: number;
}
