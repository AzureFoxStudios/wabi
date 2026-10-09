import { sanitizeAccentColor, sanitizeCustomCss, sanitizeCssUrl } from '$lib/cssSanitize';
import { applyBootShellBrand, selectBrandConfig, type BrandConfig } from '$lib/branding';
import { currentSavedServer } from '$lib/savedServerStore';
import { get } from 'svelte/store';

// ============================================================================
// B3 — neutral (strip-Wabi) branding
// ============================================================================

/** True when the currently connected saved server opted into neutral branding. */
export function isNeutralBrandingEnabled(): boolean {
	return get(currentSavedServer)?.useNeutralBranding === true;
}

/**
 * Effective brand config for the launch/login page. When the connected server
 * opts into neutral branding, this swaps `brandConfig` for `neutralBrandConfig`
 * (empty name, generic gray glyph, neutral palette — no hardcoded "Wabi").
 */
export function getEffectiveBrandConfig(): BrandConfig {
	return selectBrandConfig(isNeutralBrandingEnabled());
}

/**
 * Injects neutral branding at launch. Sets/removes `data-neutral-branding` on
 * <html> so neutral-branding.css / login.css can strip the hardcoded "Wabi"
 * logo + title and neutralize the accent palette. Also rebrands the boot shell
 * while it is still visible. Idempotent; safe to call repeatedly.
 * When `useNeutral` is omitted, auto-detects from the active server.
 */
export function injectNeutralBranding(useNeutral?: boolean): void {
	if (typeof document === 'undefined') return;
	const enabled = useNeutral ?? isNeutralBrandingEnabled();
	const root = document.documentElement;
	if (enabled) {
		root.setAttribute('data-neutral-branding', '');
		applyBootShellBrand({ neutral: true, brandName: '', logoUrl: '', accent: '#a1a1aa' });
	} else {
		root.removeAttribute('data-neutral-branding');
		const brand = getEffectiveBrandConfig();
		const server = get(currentSavedServer);
		const launch = server?.launchPageBranding;
		applyBootShellBrand({
			neutral: false,
			brandName: launch?.brandName || brand.name || '',
			logoUrl: launch?.logoUrl || brand.bootLogoUrl || brand.logoUrl || '',
			accent: launch?.palette?.accent || brand.palette.accent || ''
		});
	}
}

export interface LoginValidationResult {
	valid: boolean;
	error?: string;
}

export function validateUsername(username: string): LoginValidationResult {
	if (username.length < 2) {
		return { valid: false, error: 'Username must be at least 2 characters' };
	}
	return { valid: true };
}

export function validateHandle(handle: string): LoginValidationResult {
	const cleanHandle = handle.replace(/^@/, '').toLowerCase();
	if (!/^[a-z][a-z0-9_]{1,31}$/.test(cleanHandle)) {
		return { valid: false, error: 'Handle must start with a letter and contain only lowercase letters, numbers, and underscores' };
	}
	return { valid: true, error: undefined };
}

export function validatePassword(password: string): LoginValidationResult {
	if (password.length < 8) {
		return { valid: false, error: 'Password must be at least 8 characters' };
	}
	return { valid: true };
}

export function validatePasswordMatch(password: string, passwordConfirm: string): LoginValidationResult {
	if (password !== passwordConfirm) {
		return { valid: false, error: 'Passwords do not match' };
	}
	return { valid: true };
}

export function validateRegistration(
	username: string,
	handle: string,
	password: string,
	passwordConfirm: string
): LoginValidationResult {
	const usernameResult = validateUsername(username);
	if (!usernameResult.valid) return usernameResult;
	const handleResult = validateHandle(handle);
	if (!handleResult.valid) return handleResult;
	const passwordResult = validatePassword(password);
	if (!passwordResult.valid) return passwordResult;
	const matchResult = validatePasswordMatch(password, passwordConfirm);
	if (!matchResult.valid) return matchResult;
	return { valid: true };
}

export function validateLogin(username: string, password: string): LoginValidationResult {
	if (!username || !password) {
		return { valid: false, error: 'Username and password are required' };
	}
	return { valid: true };
}

export function generateHandleFromUsername(username: string): string {
	return username.replace(/\s+/g, '').toLowerCase();
}

export interface LaunchPageStyleConfig {
	launchContainerStyle: string;
	launchCardStyle: string;
	launchCustomCss: string;
}

/** The server always reports this accent for a community that never chose one; it is a placeholder, not branding. */
export const STOCK_LAUNCH_ACCENT = '#5865f2';

interface LaunchBrandingInput {
	enabled?: boolean | null;
	backgroundImageUrl?: string | null;
	palette?: {
		backgroundTop?: string | null;
		backgroundBottom?: string | null;
		accent?: string | null;
		text?: string | null;
		cardBackground?: string | null;
	} | null;
}

/**
 * Should the login take its look from the operator's launch settings instead of the viewer's theme?
 * Yes when the launch page is enabled, or the operator set a colour/backdrop of their own. A disabled page that only
 * carries the server's stock accent follows the theme. Neutral branding always follows the theme.
 */
export function hasOperatorLaunchStyling(config: LaunchBrandingInput | null | undefined, neutralBranding: boolean): boolean {
	if (!config || neutralBranding) return false;
	const palette = config.palette ?? {};
	const accent = palette.accent?.trim().toLowerCase();
	return Boolean(
		config.enabled ||
			config.backgroundImageUrl ||
			palette.backgroundTop ||
			palette.backgroundBottom ||
			palette.cardBackground ||
			palette.text ||
			(accent && accent !== STOCK_LAUNCH_ACCENT)
	);
}

export function buildLaunchPageStyles(config: {
	enabled: boolean;
	palette: {
		backgroundTop: string;
		backgroundBottom: string;
		accent: string;
		text: string;
		cardBackground: string;
	};
	backgroundImageUrl?: string;
	customCss?: string;
}): LaunchPageStyleConfig {
	if (!config.enabled) {
		return { launchContainerStyle: '', launchCardStyle: '', launchCustomCss: '' };
	}
	// Only the colours the operator actually set are emitted; anything else follows the viewer's theme
	// (the stylesheet falls back to the --w-* roles), instead of a baked-in navy/teal.
	const bgTop = sanitizeAccentColor(config.palette.backgroundTop);
	const bgBottom = sanitizeAccentColor(config.palette.backgroundBottom);
	const accent = sanitizeAccentColor(config.palette.accent);
	const text = sanitizeAccentColor(config.palette.text);
	const cardBg = sanitizeAccentColor(config.palette.cardBackground);
	const safeBgUrl = sanitizeCssUrl(config.backgroundImageUrl || null);
	const declarations = [
		bgTop && `--launch-bg-top: ${bgTop};`,
		bgBottom && `--launch-bg-bottom: ${bgBottom};`,
		accent && `--launch-accent: ${accent};`,
		text && `--launch-text: ${text};`,
		safeBgUrl && `background-image: url(${safeBgUrl}); background-size: cover; background-position: center;`
	].filter(Boolean);
	const launchContainerStyle = declarations.join(' ');
	const launchCardStyle = cardBg ? `--launch-card-bg: ${cardBg};` : '';
	const launchCustomCss = sanitizeCustomCss(config.customCss || '');
	return { launchContainerStyle, launchCardStyle, launchCustomCss };
}

