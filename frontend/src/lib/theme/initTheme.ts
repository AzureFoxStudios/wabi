/**
 * Theme Initialization
 * Loads and applies theme on app startup
 */

import { themeStore, currentTheme } from './themeStore';
import { applyTheme, loadThemeFromLocalStorage, saveThemeToLocalStorage } from './themeManager';
import { fetchThemePreferences } from './themeApi';
import { get } from 'svelte/store';

/**
 * Initialize theme system
 * - For registered users: Load from server, fallback to localStorage
 * - For guest users: Load from localStorage
 * - Apply theme to DOM
 */
export async function initializeTheme(isRegistered: boolean = false): Promise<void> {
	try {
		themeStore.setLoading(true);

		if (isRegistered) {
			// Try to load from server for registered users
			try {
				const prefs = await fetchThemePreferences();
				themeStore.load(prefs);
				console.log('[Theme] Loaded preferences from server:', prefs);
			} catch (error) {
				console.warn('[Theme] Failed to load from server, using localStorage:', error);
				// Fallback to localStorage
				const localPrefs = loadThemeFromLocalStorage();
				if (localPrefs) {
					themeStore.load(localPrefs);
				}
			}
		} else {
			// Guest users: load from localStorage only
			const localPrefs = loadThemeFromLocalStorage();
			if (localPrefs) {
				themeStore.load(localPrefs);
				console.log('[Theme] Loaded preferences from localStorage:', localPrefs);
			}
		}

		// Apply the theme to DOM
		const theme = get(currentTheme);
		applyTheme(theme);

		themeStore.setLoading(false);
	} catch (error) {
		console.error('[Theme] Initialization error:', error);
		themeStore.setError('Failed to initialize theme');

		// Apply default theme as fallback
		const theme = get(currentTheme);
		applyTheme(theme);
	}
}

/**
 * Subscribe to theme changes and auto-apply
 * Call this once on app initialization
 */
export function watchThemeChanges(): () => void {
	return currentTheme.subscribe((theme) => {
		applyTheme(theme);
	});
}

/**
 * Subscribe to theme store changes and sync to localStorage for guests
 * Call this for guest users
 */
export function syncThemeToLocalStorage(): () => void {
	return themeStore.subscribe((state) => {
		if (!state.isLoading && !state.error) {
			saveThemeToLocalStorage(state.themeId, state.customTheme);
		}
	});
}
