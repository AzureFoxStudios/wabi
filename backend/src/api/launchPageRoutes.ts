import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { IncomingMessage, ServerResponse } from 'http';

export interface LaunchPageHighlight {
	title: string;
	description: string;
}

export interface PublicLaunchPageConfig {
	enabled: boolean;
	brandName: string;
	headline: string;
	subheadline: string;
	logoUrl: string;
	heroImageUrl: string | null;
	heroTitle: string | null;
	heroBody: string | null;
	heroPrimaryCtaLabel: string | null;
	heroPrimaryCtaUrl: string | null;
	highlights: LaunchPageHighlight[];
	footerNote: string | null;
	palette: {
		backgroundTop: string;
		backgroundBottom: string;
		cardBackground: string;
		accent: string;
		text: string;
	};
}

const DEFAULT_LAUNCH_PAGE_CONFIG: PublicLaunchPageConfig = {
	enabled: false,
	brandName: 'Wabi',
	headline: 'Welcome to Wabi',
	subheadline: 'Self-hosted community chat',
	logoUrl: '/wabi-logo.webp',
	heroImageUrl: null,
	heroTitle: null,
	heroBody: null,
	heroPrimaryCtaLabel: null,
	heroPrimaryCtaUrl: null,
	highlights: [],
	footerNote: null,
	palette: {
		backgroundTop: '#0f172a',
		backgroundBottom: '#0b1220',
		cardBackground: '#14141e',
		accent: '#5865f2',
		text: '#f8fafc'
	}
};

function sanitizeString(value: unknown, fallback: string, maxLength: number): string {
	if (typeof value !== 'string') return fallback;
	const cleaned = value.trim().slice(0, maxLength);
	return cleaned.length > 0 ? cleaned : fallback;
}

function sanitizeNullableString(value: unknown, maxLength: number): string | null {
	if (typeof value !== 'string') return null;
	const cleaned = value.trim().slice(0, maxLength);
	return cleaned.length > 0 ? cleaned : null;
}

function sanitizeHexColor(value: unknown, fallback: string): string {
	if (typeof value !== 'string') return fallback;
	const cleaned = value.trim();
	if (/^#[0-9a-fA-F]{6}$/.test(cleaned) || /^#[0-9a-fA-F]{8}$/.test(cleaned)) {
		return cleaned;
	}
	return fallback;
}

function sanitizeUrl(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const cleaned = value.trim();
	if (!cleaned) return null;
	if (cleaned.startsWith('/')) return cleaned;
	try {
		const parsed = new URL(cleaned);
		if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
			return cleaned;
		}
	} catch {
		return null;
	}
	return null;
}

function sanitizeHighlights(value: unknown): LaunchPageHighlight[] {
	if (!Array.isArray(value)) return [];
	return value
		.slice(0, 6)
		.map((entry) => {
			if (!entry || typeof entry !== 'object') return null;
			const maybeEntry = entry as Record<string, unknown>;
			const title = sanitizeNullableString(maybeEntry.title, 80);
			const description = sanitizeNullableString(maybeEntry.description, 220);
			if (!title || !description) return null;
			return { title, description };
		})
		.filter((entry): entry is LaunchPageHighlight => entry !== null);
}

function sanitizeLaunchPageConfig(raw: unknown): PublicLaunchPageConfig {
	if (!raw || typeof raw !== 'object') {
		return { ...DEFAULT_LAUNCH_PAGE_CONFIG };
	}

	const input = raw as Record<string, unknown>;
	const paletteRaw = (input.palette && typeof input.palette === 'object')
		? (input.palette as Record<string, unknown>)
		: {};

	const logoUrl = sanitizeUrl(input.logoUrl) || DEFAULT_LAUNCH_PAGE_CONFIG.logoUrl;

	return {
		enabled: Boolean(input.enabled),
		brandName: sanitizeString(input.brandName, DEFAULT_LAUNCH_PAGE_CONFIG.brandName, 64),
		headline: sanitizeString(input.headline, DEFAULT_LAUNCH_PAGE_CONFIG.headline, 120),
		subheadline: sanitizeString(input.subheadline, DEFAULT_LAUNCH_PAGE_CONFIG.subheadline, 220),
		logoUrl,
		heroImageUrl: sanitizeUrl(input.heroImageUrl),
		heroTitle: sanitizeNullableString(input.heroTitle, 120),
		heroBody: sanitizeNullableString(input.heroBody, 320),
		heroPrimaryCtaLabel: sanitizeNullableString(input.heroPrimaryCtaLabel, 48),
		heroPrimaryCtaUrl: sanitizeUrl(input.heroPrimaryCtaUrl),
		highlights: sanitizeHighlights(input.highlights),
		footerNote: sanitizeNullableString(input.footerNote, 220),
		palette: {
			backgroundTop: sanitizeHexColor(paletteRaw.backgroundTop, DEFAULT_LAUNCH_PAGE_CONFIG.palette.backgroundTop),
			backgroundBottom: sanitizeHexColor(paletteRaw.backgroundBottom, DEFAULT_LAUNCH_PAGE_CONFIG.palette.backgroundBottom),
			cardBackground: sanitizeHexColor(paletteRaw.cardBackground, DEFAULT_LAUNCH_PAGE_CONFIG.palette.cardBackground),
			accent: sanitizeHexColor(paletteRaw.accent, DEFAULT_LAUNCH_PAGE_CONFIG.palette.accent),
			text: sanitizeHexColor(paletteRaw.text, DEFAULT_LAUNCH_PAGE_CONFIG.palette.text)
		}
	};
}

function readLaunchPageConfigRaw(): unknown {
	const fromEnv = (process.env.WABI_LAUNCH_PAGE_JSON || '').trim();
	if (fromEnv) {
		return JSON.parse(fromEnv);
	}

	const configuredPath = (process.env.WABI_LAUNCH_PAGE_PATH || '').trim();
	const filePath = configuredPath ? resolve(configuredPath) : resolve(process.cwd(), 'data', 'launch-page.json');
	if (!existsSync(filePath)) return null;

	const content = readFileSync(filePath, 'utf-8').trim();
	if (!content) return null;
	return JSON.parse(content);
}

function getPublicLaunchPageConfig(): PublicLaunchPageConfig {
	try {
		const raw = readLaunchPageConfigRaw();
		return sanitizeLaunchPageConfig(raw);
	} catch (error) {
		console.error('[LaunchPage] Failed to load launch page config:', error);
		return { ...DEFAULT_LAUNCH_PAGE_CONFIG };
	}
}

export async function handleGetLaunchPageConfig(_req: IncomingMessage, res: ServerResponse): Promise<void> {
	const config = getPublicLaunchPageConfig();
	res.writeHead(200, {
		'Content-Type': 'application/json',
		'Cache-Control': 'public, max-age=30'
	});
	res.end(JSON.stringify(config));
}
