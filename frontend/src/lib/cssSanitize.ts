/**
 * Allowlist validators for user/admin-supplied CSS and color values.
 * Prefer rejection over a full sanitizer dependency.
 */

const HEX_COLOR =
	/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_COLOR =
	/^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i;
const HSL_COLOR =
	/^hsla?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})%\s*,\s*([0-9]{1,3})%(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i;

const CSS_DANGEROUS =
	/url\s*\(|@import|<\/?style|expression\s*\(|javascript:|vbscript:|behavior\s*:|@charset|data\s*:|binding\s*:|<\/|<|>|\\0/i;

/** Accept only hex / rgb(a) / hsl(a). Returns null if invalid. */
export function sanitizeAccentColor(value: string | null | undefined): string | null {
	if (value == null) return null;
	const trimmed = String(value).trim();
	if (!trimmed) return null;
	if (HEX_COLOR.test(trimmed)) return trimmed;
	const rgb = trimmed.match(RGB_COLOR);
	if (rgb) {
		const r = Number(rgb[1]);
		const g = Number(rgb[2]);
		const b = Number(rgb[3]);
		if ([r, g, b].every((n) => n >= 0 && n <= 255)) return trimmed;
		return null;
	}
	const hsl = trimmed.match(HSL_COLOR);
	if (hsl) {
		const h = Number(hsl[1]);
		const s = Number(hsl[2]);
		const l = Number(hsl[3]);
		if (h >= 0 && h <= 360 && s >= 0 && s <= 100 && l >= 0 && l <= 100) return trimmed;
		return null;
	}
	return null;
}

/**
 * Strip/reject dangerous custom CSS. Empty string if fully rejected.
 * Blocks url(), @import, style breakout, expression(), javascript:, etc.
 */
export function sanitizeCustomCss(value: string | null | undefined): string {
	if (value == null) return '';
	const raw = String(value);
	if (!raw.trim()) return '';
	if (CSS_DANGEROUS.test(raw)) return '';
	// Cap length to limit abuse
	if (raw.length > 20_000) return '';
	// Disallow curly-brace balanced? Allow simple property rules only is hard;
	// danger patterns above are the critical bar. Strip null bytes.
	return raw.replace(/\u0000/g, '');
}

/** Safe url() for background images — https/http/relative only, no javascript. */
export function sanitizeCssUrl(value: string | null | undefined): string | null {
	if (value == null) return null;
	const trimmed = String(value).trim();
	if (!trimmed) return null;
	if (/^\s*javascript:/i.test(trimmed) || /^\s*data:/i.test(trimmed) || /[)'"<>]/.test(trimmed)) {
		return null;
	}
	if (/^(https?:\/\/|\/|\.\/)/i.test(trimmed)) return trimmed;
	return null;
}
