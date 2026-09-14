import { describe, expect, test } from 'bun:test';
import { isAutoTranslationCandidateText } from '$lib/addons/translatorAuto';
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

	test('local mode is pinned to the Wabi loopback translator endpoint', () => {
		expect(
			sanitizeTranslatorProviderUrl('https://translate.example.com/translate', 'libretranslate-local')
		).toBe('http://127.0.0.1:5000/translate');
		expect(
			sanitizeTranslatorProviderUrl('http://localhost:9999/not-a-translator', 'libretranslate-local')
		).toBe('http://127.0.0.1:5000/translate');
	});

	test('self-hosted mode requires explicit HTTPS without embedded credentials', () => {
		expect(
			sanitizeTranslatorProviderUrl(
				'https://translate.example.com/translate',
				'libretranslate-self-hosted'
			)
		).toBe('https://translate.example.com/translate');
		expect(
			sanitizeTranslatorProviderUrl(
				'http://translate.example.com/translate',
				'libretranslate-self-hosted'
			)
		).toBe('');
		expect(
			sanitizeTranslatorProviderUrl(
				'https://user:secret@translate.example.com/translate',
				'libretranslate-self-hosted'
			)
		).toBe('');
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

	test('candidate filter skips commands, code-only, URLs, and mention-only posts', () => {
		expect(isAutoTranslationCandidateText('/ban @someone')).toBe(false);
		expect(isAutoTranslationCandidateText('```const x = 1;```')).toBe(false);
		expect(isAutoTranslationCandidateText('https://example.com/foo')).toBe(false);
		expect(isAutoTranslationCandidateText('@someone')).toBe(false);
	});

	test('candidate filter accepts normal multilingual chat', () => {
		expect(isAutoTranslationCandidateText('明日の会議は午後3時からです。')).toBe(true);
		expect(isAutoTranslationCandidateText('พรุ่งนี้เจอกันตอนบ่ายสามนะ')).toBe(true);
		expect(isAutoTranslationCandidateText('😂 hello there')).toBe(true);
	});
});
