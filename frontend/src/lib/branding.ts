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
