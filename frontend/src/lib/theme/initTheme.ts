/**
 * Theme Initialization
 * Loads and applies theme on app startup
 */

import { themeStore, currentTheme, backgroundImageSetting, loadBackgroundImageSetting } from './themeStore';
import { applyTheme, loadThemeFromLocalStorage, saveThemeToLocalStorage, resolveThemeBackground } from './themeManager';
import { applyPanelColors } from './panelColors';
import { fetchThemePreferences, getBackgroundImageFromPrefs } from './themeApi';
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
	// without duplicating the block. Background is theme-agnostic: prefer the
	// independent top-level setting, fall back to legacy customTheme for
	// migration — so it paints on preset themes too.
	const applyCurrentTheme = () => {
		const theme = get(currentTheme);
		const state = get(themeStore);
		const bgImage = resolveThemeBackground(get(backgroundImageSetting), state.customTheme);
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
				// Snapshot may carry a top-level background (new) or only the
				// legacy customTheme.backgroundImage (old) — the applier
				// resolves either way via resolveThemeBackground.
				loadBackgroundImageSetting(snapshot.background_image ?? null);
				applyCurrentTheme();
			}
			try {
				console.log('[Theme] Attempting to load preferences from server (registered user)...');
				startupMark('theme:fetch:start');
				const prefs = await fetchThemePreferences();
				startupMark('theme:fetch:end');
				startupMeasure('theme:fetch', 'theme:fetch:start', 'theme:fetch:end');
				themeStore.load(prefs);
				// Load the theme-agnostic background next to theme prefs.
				// Migration: raw top-level only — legacy customTheme fallback
				// is resolved at apply time, never deleted here.
				loadBackgroundImageSetting(prefs.background_image ?? null);
				// Refresh the local snapshot so the NEXT boot paints instantly.
				// Persist the effective background so top-level art survives
				// even when custom_theme carries no legacy copy.
				saveThemeToLocalStorage(
					prefs.theme_id,
					prefs.custom_theme ?? undefined,
					getBackgroundImageFromPrefs(prefs)
				);
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
						loadBackgroundImageSetting(localPrefs.background_image ?? null);
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
				loadBackgroundImageSetting(localPrefs.background_image ?? null);
				console.log('[Theme] ✅ Loaded from localStorage:', localPrefs);
			} else {
				console.log('[Theme] No localStorage preferences found for guest, using defaults');
			}
		}

		// Apply the theme to DOM
		const theme = get(currentTheme);
		const stateInit = get(themeStore);
	const bgImage = resolveThemeBackground(get(backgroundImageSetting), stateInit.customTheme);
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
		const backgroundImage = resolveThemeBackground(get(backgroundImageSetting), state.customTheme);
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
	const applyFromStores = () => {
		const theme = get(currentTheme);
		const state = get(themeStore);
		// Theme-agnostic: independent setting wins, legacy customTheme migrates.
		// applyTheme → applyBackgroundImageVars repaints on every change, any theme.
		const backgroundImage = resolveThemeBackground(get(backgroundImageSetting), state.customTheme);
		applyTheme(theme, backgroundImage, {
			enabled: state.uniformFontEnabled,
			family: state.uniformFontFamily,
			size: state.uniformFontSize,
			weight: state.uniformFontWeight,
			style: state.uniformFontStyle
		});
		applyPanelColors(state.customTheme?.panelColors);
	};
	const unsubTheme = themeStore.subscribe(() => applyFromStores());
	const unsubBg = backgroundImageSetting.subscribe(() => applyFromStores());
	return () => {
		unsubTheme();
		unsubBg();
	};
}

/**
 * Subscribe to theme store changes and sync to localStorage for guests
 * Call this for guest users
 */
export function syncThemeToLocalStorage(): () => void {
	return themeStore.subscribe((state) => {
		if (!state.isLoading && !state.error) {
			saveThemeToLocalStorage(state.themeId, state.customTheme, get(backgroundImageSetting));
		}
	});
}
