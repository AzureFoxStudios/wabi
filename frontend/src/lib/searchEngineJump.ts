import { browser } from '$app/environment';

export type SearchEngineProvider =
	| 'google'
	| 'duckduckgo'
	| 'bing'
	| 'brave'
	| 'startpage'
	| 'custom';

const SEARCH_ENGINE_PROVIDER_KEY = 'wabi.searchEngineJump.provider';
const SEARCH_ENGINE_CUSTOM_TEMPLATE_KEY = 'wabi.searchEngineJump.customTemplate';
const DEFAULT_PROVIDER: SearchEngineProvider = 'brave';
const DEFAULT_CUSTOM_TEMPLATE = 'https://search.brave.com/search?q={query}';

function isProvider(value: string | null): value is SearchEngineProvider {
	return (
		value === 'google' ||
		value === 'duckduckgo' ||
		value === 'bing' ||
		value === 'brave' ||
		value === 'startpage' ||
		value === 'custom'
	);
}

function normalizeTemplate(value: string): string {
	return value.trim();
}

function isValidTemplate(value: string): boolean {
	const template = normalizeTemplate(value);
	if (!template || !template.includes('{query}')) return false;
	try {
		const sample = template.split('{query}').join('wabi');
		const parsed = new URL(sample);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

export function getSearchEngineProvider(): SearchEngineProvider {
	if (!browser) return DEFAULT_PROVIDER;
	try {
		const raw = localStorage.getItem(SEARCH_ENGINE_PROVIDER_KEY);
		return isProvider(raw) ? raw : DEFAULT_PROVIDER;
	} catch {
		return DEFAULT_PROVIDER;
	}
}

export function getCustomSearchEngineTemplate(): string {
	if (!browser) return DEFAULT_CUSTOM_TEMPLATE;
	try {
		const raw = localStorage.getItem(SEARCH_ENGINE_CUSTOM_TEMPLATE_KEY) || '';
		return isValidTemplate(raw) ? normalizeTemplate(raw) : DEFAULT_CUSTOM_TEMPLATE;
	} catch {
		return DEFAULT_CUSTOM_TEMPLATE;
	}
}

export function setCustomSearchEngineTemplate(template: string): boolean {
	if (!browser) return false;
	if (!isValidTemplate(template)) return false;
	try {
		localStorage.setItem(
			SEARCH_ENGINE_CUSTOM_TEMPLATE_KEY,
			normalizeTemplate(template)
		);
		return true;
	} catch {
		return false;
	}
}

export function setSearchEngineProvider(provider: SearchEngineProvider): void {
	if (!browser) return;
	try {
		localStorage.setItem(SEARCH_ENGINE_PROVIDER_KEY, provider);
	} catch {
		// best effort
	}
}

export function buildExternalSearchUrl(
	query: string,
	provider: SearchEngineProvider,
	customTemplate = getCustomSearchEngineTemplate()
): string {
	const encoded = encodeURIComponent(query.trim());
	if (provider === 'custom') {
		const template = isValidTemplate(customTemplate)
			? normalizeTemplate(customTemplate)
			: DEFAULT_CUSTOM_TEMPLATE;
		return template.split('{query}').join(encoded);
	}
	if (provider === 'google') {
		return `https://www.google.com/search?q=${encoded}`;
	}
	if (provider === 'bing') {
		return `https://www.bing.com/search?q=${encoded}`;
	}
	if (provider === 'brave') {
		return `https://search.brave.com/search?q=${encoded}`;
	}
	if (provider === 'startpage') {
		return `https://www.startpage.com/sp/search?query=${encoded}`;
	}
	return `https://duckduckgo.com/?q=${encoded}`;
}

export function openExternalSearch(
	query: string,
	provider: SearchEngineProvider = getSearchEngineProvider(),
	customTemplate = getCustomSearchEngineTemplate()
): boolean {
	if (!browser) return false;
	const trimmed = query.trim();
	if (!trimmed) return false;
	window.open(
		buildExternalSearchUrl(trimmed, provider, customTemplate),
		'_blank',
		'noopener,noreferrer'
	);
	return true;
}
