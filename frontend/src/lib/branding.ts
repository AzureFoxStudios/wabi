export interface BrandConfig {
	name: string;
	shortName: string;
	tagline: string;
	description: string;
	domain: string;
	logoUrl: string;
	logoSmallUrl: string;
	bootLogoUrl: string;
	faviconUrl: string;
	headline: string;
	subheadline: string;
	footerText: string;
	customCss: string;
	palette: {
		accent: string;
		muted: string;
		surface: string;
	};
}

export const brandConfig: BrandConfig = {
	name: 'Wabi',
	shortName: 'Wabi',
	tagline: 'Chat',
	description: 'Ephemeral chat with screen sharing and business features',
	domain: 'wabi.chat',
	logoUrl: '/wabi-logo.webp',
	logoSmallUrl: '/wabi-logo-small.webp',
	bootLogoUrl: '/wabi-logo.png',
	faviconUrl: '/favicon.png',
	headline: '',
	subheadline: '',
	footerText: '',
	customCss: '',
	palette: {
		accent: '#6366f1',
		muted: '#94a3b8',
		surface: '#1a1a2e'
	}
};

/**
 * Neutral (unbranded) fallback glyph used when a community opts into the
 * strip-Wabi mode. Gray chat-bubble mark — no product identity baked in.
 */
const NEUTRAL_LOGO_DATA_URI =
	'data:image/svg+xml;utf8,' +
	"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'>" +
	"<rect width='96' height='96' rx='22' fill='%23a1a1aa'/>" +
	"<path d='M24 34a8 8 0 0 1 8-8h32a8 8 0 0 1 8 8v18a8 8 0 0 1-8 8H45l-13 11v-11h-8a8 8 0 0 1-8-8z' fill='%23101012'/>" +
	'</svg>';

/**
 * B3 — strip-Wabi default theme. Same shape as BrandConfig but fully neutral:
 * no name, no tagline, no domain, generic gray glyph, neutral gray palette.
 */
export const neutralBrandConfig: BrandConfig = {
	name: '',
	shortName: '',
	tagline: '',
	description: '',
	domain: '',
	logoUrl: NEUTRAL_LOGO_DATA_URI,
	logoSmallUrl: NEUTRAL_LOGO_DATA_URI,
	bootLogoUrl: NEUTRAL_LOGO_DATA_URI,
	faviconUrl: '',
	headline: '',
	subheadline: '',
	footerText: '',
	customCss: '',
	palette: {
		accent: '#a1a1aa',
		muted: '#71717a',
		surface: '#18181b'
	}
};

/** B3 selector — swap the active brand config to the neutral one on demand. */
export function selectBrandConfig(useNeutral: boolean): BrandConfig {
	return useNeutral ? neutralBrandConfig : brandConfig;
}

export const brandName = brandConfig.name;

export function brandDocumentTitle(segment?: string): string {
	if (!segment) return brandName || 'Chat';
	return brandName ? `${segment} · ${brandName}` : segment;
}

export type BootBrandSnapshot = {
	neutral?: boolean;
	brandName?: string;
	logoUrl?: string;
	accent?: string;
	/** Intentionally override a locked boot brand (rare). */
	force?: boolean;
};

declare global {
	interface Window {
		__applyWabiBootBrand?: (snapshot?: BootBrandSnapshot | null) => void;
		__hideWabiBootShell?: () => void;
		__enterReconnectMode?: () => void;
		__WABI_BOOT_BRAND__?: BootBrandSnapshot;
	}
}

/** Push brand into the pre-app boot shell (if still mounted). */
export function applyBootShellBrand(snapshot: BootBrandSnapshot): void {
	if (typeof window === 'undefined') return;
	// Keep the last committed snapshot for late readers, but the shell lock
	// inside __applyWabiBootBrand is the real anti-flicker guard.
	if (snapshot.force || !window.__WABI_BOOT_BRAND__) {
		window.__WABI_BOOT_BRAND__ = snapshot;
	} else {
		// Merge upward: never drop a custom logo because a default Wabi config arrived late.
		const prev = window.__WABI_BOOT_BRAND__;
		const nextIsDefaultWabi =
			!snapshot.neutral && !snapshot.logoUrl && (!snapshot.brandName || snapshot.brandName === 'Wabi');
		const prevIsCustom = Boolean(prev.neutral || prev.logoUrl || (prev.brandName && prev.brandName !== 'Wabi'));
		if (prevIsCustom && nextIsDefaultWabi && !snapshot.force) {
			// Keep prev; still poke apply so ready-state is set if needed.
			if (typeof window.__applyWabiBootBrand === 'function') {
				window.__applyWabiBootBrand(prev);
			}
			return;
		}
		window.__WABI_BOOT_BRAND__ = { ...prev, ...snapshot };
	}
	if (typeof window.__applyWabiBootBrand === 'function') {
		window.__applyWabiBootBrand(window.__WABI_BOOT_BRAND__);
	} else {
		window.dispatchEvent(new CustomEvent('wabi:boot-brand', { detail: window.__WABI_BOOT_BRAND__ }));
	}
}

export function applyBranding(config: BrandConfig = brandConfig, options?: { neutral?: boolean; force?: boolean }): void {
	if (typeof window === 'undefined') return;
	const neutral = options?.neutral === true || !config.name;

	if (config.name) {
		document.title = config.name;
	} else if (neutral) {
		document.title = 'Chat';
	}

	const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
	if (icon && config.faviconUrl) {
		icon.href = config.faviconUrl;
	}

	// Prefer already-captured localStorage boot brand over a bare default Wabi
	// config so layout onMount doesn't flash Wabi over the server icon.
	const existing = window.__WABI_BOOT_BRAND__;
	const isDefaultWabi =
		!neutral &&
		config.name === brandConfig.name &&
		(config.bootLogoUrl === brandConfig.bootLogoUrl || config.logoUrl === brandConfig.logoUrl);

	if (!options?.force && isDefaultWabi && existing && (existing.neutral || existing.logoUrl || (existing.brandName && existing.brandName !== 'Wabi'))) {
		applyBootShellBrand({ ...existing, force: false });
		return;
	}

	applyBootShellBrand({
		neutral,
		brandName: config.name || '',
		logoUrl: config.bootLogoUrl || config.logoUrl || '',
		accent: config.palette?.accent || '',
		force: options?.force === true
	});
}
