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
	if (!segment) return brandName;
	return `${segment} · ${brandName}`;
}

export function applyBranding(): void {
	if (typeof window === 'undefined') return;
	if (!document.title) {
		document.title = brandName;
	}
	const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
	if (icon) {
		icon.href = brandConfig.faviconUrl;
	}
	const bootTitle = document.querySelector<HTMLElement>('.wabi-boot-shell__title');
	if (bootTitle && bootTitle.textContent?.includes('Wabi')) {
		bootTitle.textContent = bootTitle.textContent.replace(/Wabi/g, brandName);
	}
	const bootLogo = document.querySelector<HTMLImageElement>('.wabi-boot-shell__logo');
	if (bootLogo) {
		bootLogo.src = brandConfig.bootLogoUrl;
	}
}
