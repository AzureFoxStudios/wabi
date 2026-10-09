/**
 * Language packs.
 *
 * English is the base language and is bundled. Every other language is a pack that is
 * downloaded only when someone chooses it, together with the typeface its script needs.
 * An addon (or operator) can add a language at runtime with `registerLanguagePack`
 * without touching core code.
 */

import type { addMessages } from 'svelte-i18n';

export type MessageTree = Parameters<typeof addMessages>[1];

/** Drives which typeface roles apply (`data-script` on <html>, see styles/typography.css). */
export type LanguageScript = 'latin' | 'thai';

export interface LanguagePack {
	code: string;
	/** Name of the language in that language, shown in the picker. */
	label: string;
	script: LanguageScript;
	/** Resolves the message tree. Dynamic imports keep packs out of the main bundle. */
	load: () => Promise<MessageTree>;
	/** Loads the faces the script needs (a no-op for Latin, which ships with the base). */
	loadFonts?: () => Promise<unknown>;
}

export const BASE_LOCALE = 'en';

const packs = new Map<string, LanguagePack>();

export function registerLanguagePack(pack: LanguagePack): void {
	packs.set(pack.code, pack);
}

export function getLanguagePack(code: string | null | undefined): LanguagePack | undefined {
	return code ? packs.get(code) : undefined;
}

export function listLanguagePacks(): LanguagePack[] {
	return [...packs.values()];
}

registerLanguagePack({
	code: 'es',
	label: 'Español',
	script: 'latin',
	load: async () => (await import('./locales/es.json')).default
});

registerLanguagePack({
	code: 'th',
	label: 'ไทย',
	script: 'thai',
	load: async () => (await import('./locales/th.json')).default,
	loadFonts: () =>
		Promise.all([
			import('@fontsource/noto-sans-thai/thai-400.css'),
			import('@fontsource/noto-sans-thai/thai-500.css'),
			import('@fontsource/noto-sans-thai/thai-700.css'),
			import('@fontsource/noto-serif-thai/thai-400.css'),
			import('@fontsource/noto-serif-thai/thai-600.css')
		])
});
