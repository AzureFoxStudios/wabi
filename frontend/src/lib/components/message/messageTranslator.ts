import { getServerUrl } from '$lib/serverUrl';

export type TranslatorSettings = {
	model: string;
	providerUrl: string;
	sourceLang: string;
	targetLang: string;
	useProxy: boolean;
};

const TRANSLATOR_SETTINGS_KEY = 'addon.translator_assist.settings';

export function resolveTranslatorProviderUrl(model: string): string {
	if (model === 'libretranslate-public') return 'https://libretranslate.com/translate';
	return 'http://127.0.0.1:5000/translate';
}

export function getTranslatorSettings(): TranslatorSettings {
	if (typeof window === 'undefined') {
		return defaultTranslatorSettings();
	}
	try {
		const raw = localStorage.getItem(TRANSLATOR_SETTINGS_KEY);
		if (!raw) return defaultTranslatorSettings();

		const parsed = JSON.parse(raw);
		const model = typeof parsed?.model === 'string' && parsed.model.trim()
			? parsed.model.trim()
			: 'libretranslate-local';
		const resolvedProviderUrl = typeof parsed?.providerUrl === 'string' && parsed.providerUrl.trim()
			? parsed.providerUrl.trim()
			: resolveTranslatorProviderUrl(model);
		return {
			model,
			providerUrl: resolvedProviderUrl,
			sourceLang: 'auto',
			targetLang: typeof parsed?.targetLang === 'string' && parsed.targetLang.trim() ? parsed.targetLang.trim() : 'en',
			useProxy: parsed?.useProxy !== false
		};
	} catch {
		return defaultTranslatorSettings();
	}
}

function defaultTranslatorSettings(): TranslatorSettings {
	return {
		model: 'libretranslate-local',
		providerUrl: resolveTranslatorProviderUrl('libretranslate-local'),
		sourceLang: 'auto',
		targetLang: 'en',
		useProxy: true
	};
}

export async function requestTranslation(text: string, settings: TranslatorSettings): Promise<string> {
	if (settings.useProxy) {
		const response = await fetch(`${getServerUrl()}/api/plugins/runtime/translator-assist/translate`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				providerUrl: settings.providerUrl,
				text,
				sourceLang: settings.sourceLang,
				targetLang: settings.targetLang
			})
		});
		if (!response.ok) {
			const detail = await response.text();
			throw new Error(`Proxy translate failed (${response.status}) ${detail.slice(0, 180)}`);
		}
		const data = await response.json();
		const translated = typeof data?.translatedText === 'string' ? data.translatedText.trim() : '';
		if (!translated) throw new Error('No translated text returned');
		return translated;
	}

	const response = await fetch(settings.providerUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			q: text,
			source: settings.sourceLang,
			target: settings.targetLang,
			format: 'text'
		})
	});
	const raw = await response.text();
	if (!response.ok) {
		throw new Error(`Translator failed (${response.status}) ${raw.slice(0, 180)}`);
	}
	try {
		const parsed = JSON.parse(raw);
		const translated =
			typeof parsed?.translatedText === 'string' ? parsed.translatedText :
			typeof parsed?.translation === 'string' ? parsed.translation :
			typeof parsed?.data?.translatedText === 'string' ? parsed.data.translatedText :
			'';
		if (translated.trim()) return translated.trim();
	} catch {
		// Non-JSON response may already be translated text.
	}
	if (raw.trim()) return raw.trim();
	throw new Error('No translated text returned');
}
