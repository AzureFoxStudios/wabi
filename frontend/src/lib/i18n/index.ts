import { browser } from '$app/environment';
import { init, locale, addMessages, _ } from 'svelte-i18n';
import { derived, writable } from 'svelte/store';
import en from './locales/en.json';
import es from './locales/es.json';

const LOCALE_STORAGE_KEY = 'wabi_locale';

export const availableLocales = [
	{ code: 'en', label: 'English' },
	{ code: 'es', label: 'Español' }
] as const;

export type LocaleCode = 'en' | 'es';

const localeSourceMap: Record<LocaleCode, typeof en> = { en, es };

let initialized = false;

const appLocaleStore = writable<LocaleCode>('en');

function normalizeLocale(input: string | null | undefined): LocaleCode {
	if (input === 'es') return 'es';
	return 'en';
}

function getInitialLocale(): LocaleCode {
	if (!browser) return 'en';
	return normalizeLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 100;
	return Math.min(100, Math.max(0, value));
}

export function initI18n(): void {
	if (initialized) return;
	addMessages('en', en);
	addMessages('es', es);

	const initialLocale = getInitialLocale();

	appLocaleStore.set(initialLocale);

	init({
		fallbackLocale: 'en',
		initialLocale
	});

	applyLocaleMessages(initialLocale);

	if (browser) {
		appLocaleStore.subscribe((value) => {
			localStorage.setItem(LOCALE_STORAGE_KEY, normalizeLocale(value));
		});
	}

	initialized = true;
}

function applyLocaleMessages(nextLocale: LocaleCode): void {
	if (nextLocale === 'en') {
		addMessages('en', en);
		locale.set('en');
		return;
	}
	addMessages(nextLocale, localeSourceMap[nextLocale]);
	locale.set(nextLocale);
}

export function setAppLocale(nextLocale: string): void {
	const normalized = normalizeLocale(nextLocale);
	appLocaleStore.set(normalized);
	applyLocaleMessages(normalized);
}

export const currentLocale = derived(appLocaleStore, (value) => value);
export { _ };
