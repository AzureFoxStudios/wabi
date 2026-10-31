import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { THEMES } from './themes';
import { characterFor, deriveRoles } from './roles';
import {
	BASE_SERIF,
	CHARACTER_METRICS,
	PIXEL_SERIF,
	themeCharacterWord,
	themeChoiceAction,
	themePickerGroups,
	themePreviewAttributes,
	themePreviewStyle
} from './themePicker';

/** Removes CSS comments, repeating one pattern until nothing changes (a single pass can leave a comment behind). */
function stripComments(css: string): string {
	let previous: string;
	let next = css;
	do {
		previous = next;
		next = previous.replace(/\/\*[^]*?\*\//g, ' ');
	} while (next !== previous);
	return next;
}

const characterCss = stripComments(readFileSync(fileURLToPath(new URL('../../styles/character.css', import.meta.url)), 'utf8'));
const typographyCss = stripComments(readFileSync(fileURLToPath(new URL('../../styles/typography.css', import.meta.url)), 'utf8'));

/** The declarations of the first rule whose selector list contains `selector` exactly. */
function ruleBody(css: string, selector: string): string {
	let at = 0;
	while (at < css.length) {
		const open = css.indexOf('{', at);
		if (open < 0) break;
		const close = css.indexOf('}', open);
		const selectors = css.slice(at, open).split(',').map((part) => part.trim());
		if (selectors.includes(selector)) return css.slice(open + 1, close);
		at = close + 1;
	}
	return '';
}

function declared(body: string, property: string): string | null {
	for (const line of body.split(';')) {
		const [name, ...value] = line.split(':');
		if (name.trim() === property) return value.join(':').trim();
	}
	return null;
}

describe('theme picker groups', () => {
	const groups = themePickerGroups(THEMES);

	test('the first view is Calm then Accessible & expressive, with High Contrast and Joker visible', () => {
		expect(groups.map((group) => group.id)).toEqual(['calm', 'expressive', 'more']);
		expect(groups[0].themes.map((theme) => theme.id)).toEqual(['wabi-ink', 'light', 'dark', 'blue', 'forest']);
		expect(groups[1].themes.map((theme) => theme.id)).toEqual(['high-contrast', 'joker', 'sakura', 'ember', 'space']);
	});

	test('every theme appears exactly once across the groups', () => {
		const ids = groups.flatMap((group) => group.themes.map((theme) => theme.id));
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.sort()).toEqual(Object.keys(THEMES).sort());
	});

	test('unknown ids in the first-view lists are skipped, not rendered as holes', () => {
		const partial = { 'wabi-ink': THEMES['wabi-ink'], joker: THEMES.joker };
		const [calm, expressive, more] = themePickerGroups(partial);
		expect(calm.themes.map((theme) => theme.id)).toEqual(['wabi-ink']);
		expect(expressive.themes.map((theme) => theme.id)).toEqual(['joker']);
		expect(more.themes).toEqual([]);
	});
});

describe('theme character word', () => {
	test('names light, dark, pixel and motion themes truthfully', () => {
		expect(themeCharacterWord(THEMES['wabi-ink'])).toBe('dark');
		expect(themeCharacterWord(THEMES.light)).toBe('light');
		expect(themeCharacterWord(THEMES.joker)).toBe('pixel');
		expect(themeCharacterWord(THEMES.space)).toBe('motion');
		expect(themeCharacterWord(THEMES['high-contrast'])).toBe('');
		// A faint ambient (Midnight Violet's constellations) is still a still theme.
		expect(themeCharacterWord(THEMES.dark)).toBe('dark');
	});
});

describe('theme previews draw each theme with its own roles', () => {
	test('the inline style carries every role of that theme, not the page theme', () => {
		for (const theme of Object.values(THEMES)) {
			const style = themePreviewStyle(theme);
			for (const [name, value] of Object.entries(deriveRoles(theme))) {
				expect(style).toContain(`${name}: ${value}`);
			}
		}
	});

	test('Daylight previews its own crimson seal and burnt accent, distinct from Wabi Ink', () => {
		const daylight = deriveRoles(THEMES.light);
		const ink = deriveRoles(THEMES['wabi-ink']);
		expect(themePreviewStyle(THEMES.light)).toContain(`--w-seal: ${daylight['--w-seal']}`);
		expect(daylight['--w-seal']).not.toBe(ink['--w-seal']);
		expect(daylight['--w-sig']).not.toBe(ink['--w-sig']);
	});

	test('the pixel theme previews in the pixel face; others in the base serif, even on a pixel page', () => {
		expect(themePreviewStyle(THEMES.joker)).toContain(`--w-serif: ${PIXEL_SERIF}`);
		for (const theme of Object.values(THEMES)) {
			if (characterFor(theme) !== 'pixel') expect(themePreviewStyle(theme)).toContain(`--w-serif: ${BASE_SERIF}`);
		}
		expect(declared(ruleBody(typographyCss, ':root'), '--w-serif')).toBe(BASE_SERIF);
	});

	test('corner scale and edge width follow the character', () => {
		expect(themePreviewStyle(THEMES['wabi-ink'])).toContain('--tp-rs: 0.7');
		expect(themePreviewStyle(THEMES['high-contrast'])).toContain('--tp-rs: 0.5');
		expect(themePreviewStyle(THEMES.joker)).toContain('--tp-rs: 0.2; --tp-bw: 2px');
		expect(themePreviewStyle(THEMES.light)).toContain('--tp-rs: 1; --tp-bw: 1px');
	});

	test('preview attributes scope data-theme, data-char and data-mode to the preview', () => {
		expect(themePreviewAttributes(THEMES.joker)).toEqual({ 'data-theme': 'joker', 'data-char': 'pixel', 'data-mode': 'dark' });
		expect(themePreviewAttributes(THEMES.light)).toEqual({ 'data-theme': 'light', 'data-char': 'soft', 'data-mode': 'light' });
		for (const theme of Object.values(THEMES)) expect(themePreviewAttributes(theme)['data-char']).toBe(characterFor(theme));
	});

	test('character metrics match styles/character.css', () => {
		const soft = ruleBody(characterCss, ":root[data-char='soft']");
		expect(Number(declared(soft, '--w-rs'))).toBe(CHARACTER_METRICS.soft.rs);
		expect(declared(soft, '--w-bw')).toBe(`${CHARACTER_METRICS.soft.bw}px`);
		for (const character of ['ink', 'contrast', 'pixel'] as const) {
			const body = ruleBody(characterCss, `:root[data-char='${character}']`);
			expect(Number(declared(body, '--w-rs'))).toBe(CHARACTER_METRICS[character].rs);
			expect(declared(body, '--w-bw') ?? `${CHARACTER_METRICS.soft.bw}px`).toBe(`${CHARACTER_METRICS[character].bw}px`);
		}
		expect(declared(ruleBody(characterCss, ":root[data-char='pixel']"), '--w-serif')).toBe(PIXEL_SERIF);
	});
});

describe('choosing a theme', () => {
	test('a new theme applies; the shown theme does nothing while its save is fine', () => {
		expect(themeChoiceAction('light', 'wabi-ink', false)).toBe('apply');
		expect(themeChoiceAction('light', 'wabi-ink', true)).toBe('apply');
		expect(themeChoiceAction('wabi-ink', 'wabi-ink', false)).toBe('none');
	});

	test('after a failed save, choosing the shown theme again retries the save', () => {
		expect(themeChoiceAction('wabi-ink', 'wabi-ink', true)).toBe('retry');
	});
});
