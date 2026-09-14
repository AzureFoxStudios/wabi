import {
	getTranslatorSettings,
	saveTranslatorSettings,
	type TranslatorSettings
} from '$lib/components/message/messageTranslator';

/**
 * Translator Assist is intentionally frontend-only.
 *
 * Wabi ships no translation model and no cloud account/API dependency. The
 * addon talks directly to a translator selected by the user (localhost by
 * default, or an explicitly configured self-hosted LibreTranslate endpoint).
 */
export const translatorAssistAddon = {
	id: 'translator-assist',
	name: 'Translator Assist',
	version: '0.2.0',
	privacy: 'client-direct',
	providers: ['libretranslate-local', 'libretranslate-self-hosted'] as const
};

export function getConfig(): TranslatorSettings {
	return getTranslatorSettings();
}

export async function onInit(): Promise<void> {
	// No service, model, worker, or network connection is started merely by
	// loading the addon. Translation requests remain user-driven.
}

export async function onDisable(): Promise<void> {
	const settings = getTranslatorSettings();
	if (settings.mode === 'off') return;
	saveTranslatorSettings({ ...settings, mode: 'off' });
}
