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

/**
 * Per-panel background/text override.
 * When `enabled` is false (or the override is absent) the panel falls back to
 * the active theme's default background and text tokens.
 */
export interface PanelColorOverride {
	enabled?: boolean;
	/** Whether `bg` is a solid color or a full CSS gradient string. */
	mode?: 'solid' | 'gradient';
	/** Solid hex color OR a gradient CSS string (depending on `mode`). */
	bg?: string;
	/** Auto-pick contrasting text based on `bg` luminance. Defaults to true. */
	autoText?: boolean;
	/** Manual text color, used when `autoText` is false. */
	text?: string;
}

/**
 * Independent color overrides for each major panel region.
 * Stored inside the custom theme so it round-trips with the existing
 * theme persistence (server + localStorage) without a schema change.
 */
export interface PanelColors {
	/** Master switch — when false, no per-panel overrides are applied. */
	enabled?: boolean;
	serverRail?: PanelColorOverride;
	leftSidebar?: PanelColorOverride;
	center?: PanelColorOverride;
	rightPanel?: PanelColorOverride;
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
	panelColors?: PanelColors;
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
	/**
	 * Per-user ambient-effect override (effect id, colors, intensity/size/speed,
	 * plus effect-specific state like the Joker title/blind/shop toggle).
	 * Persisted server-side under the `theme_ambient` key.
	 */
	theme_ambient?: ThemeAmbientOverride | null;
	updated_at?: number;
}

/** User's saved background-effect tweaks (from EffectsTab). */
export interface ThemeAmbientOverride {
	effect: string;
	color?: string;
	color2?: string;
	color3?: string;
	intensity: number;
	size: number;
	speed: number;
	globalOverride?: boolean;
	/** Effect-specific state, e.g. `{ state: 'title' | 'blind' | 'shop' }` for Joker. */
	state?: Record<string, unknown>;
}
