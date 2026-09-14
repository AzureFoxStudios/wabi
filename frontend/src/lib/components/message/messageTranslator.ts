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

export type TranslatorProbeResult = {
	ok: boolean;
	message: string;
	languages?: string[];
};

export const TRANSLATOR_SETTINGS_CHANGED_EVENT = 'wabi:translator-settings-changed';
const TRANSLATOR_SETTINGS_KEY = 'addon.translator_assist.settings';

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
		const providerUrl = sanitizeTranslatorProviderUrl(
			typeof parsed?.providerUrl === 'string' ? parsed.providerUrl : '',
			model
		);
		const targetLang = normalizeTranslatorLanguageCode(parsed?.targetLang, 'en');
		const understoodLanguages = normalizeUnderstoodLanguages(parsed?.understoodLanguages, targetLang);

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
	const targetLang = normalizeTranslatorLanguageCode(settings.targetLang, 'en');
	const normalized: TranslatorSettings = {
		mode: settings.mode === 'auto' || settings.mode === 'on-demand' ? settings.mode : 'off',
		model,
		providerUrl: sanitizeTranslatorProviderUrl(settings.providerUrl, model),
		sourceLang: 'auto',
		targetLang,
		understoodLanguages: normalizeUnderstoodLanguages(settings.understoodLanguages, targetLang),
		useProxy: false
	};
	localStorage.setItem(TRANSLATOR_SETTINGS_KEY, JSON.stringify(normalized));
	window.dispatchEvent(
		new CustomEvent(TRANSLATOR_SETTINGS_CHANGED_EVENT, { detail: normalized })
	);
}

export function isTranslatorEnabled(settings = getTranslatorSettings()): boolean {
	return settings.mode !== 'off' && Boolean(settings.providerUrl);
}

export function shouldAutoTranslateDetectedLanguage(
	detectedLanguage: string | undefined,
	settings = getTranslatorSettings()
): boolean {
	if (settings.mode !== 'auto') return false;
	const detected = normalizeTranslatorLanguageCode(detectedLanguage, '');
	if (!detected) return false;
	const understood = new Set(settings.understoodLanguages.map((code) => code.toLowerCase()));
	understood.add(normalizeTranslatorLanguageCode(settings.targetLang, 'en'));
	return !understood.has(detected.toLowerCase());
}

/**
 * Thin lazy boundary used by core chat. The translation runtime (networking,
 * cache, and future WASM/model engine) is code-split and loaded only after a
 * user actually requests translation.
 */
export async function requestTranslation(
	text: string,
	settings: TranslatorSettings
): Promise<string> {
	const runtime = await import('$lib/addons/translatorAssistRuntime');
	return runtime.requestTranslation(text, settings);
}

export async function requestTranslationDetailed(
	text: string,
	settings: TranslatorSettings
): Promise<TranslationResult> {
	const runtime = await import('$lib/addons/translatorAssistRuntime');
	return runtime.requestTranslationDetailed(text, settings);
}

export async function requestLanguageDetection(
	text: string,
	settings: TranslatorSettings
): Promise<string | undefined> {
	const runtime = await import('$lib/addons/translatorAssistRuntime');
	return runtime.requestLanguageDetection(text, settings);
}

export async function probeTranslatorProvider(
	settings: TranslatorSettings
): Promise<TranslatorProbeResult> {
	const runtime = await import('$lib/addons/translatorAssistRuntime');
	return runtime.probeTranslatorProvider(settings);
}

export async function clearTranslationCache(): Promise<void> {
	const runtime = await import('$lib/addons/translatorAssistRuntime');
	runtime.clearTranslationCache();
}

function normalizeLanguageList(value: unknown, fallback: string[]): string[] {
	const source = Array.isArray(value)
		? value
		: typeof value === 'string'
			? value.split(',')
			: fallback;
	const normalized = source
		.map((entry) => normalizeTranslatorLanguageCode(entry, ''))
		.filter(Boolean);
	return [...new Set(normalized.length > 0 ? normalized : fallback)];
}

function normalizeUnderstoodLanguages(value: unknown, targetLang: string): string[] {
	return [...new Set([...normalizeLanguageList(value, [targetLang]), targetLang])];
}

export function normalizeTranslatorLanguageCode(value: unknown, fallback: string): string {
	if (typeof value !== 'string') return fallback;
	const trimmed = value.trim().toLowerCase();
	return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(trimmed) ? trimmed : fallback;
}

export function sanitizeTranslatorProviderUrl(raw: string, model: TranslatorModelId): string {
	if (model === 'libretranslate-local') {
		// Local mode is intentionally not a generic localhost fetcher. Users who
		// need another endpoint should select the explicit self-hosted provider.
		return resolveTranslatorProviderUrl('libretranslate-local');
	}

	const candidate = raw.trim();
	if (!candidate) return '';
	try {
		const url = new URL(candidate);
		if (url.protocol !== 'https:') return '';
		if (url.username || url.password) return '';
		url.hash = '';
		return url.toString();
	} catch {
		return '';
	}
}
