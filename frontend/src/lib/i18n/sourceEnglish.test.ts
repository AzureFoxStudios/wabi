import { describe, expect, test } from 'bun:test';
import { englishFor, inEnglish } from './sourceEnglish';

const KEY = 'locality.scope_device';
const WORDS = englishFor(KEY)!;

describe('inEnglish', () => {
	test('the catalog has the string the other cases rely on', () => {
		expect(WORDS).toBe('Saved on this device · not shared');
	});
	test('markup text becomes the words', () => {
		expect(inEnglish(`<p>{$_('${KEY}')}</p>`)).toBe(`<p>${WORDS}</p>`);
	});
	test('an attribute value becomes a quoted attribute', () => {
		expect(inEnglish(`<button title={$_('${KEY}')}>`)).toBe(`<button title="${WORDS}">`);
	});
	test('script becomes a string literal, with arguments consumed', () => {
		expect(inEnglish(`const a = $_('${KEY}'); const b = $_("${KEY}", { values: { n: f(1) } });`)).toBe(`const a = '${WORDS}'; const b = '${WORDS}';`);
	});
	test('unknown keys and plain text are left alone', () => {
		const text = `{$_('no.such.key')} and $_(dynamic)`;
		expect(inEnglish(text)).toBe(text);
	});
});
