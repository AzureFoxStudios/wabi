import { describe, expect, test } from 'bun:test';
import {
	defaultTranslatorSettings,
	getTranslatorSettings,
	resolveTranslatorProviderUrl,
	sanitizeTranslatorProviderUrl,
	shouldAutoTranslateDetectedLanguage,
	type TranslatorSettings
} from './messageTranslator';

describe('Translator Assist settings', () => {
	test('new installs are off and point local mode at loopback', () => {
		const settings = defaultTranslatorSettings();
		expect(settings.mode).toBe('off');
		expect(settings.model).toBe('libretranslate-local');
		expect(settings.providerUrl).toBe('http://127.0.0.1:5000/translate');
		expect(settings.useProxy).toBe(false);
	});

	test('server-side/test environments receive the privacy-first defaults', () => {
		const settings = getTranslatorSettings();
		expect(settings.mode).toBe('off');
		expect(settings.useProxy).toBe(false);
	});

	test('there is no built-in remote endpoint for self-hosted mode', () => {
		expect(resolveTranslatorProviderUrl('libretranslate-self-hosted')).toBe('');
	});

	test('local mode refuses a remote provider URL', () => {
		expect(
			sanitizeTranslatorProviderUrl('https://translate.example.com/translate', 'libretranslate-local')
		).toBe('http://127.0.0.1:5000/translate');
	});

	test('self-hosted mode permits explicit http(s) endpoints only', () => {
		expect(
			sanitizeTranslatorProviderUrl(
				'https://translate.example.com/translate',
				'libretranslate-self-hosted'
			)
		).toBe('https://translate.example.com/translate');
		expect(
			sanitizeTranslatorProviderUrl('javascript:alert(1)', 'libretranslate-self-hosted')
		).toBe('');
	});
});

describe('automatic translation rules', () => {
	const autoSettings: TranslatorSettings = {
		...defaultTranslatorSettings(),
		mode: 'auto',
		targetLang: 'en',
		understoodLanguages: ['en', 'th']
	};

	test('skips languages the user understands', () => {
		expect(shouldAutoTranslateDetectedLanguage('en', autoSettings)).toBe(false);
		expect(shouldAutoTranslateDetectedLanguage('th', autoSettings)).toBe(false);
	});

	test('allows an unrecognized language in auto mode', () => {
		expect(shouldAutoTranslateDetectedLanguage('ja', autoSettings)).toBe(true);
	});

	test('never auto-translates while addon is not in auto mode', () => {
		expect(
			shouldAutoTranslateDetectedLanguage('ja', { ...autoSettings, mode: 'on-demand' })
		).toBe(false);
		expect(shouldAutoTranslateDetectedLanguage('ja', { ...autoSettings, mode: 'off' })).toBe(false);
	});
});
