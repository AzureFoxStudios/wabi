/**
 * Theme Store
 * Svelte writable store for managing theme state
 */

import { writable, derived } from 'svelte/store';
import { DEFAULT_THEME, getThemeById, type Theme } from './themes';
import type { CustomTheme } from '../../types/theme';

interface ThemeState {
	themeId: string;
	customTheme: CustomTheme | null;
	isLoading: boolean;
	error: string | null;
}

// Initial state
const initialState: ThemeState = {
	themeId: 'dark',
	customTheme: null,
	isLoading: false,
	error: null
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
		load: (prefs: { theme_id: string; custom_theme?: CustomTheme | null }) => {
			update((state) => ({
				...state,
				themeId: prefs.theme_id || 'dark',
				customTheme: prefs.custom_theme || null,
				isLoading: false,
				error: null
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
