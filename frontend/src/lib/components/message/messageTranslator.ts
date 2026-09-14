export type TranslatorMode = 'off' | 'on-demand' | 'auto';
export type TranslatorModelId = 'libretranslate-local' | 'libretranslate-self-hosted';

export type TranslatorSettings = {
	mode: TranslatorMode;
	model: TranslatorModelId;
	providerUrl: string;
	sourceLang: string;
	targetLang: string;
	understoodLanguages: string[];
	/** Legacy compatibility only. Translation no longer uses the Wabi server as a proxy. */
	useProxy: false;
};

export type TranslationResult = {
	translatedText: string;
	detectedLanguage?: string;
};

const TRANSLATOR_SETTINGS_KEY = 'addon.translator_assist.settings';
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_TRANSLATION_CACHE_ENTRIES = 400;
const translationCache = new Map<string, TranslationResult>();

export function resolveTranslatorProviderUrl(model: string): string {
	if (model === 'libretranslate-local') return 'http://127.0.0.1:5000/translate';
	return '';
}

export function getTranslatorSettings(): TranslatorSettings {
	if (typeof window === 'undefined') return defaultTranslatorSettings();

	try {
		const raw = localStorage.getItem(TRANSLATOR_SETTINGS_KEY);
		if (!raw) return defaultTranslatorSettings();

		const parsed = JSON.parse(raw);
		// Privacy migration: the old public LibreTranslate preset is not retained as a
		// silent cloud/default provider. Existing public-provider users fall back to local
		// and may explicitly configure a self-hosted endpoint again in Add-ons settings.
		const model: TranslatorModelId = parsed?.model === 'libretranslate-self-hosted'
			? 'libretranslate-self-hosted'
			: 'libretranslate-local';
		const mode: TranslatorMode =
			parsed?.mode === 'auto' || parsed?.mode === 'on-demand' || parsed?.mode === 'off'
				? parsed.mode
				: 'on-demand';
		const providerUrl = sanitizeProviderUrl(
			typeof parsed?.providerUrl === 'string' ? parsed.providerUrl : '',
			model
		);
		const targetLang = normalizeLanguageCode(parsed?.targetLang, 'en');
		const understoodLanguages = normalizeLanguageList(parsed?.understoodLanguages, [targetLang]);

		return {
			mode,
			model,
			providerUrl,
			sourceLang: 'auto',
			targetLang,
			understoodLanguages,
			useProxy: false
		};
	} catch {
		return defaultTranslatorSettings();
	}
}

export function defaultTranslatorSettings(): TranslatorSettings {
	return {
		mode: 'off',
		model: 'libretranslate-local',
		providerUrl: resolveTranslatorProviderUrl('libretranslate-local'),
		sourceLang: 'auto',
		targetLang: 'en',
		understoodLanguages: ['en'],
		useProxy: false
	};
}

export function saveTranslatorSettings(settings: TranslatorSettings): void {
	if (typeof window === 'undefined') return;
	const model: TranslatorModelId = settings.model === 'libretranslate-self-hosted'
		? 'libretranslate-self-hosted'
		: 'libretranslate-local';
	const targetLang = normalizeLanguageCode(settings.targetLang, 'en');
	const normalized: TranslatorSettings = {
		mode: settings.mode === 'auto' || settings.mode === 'on-demand' ? settings.mode : 'off',
		model,
		providerUrl: sanitizeProviderUrl(settings.providerUrl, model),
		sourceLang: 'auto',
		targetLang,
		understoodLanguages: normalizeLanguageList(settings.understoodLanguages, [targetLang]),
		useProxy: false
	};
	localStorage.setItem(TRANSLATOR_SETTINGS_KEY, JSON.stringify(normalized));
}

export function isTranslatorEnabled(settings = getTranslatorSettings()): boolean {
	return settings.mode !== 'off' && Boolean(settings.providerUrl);
}

export function shouldAutoTranslateDetectedLanguage(
	detectedLanguage: string | undefined,
	settings = getTranslatorSettings()
): boolean {
	if (settings.mode !== 'auto') return false;
	const detected = normalizeLanguageCode(detectedLanguage, '');
	if (!detected) return false;
	const understood = new Set(settings.understoodLanguages.map((code) => code.toLowerCase()));
	return !understood.has(detected.toLowerCase());
}

export async function requestTranslation(
	text: string,
	settings: TranslatorSettings
): Promise<string> {
	const result = await requestTranslationDetailed(text, settings);
	return result.translatedText;
}

export async function requestTranslationDetailed(
	text: string,
	settings: TranslatorSettings
): Promise<TranslationResult> {
	const input = text.trim();
	if (!input) throw new Error('Nothing to translate');
	if (settings.mode === 'off') throw new Error('Translator Assist is disabled');

	const providerUrl = sanitizeProviderUrl(settings.providerUrl, settings.model);
	if (!providerUrl) {
		throw new Error(
			settings.model === 'libretranslate-self-hosted'
				? 'Set your self-hosted LibreTranslate URL in Add-ons settings'
				: 'Local LibreTranslate is not configured'
		);
	}

	const cacheKey = `${providerUrl}\n${settings.targetLang}\n${input}`;
	const cached = translationCache.get(cacheKey);
	if (cached) return cached;

	const response = await fetchWithTimeout(providerUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'omit',
		referrerPolicy: 'no-referrer',
		body: JSON.stringify({
			q: input,
			source: settings.sourceLang || 'auto',
			target: normalizeLanguageCode(settings.targetLang, 'en'),
			format: 'text'
		})
	});
	const raw = await response.text();
	if (!response.ok) {
		throw new Error(`Translator failed (${response.status}) ${raw.slice(0, 180)}`);
	}

	const result = parseTranslationResponse(raw);
	if (!result.translatedText) throw new Error('No translated text returned');
	rememberTranslation(cacheKey, result);
	return result;
}

/**
 * Detect language directly against the selected LibreTranslate instance.
 * This exists for Auto mode; on-demand translation does not need a separate
 * detection request because LibreTranslate accepts source="auto".
 */
export async function requestLanguageDetection(
	text: string,
	settings: TranslatorSettings
): Promise<string | undefined> {
	const input = text.trim();
	if (!input) return undefined;
	const providerUrl = sanitizeProviderUrl(settings.providerUrl, settings.model);
	if (!providerUrl) return undefined;
	const detectUrl = resolveDetectUrl(providerUrl);
	const response = await fetchWithTimeout(detectUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'omit',
		referrerPolicy: 'no-referrer',
		body: JSON.stringify({ q: input })
	});
	if (!response.ok) return undefined;
	const raw = await response.text();
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
		const language = parsed[0]?.language;
		return typeof language === 'string' ? normalizeLanguageCode(language, '') || undefined : undefined;
	} catch {
		return undefined;
	}
}

export function clearTranslationCache(): void {
	translationCache.clear();
}

function parseTranslationResponse(raw: string): TranslationResult {
	try {
		const parsed = JSON.parse(raw);
		const translatedText =
			typeof parsed?.translatedText === 'string' ? parsed.translatedText :
			typeof parsed?.translation === 'string' ? parsed.translation :
			typeof parsed?.data?.translatedText === 'string' ? parsed.data.translatedText :
			'';
		const detected =
			typeof parsed?.detectedLanguage?.language === 'string' ? parsed.detectedLanguage.language :
			typeof parsed?.detectedLanguage === 'string' ? parsed.detectedLanguage :
			undefined;
		return {
			translatedText: translatedText.trim(),
			detectedLanguage: detected ? normalizeLanguageCode(detected, '') || undefined : undefined
		};
	} catch {
		return { translatedText: raw.trim() };
	}
}

function normalizeLanguageList(value: unknown, fallback: string[]): string[] {
	const source = Array.isArray(value)
		? value
		: typeof value === 'string'
			? value.split(',')
			: fallback;
	const normalized = source
		.map((entry) => normalizeLanguageCode(entry, ''))
		.filter(Boolean);
	return [...new Set(normalized.length > 0 ? normalized : fallback)];
}

function normalizeLanguageCode(value: unknown, fallback: string): string {
	if (typeof value !== 'string') return fallback;
	const trimmed = value.trim().toLowerCase();
	return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(trimmed) ? trimmed : fallback;
}

function sanitizeProviderUrl(raw: string, model: TranslatorModelId): string {
	const candidate = raw.trim() || resolveTranslatorProviderUrl(model);
	if (!candidate) return '';
	try {
		const url = new URL(candidate);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
		if (model === 'libretranslate-local') {
			const host = url.hostname.toLowerCase();
			if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
				return resolveTranslatorProviderUrl('libretranslate-local');
			}
		}
		return url.toString();
	} catch {
		return resolveTranslatorProviderUrl(model);
	}
}

function resolveDetectUrl(translateUrl: string): string {
	const url = new URL(translateUrl);
	url.pathname = url.pathname.replace(/\/translate\/?$/, '/detect');
	if (!url.pathname.endsWith('/detect')) {
		url.pathname = `${url.pathname.replace(/\/$/, '')}/detect`;
	}
	return url.toString();
}

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		return await fetch(input, { ...init, signal: controller.signal });
	} catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError') {
			throw new Error('Translator request timed out');
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

function rememberTranslation(key: string, result: TranslationResult): void {
	if (translationCache.has(key)) translationCache.delete(key);
	translationCache.set(key, result);
	while (translationCache.size > MAX_TRANSLATION_CACHE_ENTRIES) {
		const oldest = translationCache.keys().next().value;
		if (typeof oldest !== 'string') break;
		translationCache.delete(oldest);
	}
}
