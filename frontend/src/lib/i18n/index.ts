import { addMessages, getLocaleFromNavigator, init, locale, _ } from 'svelte-i18n';
import { derived, get, writable } from 'svelte/store';
import { browser } from '$app/environment';
import en from './locales/en.json';
import es from './locales/es.json';

const LOCALE_STORAGE_KEY = 'wabi_locale';
const LEARNING_MODE_ENABLED_KEY = 'wabi_learning_mode_enabled';
const LEARNING_TARGET_PERCENT_KEY = 'wabi_learning_target_percent';

export const availableLocales = [
	{ code: 'en', label: 'English' },
	{ code: 'es', label: 'Espanol' }
] as const;

type LocaleCode = (typeof availableLocales)[number]['code'];
type I18nLeaf = string | I18nDictionary | Array<string | I18nDictionary>;
interface I18nDictionary {
	[key: string]: I18nLeaf;
}

type MessageTree = I18nDictionary;

const supportedLocales = new Set<LocaleCode>(availableLocales.map((localeOption) => localeOption.code));
const localeSourceMap: Record<LocaleCode, MessageTree> = { en, es };
let initialized = false;

const appLocaleStore = writable<LocaleCode>('en');
const learningModeEnabledStore = writable<boolean>(false);
const learningTargetPercentStore = writable<number>(100);

function normalizeLocale(input: string | null | undefined): LocaleCode {
	if (!input) return 'en';
	const base = input.toLowerCase().split('-')[0] as LocaleCode;
	return supportedLocales.has(base) ? base : 'en';
}

function clampPercent(input: number): number {
	const value = Number.isFinite(input) ? Math.floor(input) : 100;
	return Math.max(0, Math.min(100, value));
}

function normalizeLeaf(baseValue: I18nLeaf | undefined, targetValue: I18nLeaf | undefined): I18nLeaf {
	if (targetValue === undefined || targetValue === null) return (baseValue ?? '') as I18nLeaf;
	return targetValue;
}

function hashKey(input: string): number {
	let hash = 2166136261;
	for (let i = 0; i < input.length; i += 1) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function buildBlendedMessages(base: MessageTree, target: MessageTree, targetPercent: number, path = ''): MessageTree {
	const output: MessageTree = {};
	const keys = new Set<string>([...Object.keys(base), ...Object.keys(target)]);
	for (const key of keys) {
		const nextPath = path ? `${path}.${key}` : key;
		const baseValue = base[key] as I18nLeaf | undefined;
		const targetValue = target[key] as I18nLeaf | undefined;
		if (
			baseValue &&
			targetValue &&
			typeof baseValue === 'object' &&
			typeof targetValue === 'object' &&
			!Array.isArray(baseValue) &&
			!Array.isArray(targetValue)
		) {
			output[key] = buildBlendedMessages(baseValue as MessageTree, targetValue as MessageTree, targetPercent, nextPath);
			continue;
		}

		const targetRoll = hashKey(nextPath) % 100;
		output[key] = targetRoll < targetPercent ? normalizeLeaf(baseValue, targetValue) : normalizeLeaf(targetValue, baseValue);
	}
	return output;
}

function getInitialLocale(): LocaleCode {
	if (!browser) return 'en';
	const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
	if (stored) return normalizeLocale(stored);
	return normalizeLocale(getLocaleFromNavigator());
}

function getInitialLearningModeEnabled(): boolean {
	if (!browser) return false;
	return localStorage.getItem(LEARNING_MODE_ENABLED_KEY) === 'true';
}

function getInitialLearningTargetPercent(): number {
	if (!browser) return 100;
	return clampPercent(Number(localStorage.getItem(LEARNING_TARGET_PERCENT_KEY) || '100'));
}

function applyLocaleMessages(nextLocale: LocaleCode, learningEnabled: boolean, learningPercent: number): void {
	if (nextLocale === 'en') {
		addMessages('en', en);
		locale.set('en');
		return;
	}

	const target = localeSourceMap[nextLocale];
	if (learningEnabled && learningPercent < 100) {
		const blended = buildBlendedMessages(en as MessageTree, target as MessageTree, learningPercent);
		addMessages(nextLocale, blended);
	} else {
		addMessages(nextLocale, target);
	}
	locale.set(nextLocale);
}

export function initI18n(): void {
	if (initialized) return;
	addMessages('en', en);
	addMessages('es', es);

	const initialLocale = getInitialLocale();
	const initialLearningEnabled = getInitialLearningModeEnabled();
	const initialLearningPercent = getInitialLearningTargetPercent();

	appLocaleStore.set(initialLocale);
	learningModeEnabledStore.set(initialLearningEnabled);
	learningTargetPercentStore.set(initialLearningPercent);

	init({
		fallbackLocale: 'en',
		initialLocale
	});

	applyLocaleMessages(initialLocale, initialLearningEnabled, initialLearningPercent);

	if (browser) {
		appLocaleStore.subscribe((value) => {
			localStorage.setItem(LOCALE_STORAGE_KEY, normalizeLocale(value));
		});
		learningModeEnabledStore.subscribe((enabled) => {
			localStorage.setItem(LEARNING_MODE_ENABLED_KEY, enabled ? 'true' : 'false');
		});
		learningTargetPercentStore.subscribe((percent) => {
			localStorage.setItem(LEARNING_TARGET_PERCENT_KEY, String(clampPercent(percent)));
		});
	}

	initialized = true;
}

export function setAppLocale(nextLocale: string): void {
	const normalized = normalizeLocale(nextLocale);
	appLocaleStore.set(normalized);
	applyLocaleMessages(normalized, get(learningModeEnabledStore), get(learningTargetPercentStore));
}

export function setLearningModeEnabled(nextEnabled: boolean): void {
	learningModeEnabledStore.set(Boolean(nextEnabled));
	applyLocaleMessages(get(appLocaleStore), Boolean(nextEnabled), get(learningTargetPercentStore));
}

export function setLearningTargetPercent(nextPercent: number): void {
	const normalized = clampPercent(nextPercent);
	learningTargetPercentStore.set(normalized);
	applyLocaleMessages(get(appLocaleStore), get(learningModeEnabledStore), normalized);
}

export const currentLocale = derived(appLocaleStore, (value) => value);
export const learningModeEnabled = derived(learningModeEnabledStore, (value) => value);
export const learningTargetPercent = derived(learningTargetPercentStore, (value) => value);
export { _ };
