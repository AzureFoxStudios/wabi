import { browser } from '$app/environment';
import { init, locale, addMessages, _ } from 'svelte-i18n';
import { derived, writable } from 'svelte/store';
import en from './locales/en.json';
import { BASE_LOCALE, getLanguagePack, listLanguagePacks } from './packs';

export { registerLanguagePack } from './packs';
export type { LanguagePack } from './packs';

const LOCALE_STORAGE_KEY = 'wabi_locale';

export type LocaleCode = string;

/** English first, then every registered pack. Read at call time so addon packs appear. */
export function getAvailableLocales(): { code: string; label: string }[] {
	return [{ code: BASE_LOCALE, label: 'English' }, ...listLanguagePacks().map(({ code, label }) => ({ code, label }))];
}

/** Snapshot kept for existing call sites; prefer getAvailableLocales() in new code. */
export const availableLocales = getAvailableLocales();

let initialized = false;
let switchGeneration = 0;

const appLocaleStore = writable<string>(BASE_LOCALE);

function normalizeLocale(input: string | null | undefined): string {
	return input && getLanguagePack(input) ? input : BASE_LOCALE;
}

function getInitialLocale(): string {
	if (!browser) return BASE_LOCALE;
	return normalizeLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
}

export function initI18n(): void {
	if (initialized) return;
	initialized = true;
	addMessages(BASE_LOCALE, en);
	// English renders immediately; a stored language replaces it as soon as its pack arrives.
	init({ fallbackLocale: BASE_LOCALE, initialLocale: BASE_LOCALE });
	appLocaleStore.set(BASE_LOCALE);
	void setAppLocale(getInitialLocale());

	if (browser) {
		appLocaleStore.subscribe((value) => {
			try {
				localStorage.setItem(LOCALE_STORAGE_KEY, normalizeLocale(value));
			} catch {
				/* storage unavailable: the choice just won't persist */
			}
		});
	}
}

function applyDocumentLanguage(code: string, script: string): void {
	if (!browser) return;
	document.documentElement.lang = code;
	document.documentElement.setAttribute('data-script', script);
}

/**
 * Switch language. Downloads the pack and its fonts first, so the UI never flashes
 * untranslated keys or the wrong typeface. An unknown or failing pack falls back to English.
 */
export async function setAppLocale(nextLocale: string): Promise<void> {
	const generation = ++switchGeneration;
	const pack = getLanguagePack(nextLocale);
	if (!pack) {
		locale.set(BASE_LOCALE);
		appLocaleStore.set(BASE_LOCALE);
		applyDocumentLanguage(BASE_LOCALE, 'latin');
		return;
	}
	try {
		const [messages] = await Promise.all([pack.load(), pack.loadFonts?.()]);
		if (generation !== switchGeneration) return; // a newer choice won
		addMessages(pack.code, messages);
		locale.set(pack.code);
		appLocaleStore.set(pack.code);
		applyDocumentLanguage(pack.code, pack.script);
	} catch (error) {
		console.warn(`[i18n] could not load language pack "${nextLocale}"`, error);
		if (generation !== switchGeneration) return;
		locale.set(BASE_LOCALE);
		appLocaleStore.set(BASE_LOCALE);
		applyDocumentLanguage(BASE_LOCALE, 'latin');
	}
}

export const currentLocale = derived(appLocaleStore, (value) => value);
export { _ };
