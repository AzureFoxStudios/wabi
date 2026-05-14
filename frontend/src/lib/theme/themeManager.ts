/**
 * Theme Manager
 * Applies theme to the DOM by setting CSS custom properties
 * Sets BOTH legacy tokens (--bg-primary) AND semantic tokens (--surface-app)
 * for smooth migration. Once all components use semantic tokens, legacy layer
 * can be removed.
 */

import type { Theme } from './themes';
import type { BackgroundImage } from '../types/theme';
import { applyAccessibilitySettings, getStoredAccessibilitySettings } from '../accessibility';

/**
 * Convert color name from camelCase to kebab-case CSS variable name
 * Example: bgPrimary -> --bg-primary
 */
function toKebabCase(str: string): string {
	return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Legacy token map: old --color-* namespace -> runtime value from Theme
 * Ensures components still using --color-accent-primary get the right value.
 */
const LEGACY_COLOR_MAP: Record<string, keyof Theme['colors']> = {
	'--color-background-primary': 'bgSecondary',
	'--color-background-secondary': 'bgTertiary',
	'--color-background-tertiary': 'bgHover',
	'--color-text-primary': 'textPrimary',
	'--color-text-secondary': 'textSecondary',
	'--color-text-tertiary': 'textTertiary',
	'--color-accent-primary': 'accentHex',
	'--color-accent-secondary': 'accentHex', // approximated — used only as fallback
	'--color-status-success': 'colorSuccess',
	'--color-status-warning': 'colorWarning',
	'--color-status-danger': 'colorDanger',
	'--color-status-info': 'colorInfo',
	'--color-status-neutral': 'statusOffline',
};

/**
 * Semantic token map: new --surface-app namespace -> runtime value from Theme
 * Sets the semantic layer so components using tokens.css get correct values.
 */
const SEMANTIC_MAP: Record<string, string> = {
	'--surface-app': '--bg-primary',
	'--surface-base': '--bg-secondary',
	'--surface-raised': '--bg-tertiary',
	'--surface-sunken': '--modal-bg',
	'--surface-sidebar': '--bg-secondary',
	'--surface-chat': '--bg-primary',
	'--surface-message': '--bg-tertiary',
	'--surface-modal': '--modal-bg',
	'--surface-card': '--bg-tertiary',
	'--surface-popover': '--bg-secondary',
	'--surface-tooltip': '--modal-bg',
	'--surface-input': '--bg-secondary',
	'--surface-button': '--bg-tertiary',
	'--surface-hover': '--bg-hover',
	'--surface-active': '--modal-bg',
	'--surface-selected': '--accent',
	'--surface-overlay': '--modal-overlay',
	'--surface-scrollbar': '--gradient-scrollbar',
	'--surface-elevated': '--bg-tertiary',
	'--surface-panel': '--bg-secondary',
	'--text-heading': '--text-primary',
	'--text-body': '--text-primary',
	'--text-secondary': '--text-secondary',
	'--text-muted': '--text-tertiary',
	'--text-placeholder': '--text-tertiary',
	'--text-link': '--accent',
	'--text-inverse': '--bg-sunken', // will resolve via var() in tokens.css
	'--text-danger': '--color-danger',
	'--text-warning': '--color-warning',
	'--text-success': '--color-success',
	'--text-info': '--color-info',
	'--border-subtle': '--border',
	'--border-focus': '--accent',
	'--accent-primary': '--accent',
	'--accent-secondary': '--accent-hover',
	'--accent-gradient': '--gradient-accent',
	'--accent-hover': '--accent-hover',
	'--accent-glow': '--accent-rgb',
	'--status-online': '--status-online',
	'--status-away': '--status-away',
	'--status-busy': '--status-busy',
	'--status-offline': '--status-offline',
	'--color-success': '--color-success',
	'--color-info': '--color-info',
	'--color-warning': '--color-warning',
	'--color-danger': '--color-danger',
};

/**
 * Apply a theme to the document root.
 * Sets legacy, color-namespace, and semantic tokens.
 */
export function applyTheme(theme: Theme, backgroundImage?: BackgroundImage, uniformFontSettings?: {
	enabled: boolean;
	family: string;
	size: string;
	weight: string;
	style: string;
}): void {
	const root = document.documentElement;

	// === 1. Apply core color variables (legacy --bg-primary etc.) ===
	Object.entries(theme.colors).forEach(([key, value]) => {
		const cssVarName = `--${toKebabCase(key)}`;
		root.style.setProperty(cssVarName, value);
	});

	// === 2. Apply gradient variables (legacy --gradient-primary etc.) ===
	Object.entries(theme.gradients).forEach(([key, value]) => {
		const cssVarName = `--gradient-${toKebabCase(key)}`;
		root.style.setProperty(cssVarName, value);
	});

	// === 3. Bridge legacy --color-* namespace (components still using it) ===
	Object.entries(LEGACY_COLOR_MAP).forEach(([cssVar, themeKey]) => {
		const value = theme.colors[themeKey];
		if (value !== undefined) {
			root.style.setProperty(cssVar, value);
		}
	});

	// === 4. Set semantic aliases (components using tokens.css) ===
	Object.entries(SEMANTIC_MAP).forEach(([semanticVar, sourceVar]) => {
		const computed = getComputedStyle(root).getPropertyValue(sourceVar).trim();
		if (computed) {
			root.style.setProperty(semanticVar, `var(${sourceVar})`);
		}
	});

	// === 5. Apply background image variables ===
	if (backgroundImage) {
		root.style.setProperty('--background-image-url', `url('${backgroundImage.url}')`);
		root.style.setProperty('--background-image-opacity', String(backgroundImage.opacity ?? 0.3));
		root.style.setProperty('--background-image-blur', `${backgroundImage.blur ?? 0}px`);
		root.style.setProperty('--background-image-size', backgroundImage.size ?? 'cover');
		root.style.setProperty('--background-image-position', backgroundImage.position ?? 'center');
		root.style.setProperty('--background-image-repeat', backgroundImage.repeat ?? 'no-repeat');
		root.style.setProperty('--background-image-blend', backgroundImage.blend ?? 'overlay');
	} else {
		root.style.setProperty('--background-image-url', 'none');
		root.style.setProperty('--background-image-opacity', '1');
		root.style.setProperty('--background-image-blur', '0px');
		root.style.setProperty('--background-image-size', 'cover');
		root.style.setProperty('--background-image-position', 'center');
		root.style.setProperty('--background-image-repeat', 'no-repeat');
		root.style.setProperty('--background-image-blend', 'normal');
	}

	// === 6. Apply uniform font settings ===
	if (uniformFontSettings?.enabled) {
		root.style.setProperty('--uniform-font-family', uniformFontSettings.family);
		root.style.setProperty('--uniform-font-size', uniformFontSettings.size);
		root.style.setProperty('--uniform-font-weight', uniformFontSettings.weight);
		root.style.setProperty('--uniform-font-style', uniformFontSettings.style);
	} else {
		root.style.setProperty('--uniform-font-family', 'inherit');
		root.style.setProperty('--uniform-font-size', 'inherit');
		root.style.setProperty('--uniform-font-weight', 'inherit');
		root.style.setProperty('--uniform-font-style', 'inherit');
	}

	// === 7. Data attribute + accessibility ===
	root.setAttribute('data-theme', theme.id);
	applyAccessibilitySettings(getStoredAccessibilitySettings());

	console.log(`[ThemeManager] Applied theme: ${theme.name} (${theme.id}) — semantic tokens bridged`);
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
