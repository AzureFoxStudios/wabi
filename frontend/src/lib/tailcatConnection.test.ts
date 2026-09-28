import { beforeEach, expect, mock, test } from 'bun:test';

mock.module('$app/environment', () => ({ browser: true, dev: false, building: false }));

function memoryStorage(): Storage {
	const values = new Map<string, string>();
	return {
		get length() { return values.size; },
		clear() { values.clear(); },
		getItem(key: string) { return values.get(key) ?? null; },
		key(index: number) { return [...values.keys()][index] ?? null; },
		removeItem(key: string) { values.delete(key); },
		setItem(key: string, value: string) { values.set(key, value); }
	};
}

Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
Object.defineProperty(globalThis, 'sessionStorage', { value: memoryStorage(), configurable: true });
Object.defineProperty(globalThis, 'window', {
	value: { location: { origin: 'https://app.example', hostname: 'app.example', port: '', protocol: 'https:' } },
	configurable: true
});
Object.defineProperty(globalThis, 'document', { value: {}, configurable: true });

const { getConfiguredServerUrl, setConfiguredServerUrl } = await import('./serverUrl');
const { isCurrentTailcatProxy, rememberTailcatConnection, recoverStoppedTailcatConnection, restoreTailcatConnection } =
	await import('./tailcatConnection');
const { clearAuthSession, getAuthToken } = await import('./authSession');

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	setConfiguredServerUrl('https://site-a.example', true);
});

test('a stopped tunnel restores the remembered server before account bootstrap', async () => {
	rememberTailcatConnection('https://site-a.example', 'http://127.0.0.1:41001');
	setConfiguredServerUrl('http://127.0.0.1:41001', false);
	expect(await recoverStoppedTailcatConnection(async () => ({ connected: false, proxyPort: null }))).toBe(true);
	expect(getConfiguredServerUrl()).toBe('https://site-a.example');
	expect(localStorage.getItem('wabi.tailcat.proxyUrl')).toBeNull();
	expect(localStorage.getItem('wabi.serverUrlRemember')).toBe('true');
});

test('a live matching tunnel keeps its proxy address', async () => {
	rememberTailcatConnection('https://site-a.example', 'http://127.0.0.1:41002');
	setConfiguredServerUrl('http://127.0.0.1:41002', false);
	expect(isCurrentTailcatProxy()).toBe(true);
	expect(await recoverStoppedTailcatConnection(async () => ({ connected: true, proxyPort: 41002 }))).toBe(false);
	expect(getConfiguredServerUrl()).toBe('http://127.0.0.1:41002');
	expect(restoreTailcatConnection()).toBe(true);
	expect(getConfiguredServerUrl()).toBe('https://site-a.example');
	expect(isCurrentTailcatProxy()).toBe(false);
});

test('a desktop restart restores the previous address when session storage vanished', async () => {
	rememberTailcatConnection('https://site-a.example', 'http://127.0.0.1:41005');
	setConfiguredServerUrl('http://127.0.0.1:41005', false);
	sessionStorage.clear();
	expect(getConfiguredServerUrl()).toBeNull();
	expect(await recoverStoppedTailcatConnection(async () => ({ connected: false, proxyPort: null }))).toBe(true);
	expect(getConfiguredServerUrl()).toBe('https://site-a.example');
});

test('a live tunnel restores its proxy address when session storage vanished', async () => {
	rememberTailcatConnection('https://site-a.example', 'http://127.0.0.1:41006');
	setConfiguredServerUrl('http://127.0.0.1:41006', false);
	sessionStorage.clear();
	expect(await recoverStoppedTailcatConnection(async () => ({ connected: true, proxyPort: 41006 }))).toBe(true);
	expect(getConfiguredServerUrl()).toBe('http://127.0.0.1:41006');
});

test('a stale marker cannot move a different selected server', async () => {
	rememberTailcatConnection('https://site-a.example', 'http://127.0.0.1:41003');
	setConfiguredServerUrl('https://site-b.example', true);
	expect(await recoverStoppedTailcatConnection(async () => ({ connected: false, proxyPort: null }))).toBe(false);
	expect(getConfiguredServerUrl()).toBe('https://site-b.example');
	expect(restoreTailcatConnection()).toBe(true);
	expect(getConfiguredServerUrl()).toBe('https://site-b.example');
	expect(() => rememberTailcatConnection('https://site-a.example', 'http://evil.example')).toThrow();
});

test('a reused proxy port cannot inherit a legacy unscoped bearer token', () => {
	sessionStorage.setItem('wabi_auth_token', 'old-token');
	clearAuthSession('http://127.0.0.1:41004');
	expect(sessionStorage.getItem('wabi_auth_token')).toBeNull();
	expect(getAuthToken('http://127.0.0.1:41004')).toBeNull();
});
