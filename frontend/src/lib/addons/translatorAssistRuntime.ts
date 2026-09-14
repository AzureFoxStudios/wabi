import {
	normalizeTranslatorLanguageCode,
	sanitizeTranslatorProviderUrl,
	type TranslationResult,
	type TranslatorSettings
} from '$lib/components/message/messageTranslator';

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_TRANSLATION_CACHE_ENTRIES = 400;
const translationCache = new Map<string, TranslationResult>();

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

	const providerUrl = sanitizeTranslatorProviderUrl(settings.providerUrl, settings.model);
	if (!providerUrl) {
		throw new Error(
			settings.model === 'libretranslate-self-hosted'
				? 'Set your self-hosted LibreTranslate URL in Add-ons settings'
				: 'Local LibreTranslate is not configured'
		);
	}

	const targetLang = normalizeTranslatorLanguageCode(settings.targetLang, 'en');
	const cacheKey = `${providerUrl}\n${targetLang}\n${input}`;
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
			target: targetLang,
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
 * Auto mode uses this before deciding whether a message needs translation.
 */
export async function requestLanguageDetection(
	text: string,
	settings: TranslatorSettings
): Promise<string | undefined> {
	const input = text.trim();
	if (!input) return undefined;
	const providerUrl = sanitizeTranslatorProviderUrl(settings.providerUrl, settings.model);
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
		return typeof language === 'string'
			? normalizeTranslatorLanguageCode(language, '') || undefined
			: undefined;
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
			detectedLanguage: detected
				? normalizeTranslatorLanguageCode(detected, '') || undefined
				: undefined
		};
	} catch {
		return { translatedText: raw.trim() };
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
		if (
			typeof DOMException !== 'undefined' &&
			error instanceof DOMException &&
			error.name === 'AbortError'
		) {
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
