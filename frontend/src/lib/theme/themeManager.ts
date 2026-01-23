/**
 * Theme Manager
 * Applies theme to the DOM by setting CSS custom properties
 */

import type { Theme } from './themes';
import type { BackgroundImage } from '../types/theme';

/**
 * Convert color name from camelCase to kebab-case CSS variable name
 * Example: bgPrimary -> --bg-primary
 */
function toKebabCase(str: string): string {
	return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Apply a theme to the document root
 * Sets all CSS custom properties based on theme values
 */
export function applyTheme(theme: Theme, backgroundImage?: BackgroundImage, uniformFontSettings?: {
	enabled: boolean;
	family: string;
	size: string;
	weight: string;
	style: string;
}): void {
	const root = document.documentElement;

	// Apply color variables
	Object.entries(theme.colors).forEach(([key, value]) => {
		const cssVarName = `--${toKebabCase(key)}`;
		root.style.setProperty(cssVarName, value);
	});

	// Apply gradient variables
	Object.entries(theme.gradients).forEach(([key, value]) => {
		const cssVarName = `--gradient-${toKebabCase(key)}`;
		root.style.setProperty(cssVarName, value);
	});

	// Apply background image variables if provided
	if (backgroundImage) {
		root.style.setProperty('--background-image-url', `url('${backgroundImage.url}')`);
		root.style.setProperty('--background-image-opacity', String(backgroundImage.opacity ?? 0.3));
		root.style.setProperty('--background-image-blur', `${backgroundImage.blur ?? 0}px`);
		root.style.setProperty('--background-image-size', backgroundImage.size ?? 'cover');
		root.style.setProperty('--background-image-position', backgroundImage.position ?? 'center');
		root.style.setProperty('--background-image-repeat', backgroundImage.repeat ?? 'no-repeat');
		root.style.setProperty('--background-image-blend', backgroundImage.blend ?? 'overlay');
	} else {
		// Clear background image variables if no image
		root.style.setProperty('--background-image-url', 'none');
		root.style.setProperty('--background-image-opacity', '1');
		root.style.setProperty('--background-image-blur', '0px');
		root.style.setProperty('--background-image-size', 'cover');
		root.style.setProperty('--background-image-position', 'center');
		root.style.setProperty('--background-image-repeat', 'no-repeat');
		root.style.setProperty('--background-image-blend', 'normal');
	}

	// Apply uniform font settings if enabled
	if (uniformFontSettings?.enabled) {
		root.style.setProperty('--uniform-font-family', uniformFontSettings.family);
		root.style.setProperty('--uniform-font-size', uniformFontSettings.size);
		root.style.setProperty('--uniform-font-weight', uniformFontSettings.weight);
		root.style.setProperty('--uniform-font-style', uniformFontSettings.style);
	}

	// Set data-theme attribute for CSS selectors
	root.setAttribute('data-theme', theme.id);

	console.log(`[ThemeManager] Applied theme: ${theme.name} (${theme.id})`);
}

/**
 * Load theme from localStorage (fallback for guests)
 */
export function loadThemeFromLocalStorage(): { theme_id: string; custom_theme?: any } | null {
	try {
		const saved = localStorage.getItem('wabi-theme');
		if (!saved) return null;

		return JSON.parse(saved);
	} catch (error) {
		console.error('[ThemeManager] Failed to load theme from localStorage:', error);
		return null;
	}
}

/**
 * Save theme to localStorage (fallback for guests)
 */
export function saveThemeToLocalStorage(themeId: string, customTheme?: any): void {
	try {
		localStorage.setItem('wabi-theme', JSON.stringify({
			theme_id: themeId,
			custom_theme: customTheme || null
		}));
	} catch (error) {
		console.error('[ThemeManager] Failed to save theme to localStorage:', error);
	}
}

/**
 * Clear theme from localStorage
 */
export function clearThemeFromLocalStorage(): void {
	try {
		localStorage.removeItem('wabi-theme');
	} catch (error) {
		console.error('[ThemeManager] Failed to clear theme from localStorage:', error);
	}
}
