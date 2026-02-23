import { addMessages, getLocaleFromNavigator, init, locale, _ } from 'svelte-i18n';
import { browser } from '$app/environment';
import en from './locales/en.json';
import es from './locales/es.json';

const LOCALE_STORAGE_KEY = 'wabi_locale';

export const availableLocales = [
	{ code: 'en', label: 'English' },
	{ code: 'es', label: 'Espanol' }
] as const;

type LocaleCode = (typeof availableLocales)[number]['code'];

const supportedLocales = new Set<LocaleCode>(availableLocales.map((localeOption) => localeOption.code));

let initialized = false;

function normalizeLocale(input: string | null | undefined): LocaleCode {
	if (!input) return 'en';
	const base = input.toLowerCase().split('-')[0] as LocaleCode;
	return supportedLocales.has(base) ? base : 'en';
}

function getInitialLocale(): LocaleCode {
	if (!browser) return 'en';
	const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
	if (stored) return normalizeLocale(stored);
	return normalizeLocale(getLocaleFromNavigator());
}

export function initI18n(): void {
	if (initialized) return;
	addMessages('en', en);
	addMessages('es', es);
	init({
		fallbackLocale: 'en',
		initialLocale: getInitialLocale()
	});
	if (browser) {
		locale.subscribe((value) => {
			if (!value) return;
			localStorage.setItem(LOCALE_STORAGE_KEY, normalizeLocale(value));
		});
	}
	initialized = true;
}

export function setAppLocale(nextLocale: string): void {
	locale.set(normalizeLocale(nextLocale));
}

export const currentLocale = locale;
export { _ };
