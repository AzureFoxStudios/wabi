/**
 * Theme Store
 * Svelte writable store for managing theme state
 */

import { writable, derived, get } from 'svelte/store';
import { DEFAULT_THEME, getThemeById, type Theme } from './themes';
import type { BackgroundImage, CustomTheme, ThemeAmbientOverride } from '../../types/theme';
import { saveThemePreferences } from './themeApi';

interface ThemeState {
	themeId: string;
	customTheme: CustomTheme | null;
	isLoading: boolean;
	error: string | null;
	uniformFontEnabled: boolean;
	uniformFontFamily: string;
	uniformFontSize: string;
	uniformFontWeight: string;
	uniformFontStyle: string;
	/** Per-user saved ambient-effect override (EffectsTab), round-trips with theme prefs. */
	themeAmbient: ThemeAmbientOverride | null;
}

// Initial state
const initialState: ThemeState = {
	themeId: 'dark',
	customTheme: null,
	isLoading: false,
	error: null,
	uniformFontEnabled: false,
	uniformFontFamily: 'inherit',
	uniformFontSize: 'inherit',
	uniformFontWeight: '600',
	uniformFontStyle: 'normal',
	themeAmbient: null
};

// Create the store
function createThemeStore() {
	const { subscribe, set, update } = writable<ThemeState>(initialState);

	return {
		subscribe,

		// Set theme ID (predefined theme)
		setThemeId: (themeId: string) => {
			update((state) => ({
				...state,
				themeId,
				customTheme: themeId === 'custom' ? state.customTheme : null,
				error: null
			}));
		},

		// Set custom theme
		setCustomTheme: (customTheme: CustomTheme | null) => {
			update((state) => ({
				...state,
				themeId: customTheme ? 'custom' : 'dark',
				customTheme,
				error: null
			}));
		},

		// Set loading state
		setLoading: (isLoading: boolean) => {
			update((state) => ({ ...state, isLoading }));
		},

		// Set error
		setError: (error: string | null) => {
			update((state) => ({ ...state, error, isLoading: false }));
		},

		// Reset to default
		reset: () => {
			set(initialState);
		},

		// Load from saved preferences
		load: (prefs: { theme_id: string; custom_theme?: CustomTheme | null; uniform_font_enabled?: number | boolean; uniform_font_family?: string; uniform_font_size?: string; uniform_font_weight?: string; uniform_font_style?: string; theme_ambient?: ThemeAmbientOverride | null }) => {
			update((state) => ({
				...state,
				themeId: prefs.theme_id || 'dark',
				customTheme: prefs.custom_theme || null,
				uniformFontEnabled: Boolean(prefs.uniform_font_enabled),
				uniformFontFamily: prefs.uniform_font_family || 'inherit',
				uniformFontSize: prefs.uniform_font_size || 'inherit',
				uniformFontWeight: prefs.uniform_font_weight || '600',
				uniformFontStyle: prefs.uniform_font_style || 'normal',
				themeAmbient: prefs.theme_ambient || null,
				isLoading: false,
				error: null
			}));
		},

		// Set the saved ambient-effect override (EffectsTab save path)
		setThemeAmbient: (ambient: ThemeAmbientOverride | null) => {
			update((state) => ({ ...state, themeAmbient: ambient }));
		},

		// Set uniform font enabled state
		setUniformFontEnabled: (enabled: boolean) => {
			update((state) => ({ ...state, uniformFontEnabled: enabled }));
		},

		// Set uniform font family
		setUniformFontFamily: (family: string) => {
			update((state) => ({ ...state, uniformFontFamily: family }));
		},

		// Set uniform font size
		setUniformFontSize: (size: string) => {
			update((state) => ({ ...state, uniformFontSize: size }));
		},

		// Set uniform font weight
		setUniformFontWeight: (weight: string) => {
			update((state) => ({ ...state, uniformFontWeight: weight }));
		},

		// Set uniform font style
		setUniformFontStyle: (style: string) => {
			update((state) => ({ ...state, uniformFontStyle: style }));
		},

		// Set all uniform font settings at once
		setUniformFont: (settings: { enabled: boolean; family: string; size: string; weight: string; style: string }) => {
			update((state) => ({
				...state,
				uniformFontEnabled: settings.enabled,
				uniformFontFamily: settings.family,
				uniformFontSize: settings.size,
				uniformFontWeight: settings.weight,
				uniformFontStyle: settings.style
			}));
		}
	};
}

export const themeStore = createThemeStore();

// Derived store: current active theme
export const currentTheme = derived(themeStore, ($themeStore) => {
	if ($themeStore.themeId === 'custom' && $themeStore.customTheme) {
		// Merge custom theme with default theme
		const baseTheme = DEFAULT_THEME;
		return {
			...baseTheme,
			id: 'custom',
			name: 'Custom',
			description: 'User-customized theme',
			colors: {
				...baseTheme.colors,
				...$themeStore.customTheme.colors
			},
			gradients: {
				...baseTheme.gradients,
				...$themeStore.customTheme.gradients
			}
		};
	}

	return getThemeById($themeStore.themeId);
});

// Derived store: is custom theme active
export const isCustomTheme = derived(themeStore, ($themeStore) => {
	return $themeStore.themeId === 'custom';
});

/**
 * Theme-agnostic chat background image setting.
 * Applies under ANY theme (preset or custom). Persisted server-side as the
 * top-level `background_image` key — never inside `custom_theme` — so saving
 * a background no longer forces theme_id='custom'.
 * Migration read: when the server has no top-level value but
 * `custom_theme.backgroundImage` exists (legacy), callers resolve to the
 * legacy value via `resolveEffectiveBackgroundImage` below.
 */
export const backgroundImageSetting = writable<BackgroundImage | null>(null);

/** Load the independent background setting (called on boot next to theme prefs). */
export function loadBackgroundImageSetting(bg: BackgroundImage | null): void {
	backgroundImageSetting.set(bg ?? null);
}

/**
 * Resolve the effective background: prefer the theme-agnostic top-level
 * setting when present, otherwise fall back to the legacy
 * `custom_theme.backgroundImage`. Never deletes the legacy field.
 */
export function resolveEffectiveBackgroundImage(
	topLevel: BackgroundImage | null | undefined,
	customTheme?: CustomTheme | null
): BackgroundImage | null {
	if (topLevel) return topLevel;
	return customTheme?.backgroundImage ?? null;
}

/**
 * Persist the background WITHOUT changing theme_id/custom_theme.
 * Sends `{ background_image: {...} }` alone (or null to clear) — the backend
 * stores it at the container top level and leaves the theme untouched.
 */
export async function persistBackgroundImageSetting(bg: BackgroundImage | null): Promise<void> {
	backgroundImageSetting.set(bg ?? null);
	try {
		await saveThemePreferences({ background_image: bg ?? null });
	} catch (error) {
		console.error('[ThemeStore] Failed to persist background image setting:', error);
		throw error;
	}
}

/** Clear the background (theme-agnostic remove). */
export async function clearBackgroundImageSetting(): Promise<void> {
	await persistBackgroundImageSetting(null);
}

/** Snapshot helper for non-reactive contexts (initTheme apply blocks). */
export function getBackgroundImageSnapshot(): BackgroundImage | null {
	return get(backgroundImageSetting);
}
