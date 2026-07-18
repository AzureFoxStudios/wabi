// @ts-nocheck
/**
 * Security tests for encryption at-rest wrapping and CSS sanitizers.
 * Runnable via: bun test src/lib/cssSanitize.test.ts
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import {
	sanitizeAccentColor,
	sanitizeCustomCss,
	sanitizeCssUrl
} from './cssSanitize';

// Minimal localStorage for bun
const mem = new Map();
const localStorageMock = {
	getItem: (k) => (mem.has(k) ? mem.get(k) : null),
	setItem: (k, v) => {
		mem.set(k, String(v));
	},
	removeItem: (k) => {
		mem.delete(k);
	},
	clear: () => mem.clear()
};
globalThis.localStorage = localStorageMock;

describe('sanitizeAccentColor', () => {
	test('allows hex and rgb', () => {
		expect(sanitizeAccentColor('#2dd4bf')).toBe('#2dd4bf');
		expect(sanitizeAccentColor('#fff')).toBe('#fff');
		expect(sanitizeAccentColor('rgb(1, 2, 3)')).toBe('rgb(1, 2, 3)');
		expect(sanitizeAccentColor('rgba(15, 23, 42, 0.85)')).toBe('rgba(15, 23, 42, 0.85)');
	});

	test('rejects injection payloads', () => {
		expect(sanitizeAccentColor('red; background:url(javascript:alert(1))')).toBeNull();
		expect(sanitizeAccentColor('expression(alert(1))')).toBeNull();
		expect(sanitizeAccentColor('</style><script>alert(1)</script>')).toBeNull();
		expect(sanitizeAccentColor('url(https://evil)')).toBeNull();
	});
});

describe('sanitizeCustomCss', () => {
	test('allows simple property rules', () => {
		const ok = '.login-box { border-radius: 12px; }';
		expect(sanitizeCustomCss(ok)).toBe(ok);
	});

	test('strips style breakout and script-ish payloads', () => {
		expect(sanitizeCustomCss('</style><script>alert(1)</script>')).toBe('');
		expect(sanitizeCustomCss('body{background:url(javascript:alert(1))}')).toBe('');
		expect(sanitizeCustomCss('@import url("https://evil")')).toBe('');
		expect(sanitizeCustomCss('div{background:url(https://x)}')).toBe('');
		expect(sanitizeCustomCss('x{expression(alert(1))}')).toBe('');
	});
});

describe('sanitizeCssUrl', () => {
	test('allows https and relative', () => {
		expect(sanitizeCssUrl('https://cdn.example/a.png')).toBe('https://cdn.example/a.png');
		expect(sanitizeCssUrl('/uploads/bg.webp')).toBe('/uploads/bg.webp');
	});
	test('rejects javascript and data', () => {
		expect(sanitizeCssUrl('javascript:alert(1)')).toBeNull();
		expect(sanitizeCssUrl('data:text/html,hi')).toBeNull();
	});
});

describe('encryption device wrap', () => {
	beforeEach(() => {
		mem.clear();
	});

	test('never stores raw private key; device salt is random per install', async () => {
		const {
			saveUserKeys,
			loadUserKeys,
			setKeyWrappingSecret,
			ENCRYPTION_STORAGE_KEY,
			DEVICE_WRAP_SECRET_KEY,
			getOrCreateDeviceWrapSecret
		} = await import('./encryption');

		setKeyWrappingSecret(null);
		const rawPrivate = 'RAW_PRIVATE_KEY_MATERIAL_TEST_VALUE_NOT_WRAPPED';
		await saveUserKeys(42, 'pub-test', rawPrivate);

		const stored = JSON.parse(localStorage.getItem(ENCRYPTION_STORAGE_KEY) || '{}');
		const entry = stored['42'];
		expect(entry).toBeTruthy();
		expect(entry.privateKey).not.toBe(rawPrivate);
		expect(entry.privateKey.split('.').length).toBe(3);

		const secretA = localStorage.getItem(DEVICE_WRAP_SECRET_KEY);
		expect(secretA && secretA.length >= 16).toBe(true);

		const first = getOrCreateDeviceWrapSecret();
		localStorage.removeItem(DEVICE_WRAP_SECRET_KEY);
		const second = getOrCreateDeviceWrapSecret();
		expect(first).not.toBe(second);

		setKeyWrappingSecret(null);
		await saveUserKeys(7, 'pub', rawPrivate);
		const loaded = await loadUserKeys(7);
		expect(loaded?.privateKey).toBe(rawPrivate);
	});
});
