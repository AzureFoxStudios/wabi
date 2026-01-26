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
				console.log('[Theme] Attempting to load preferences from server (registered user)...');
				const prefs = await fetchThemePreferences();
				themeStore.load(prefs);
				console.log('[Theme] ✅ Successfully loaded preferences from server:', {
					theme_id: prefs.theme_id,
					uniform_font_enabled: prefs.uniform_font_enabled
				});
			} catch (error) {
				console.warn('[Theme] ❌ Failed to load from server:', error instanceof Error ? error.message : error);
				console.log('[Theme] Falling back to localStorage...');
				// Fallback to localStorage
				const localPrefs = loadThemeFromLocalStorage();
				if (localPrefs) {
					themeStore.load(localPrefs);
					console.log('[Theme] ✅ Loaded from localStorage fallback:', localPrefs);
				} else {
					console.log('[Theme] No localStorage preferences found, using defaults');
				}
			}
		} else {
			// Guest users: load from localStorage only
			console.log('[Theme] Loading preferences for guest user from localStorage...');
			const localPrefs = loadThemeFromLocalStorage();
			if (localPrefs) {
				themeStore.load(localPrefs);
				console.log('[Theme] ✅ Loaded from localStorage:', localPrefs);
			} else {
				console.log('[Theme] No localStorage preferences found for guest, using defaults');
			}
		}

		// Apply the theme to DOM
		const theme = get(currentTheme);
		const stateInit = get(themeStore);
	const bgImage = stateInit.customTheme?.backgroundImage;
	applyTheme(theme, bgImage, {
		enabled: stateInit.uniformFontEnabled,
		family: stateInit.uniformFontFamily,
		size: stateInit.uniformFontSize,
		weight: stateInit.uniformFontWeight,
		style: stateInit.uniformFontStyle
	});

		themeStore.setLoading(false);
	console.log('[Theme] ✅ Theme initialization complete');
	} catch (error) {
		console.error('[Theme] ❌ Initialization error:', error instanceof Error ? error.message : error);
		themeStore.setError('Failed to initialize theme');

		// Apply default theme as fallback
		const theme = get(currentTheme);
		const state = get(themeStore);
		const backgroundImage = state.customTheme?.backgroundImage;
		applyTheme(theme, backgroundImage, {
			enabled: state.uniformFontEnabled,
			family: state.uniformFontFamily,
			size: state.uniformFontSize,
			weight: state.uniformFontWeight,
			style: state.uniformFontStyle
		});
	}
}

/**
 * Subscribe to theme changes and auto-apply
 * Call this once on app initialization
 */
export function watchThemeChanges(): () => void {
	return themeStore.subscribe((state) => {
		const theme = get(currentTheme);
		const backgroundImage = state.customTheme?.backgroundImage;
		applyTheme(theme, backgroundImage, {
			enabled: state.uniformFontEnabled,
			family: state.uniformFontFamily,
			size: state.uniformFontSize,
			weight: state.uniformFontWeight,
			style: state.uniformFontStyle
		});
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
