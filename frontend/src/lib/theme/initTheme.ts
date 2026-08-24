/**
 * Theme Initialization
 * Loads and applies theme on app startup
 */

import { themeStore, currentTheme } from './themeStore';
import { applyTheme, loadThemeFromLocalStorage, saveThemeToLocalStorage } from './themeManager';
import { applyPanelColors } from './panelColors';
import { fetchThemePreferences } from './themeApi';
import { get } from 'svelte/store';
import { startupMark, startupMeasure } from '$lib/startupProfiler';

/**
 * Initialize theme system
 * - For registered users: Load from server, fallback to localStorage
 * - For guest users: Load from localStorage
 * - Apply theme to DOM
 */
export async function initializeTheme(isRegistered: boolean = false): Promise<void> {
	startupMark('theme:initialize:start');
	// Shared applier so we can paint twice (snapshot first, server reconcile second)
	// without duplicating the block.
	const applyCurrentTheme = () => {
		const theme = get(currentTheme);
		const state = get(themeStore);
		const bgImage = state.customTheme?.backgroundImage;
		applyTheme(theme, bgImage, {
			enabled: state.uniformFontEnabled,
			family: state.uniformFontFamily,
			size: state.uniformFontSize,
			weight: state.uniformFontWeight,
			style: state.uniformFontStyle
		});
		applyPanelColors(state.customTheme?.panelColors);
	};

	try {
		themeStore.setLoading(true);

		if (isRegistered) {
			// Stale-while-revalidate: paint the last-known theme from localStorage
			// IMMEDIATELY so returning users never stare at an unthemed page while
			// the server roundtrip completes, then reconcile with the server
			// (server remains source of truth and overwrites on arrival).
			const snapshot = loadThemeFromLocalStorage();
			if (snapshot) {
				themeStore.load(snapshot);
				applyCurrentTheme();
			}
			try {
				console.log('[Theme] Attempting to load preferences from server (registered user)...');
				startupMark('theme:fetch:start');
				const prefs = await fetchThemePreferences();
				startupMark('theme:fetch:end');
				startupMeasure('theme:fetch', 'theme:fetch:start', 'theme:fetch:end');
				themeStore.load(prefs);
				// Refresh the local snapshot so the NEXT boot paints instantly.
				saveThemeToLocalStorage(prefs.theme_id, prefs.custom_theme ?? undefined);
				console.log('[Theme] ✅ Successfully loaded preferences from server:', {
					theme_id: prefs.theme_id,
					uniform_font_enabled: prefs.uniform_font_enabled
				});
			} catch (error) {
				startupMark('theme:fetch:end');
				startupMeasure('theme:fetch', 'theme:fetch:start', 'theme:fetch:end');
				console.warn('[Theme] ❌ Failed to load from server:', error instanceof Error ? error.message : error);
				if (!snapshot) {
					console.log('[Theme] Falling back to localStorage...');
					const localPrefs = loadThemeFromLocalStorage();
					if (localPrefs) {
						themeStore.load(localPrefs);
						console.log('[Theme] ✅ Loaded from localStorage fallback:', localPrefs);
					} else {
						console.log('[Theme] No localStorage preferences found, using defaults');
					}
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
	applyPanelColors(stateInit.customTheme?.panelColors);

		themeStore.setLoading(false);
	console.log('[Theme] ✅ Theme initialization complete');
		startupMark('theme:initialize:end');
		startupMeasure('theme:initialize', 'theme:initialize:start', 'theme:initialize:end');
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
		applyPanelColors(state.customTheme?.panelColors);
		startupMark('theme:initialize:end');
		startupMeasure('theme:initialize', 'theme:initialize:start', 'theme:initialize:end');
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
		applyPanelColors(state.customTheme?.panelColors);
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
