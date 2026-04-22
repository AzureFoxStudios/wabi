export interface LaunchPageHighlight {
	title: string;
	description: string;
}

export interface LaunchPagePalette {
	backgroundTop: string;
	backgroundBottom: string;
	cardBackground: string;
	accent: string;
	text: string;
}

export interface LaunchPageConfig {
	enabled: boolean;
	brandName: string;
	headline: string;
	subheadline: string;
	logoUrl: string;
	backgroundImageUrl: string | null;
	customCss: string | null;
	heroImageUrl: string | null;
	heroTitle: string | null;
	heroBody: string | null;
	heroPrimaryCtaLabel: string | null;
	heroPrimaryCtaUrl: string | null;
	highlights: LaunchPageHighlight[];
	footerNote: string | null;
	palette: LaunchPagePalette;
}
