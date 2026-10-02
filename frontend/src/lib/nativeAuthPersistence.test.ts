import { beforeEach, expect, mock, test } from 'bun:test';

mock.module('$app/environment', () => ({ browser: true, dev: false, building: false }));
mock.module('./tauri-platform', () => ({ isTauriRuntime: () => true }));
let nativeCall: (command: string, args: Record<string, unknown>) => Promise<unknown> = async () => null;
mock.module('@tauri-apps/api/core', () => ({ invoke: (command: string, args: Record<string, unknown>) => nativeCall(command, args) }));
function memoryStorage(): Storage {
	const values = new Map<string, string>();
	return { get length() { return values.size; }, clear() { values.clear(); },
		getItem(key) { return values.get(key) ?? null; }, key(i) { return [...values.keys()][i] ?? null; },
		removeItem(key) { values.delete(key); }, setItem(key, value) { values.set(key, value); } };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
Object.defineProperty(globalThis, 'sessionStorage', { value: memoryStorage(), configurable: true });
Object.defineProperty(globalThis, 'window', { value: { __TAURI_INTERNALS__: {}, location: { origin: 'https://tauri.localhost', hostname: 'tauri.localhost', protocol: 'https:', port: '' } }, configurable: true });
Object.defineProperty(globalThis, 'document', { value: {}, configurable: true });
const { clearAuthSession, getAuthToken, setAuthToken, setPersistentAuthToken, setGuestSessionId, setTemporaryGuestSession, isTemporaryGuestSession } = await import('./authSession');
const { getRefreshToken, setRefreshToken, tryRefresh } = await import('./api/authRefresh');
const { hydrateNativePersistentAuthToken } = await import('./nativeAuthPersistence');
const scope = 'https://mobile.example';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }

beforeEach(() => { nativeCall = async () => null; localStorage.clear(); sessionStorage.clear(); });

test('bootstrap completion cannot restore credentials after logout and a guest visit', async () => {
	const read = deferred<unknown>(); const entered = deferred<void>(); const deleted = deferred<void>();
	nativeCall = async command => { if (command === 'secure_auth_get') { entered.resolve(); return read.promise; } if (command === 'secure_auth_delete') deleted.resolve(); return null; };
	const bootstrap = hydrateNativePersistentAuthToken(scope); await entered.promise;
	clearAuthSession(scope); setGuestSessionId('guest', scope); setTemporaryGuestSession(true, scope);
	read.resolve({ accessToken: 'retired-access', refreshToken: 'retired-refresh' });
	await bootstrap; await deleted.promise;
	expect(getAuthToken(scope)).toBeNull(); expect(getRefreshToken(scope)).toBeNull();
	expect(isTemporaryGuestSession(scope)).toBe(true);
});

test('in-flight keyring write settles before logout deletion', async () => {
	const write = deferred<unknown>(); const entered = deferred<void>(); const deleted = deferred<void>(); const calls: string[] = [];
	nativeCall = async command => { calls.push(command); if (command === 'secure_auth_set') { entered.resolve(); return write.promise; } if (command === 'secure_auth_delete') deleted.resolve(); return null; };
	setAuthToken('old-access', scope); setRefreshToken('old-refresh', scope); setPersistentAuthToken('old-access', scope);
	await entered.promise; clearAuthSession(scope); expect(calls).toEqual(['secure_auth_set']);
	write.resolve(null); await deleted.promise;
	expect(calls).toEqual(['secure_auth_set', 'secure_auth_delete']);
	expect(getAuthToken(scope)).toBeNull(); expect(getRefreshToken(scope)).toBeNull();
});

test('bootstrap never overwrites a newer account login', async () => {
	const read = deferred<unknown>(); const entered = deferred<void>();
	nativeCall = async command => { if (command === 'secure_auth_get') { entered.resolve(); return read.promise; } return null; };
	const bootstrap = hydrateNativePersistentAuthToken(scope); await entered.promise;
	setAuthToken('new-account', scope); setRefreshToken('new-refresh', scope);
	read.resolve({ accessToken: 'old-account', refreshToken: 'old-refresh' }); await bootstrap;
	expect(getAuthToken(scope)).toBe('new-account'); expect(getRefreshToken(scope)).toBe('new-refresh');
});

test('remembered refresh rotation persists the pair to its original Authority', async () => {
	const writes: Array<Record<string, unknown>> = []; const rotated = deferred<void>();
	nativeCall = async (command, args) => {
		if (command === 'secure_auth_get') return { accessToken: 'access-1', refreshToken: 'refresh-1' };
		if (command === 'secure_auth_set') { writes.push(args); rotated.resolve(); }
		return null;
	};
	await hydrateNativePersistentAuthToken(scope);
	const previousFetch = globalThis.fetch;
	globalThis.fetch = mock(async (input, init) => {
		expect(input).toBe(`${scope}/api/auth/refresh`);
		expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: 'refresh-1' });
		return new Response(JSON.stringify({ accessToken: 'access-2', refreshToken: 'refresh-2' }), { status: 200 });
	}) as unknown as typeof fetch;
	try { expect(await tryRefresh(scope)).toBe(true); await rotated.promise; }
	finally { globalThis.fetch = previousFetch; }
	expect(writes).toEqual([{ serverScope: scope, accessToken: 'access-2', refreshToken: 'refresh-2' }]);
	expect(localStorage.getItem(`wabi_persisted_auth_token:${encodeURIComponent(scope)}`)).toBeNull();
});

test('session cleanup retains the temporary guest cleanup', async () => {
	const deleted = deferred<void>(); nativeCall = async command => { if (command === 'secure_auth_delete') deleted.resolve(); return null; };
	setTemporaryGuestSession(true, scope); clearAuthSession(scope); await deleted.promise;
	expect(isTemporaryGuestSession(scope)).toBe(false);
});
