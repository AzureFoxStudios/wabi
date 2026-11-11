import { describe, expect, test } from 'bun:test';
import en from '../i18n/locales/en.json';
import es from '../i18n/locales/es.json';
import th from '../i18n/locales/th.json';

// Timed retention hides a message; it does not erase the stored record
// (root AGENTS.md rule 13). Every language has to say so, not only English.
describe('timed-retention tooltip in every language', () => {
	const cases: Array<[string, { privacy: { retention: { title_duration: string } } }, RegExp]> = [
		['en', en, /server/i],
		['es', es, /servidor/i],
		['th', th, /เซิร์ฟเวอร์/],
	];
	for (const [locale, pack, server] of cases) {
		test(`${locale} says the record stays on the server`, () => {
			const text = pack.privacy.retention.title_duration;
			expect(text).toContain('{duration}');
			expect(server.test(text)).toBe(true);
		});
	}
});
