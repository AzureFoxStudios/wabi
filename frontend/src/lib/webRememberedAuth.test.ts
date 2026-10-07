import { beforeEach, expect, mock, test } from 'bun:test';

mock.module('$app/environment', () => ({ browser: true, dev: false, building: false }));
mock.module('./tauri-platform', () => ({ isTauriRuntime: () => false }));
function memoryStorage(): Storage {
	const values = new Map<string, string>();
	return { get length() { return values.size; }, clear() { values.clear(); },
		getItem(key) { return values.get(key) ?? null; }, key(i) { return [...values.keys()][i] ?? null; },
		removeItem(key) { values.delete(key); }, setItem(key, value) { values.set(key, value); } };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
Object.defineProperty(globalThis, 'sessionStorage', { value: memoryStorage(), configurable: true });
Object.defineProperty(globalThis, 'window', { value: { location: { origin: 'https://wabi.example', hostname: 'wabi.example', protocol: 'https:', port: '' } }, configurable: true });
Object.defineProperty(globalThis, 'document', { value: {}, configurable: true });
const { clearAuthSession, getAuthToken, setAuthToken, setPersistentAuthToken, getPersistedRefreshToken } = await import('./authSession');
const { getRefreshToken, setRefreshToken, tryRefresh, ensureFreshAccessToken, accessTokenExpiresInMs } = await import('./api/authRefresh');
const scope = 'https://wabi.example';
const key = (prefix: string) => `${prefix}${encodeURIComponent(scope)}`;

function jwt(expSecondsFromNow: number): string {
	const part = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
	return `${part({ alg: 'none' })}.${part({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.sig`;
}
/** A PWA the OS killed: memory and sessionStorage are gone, localStorage survives. */
function killApp() { sessionStorage.clear(); }
function login(rememberMe: boolean, access = jwt(900), refresh = 'refresh-1') {
	setAuthToken(access, scope); setRefreshToken(refresh, scope); setPersistentAuthToken(rememberMe ? access : null, scope);
}
function stubRefresh(handler: (body: { refreshToken: string }) => Response | Promise<Response>) {
	const previous = globalThis.fetch; const calls: string[] = [];
	globalThis.fetch = mock(async (input, init) => {
		calls.push(String(input));
		return handler(JSON.parse(String(init?.body)));
	}) as unknown as typeof fetch;
	return { calls, restore: () => { globalThis.fetch = previous; } };
}
const pair = (accessToken: string, refreshToken: string) => new Response(JSON.stringify({ accessToken, refreshToken }), { status: 200 });

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

test('remember me keeps the refresh token so a killed PWA can renew', () => {
	const access = jwt(900); login(true, access, 'refresh-1');
	expect(localStorage.getItem(key('wabi_persisted_refresh_token:'))).toBe('refresh-1');
	killApp();
	expect(getAuthToken(scope)).toBe(access);
	expect(getRefreshToken(scope)).toBe('refresh-1');
});

test('without remember me nothing survives the app being killed', () => {
	login(false);
	expect(localStorage.getItem(key('wabi_persisted_refresh_token:'))).toBeNull();
	killApp();
	expect(getAuthToken(scope)).toBeNull();
	expect(getRefreshToken(scope)).toBeNull();
});

test('a killed PWA with an expired access token refreshes and rotates the remembered pair', async () => {
	login(true, jwt(-600), 'refresh-1'); killApp();
	const server = stubRefresh(({ refreshToken }) => {
		expect(refreshToken).toBe('refresh-1');
		return pair('access-2', 'refresh-2');
	});
	try { expect(await ensureFreshAccessToken(scope)).toBe(true); } finally { server.restore(); }
	expect(server.calls).toEqual([`${scope}/api/auth/refresh`]);
	expect(getAuthToken(scope)).toBe('access-2');
	expect(getRefreshToken(scope)).toBe('refresh-2');
	// The next kill must find the rotated pair, not the burned one.
	killApp();
	expect(getPersistedRefreshToken(scope)).toBe('refresh-2');
	expect(getAuthToken(scope)).toBe('access-2');
});

test('a still-valid access token is not refreshed', async () => {
	login(true, jwt(900)); killApp();
	const server = stubRefresh(() => pair('unused', 'unused'));
	try { expect(await ensureFreshAccessToken(scope)).toBe(true); } finally { server.restore(); }
	expect(server.calls).toEqual([]);
});

test('a token inside the renewal window is refreshed ahead of use', async () => {
	login(true, jwt(90), 'refresh-1');
	const server = stubRefresh(() => pair('access-2', 'refresh-2'));
	try { expect(await ensureFreshAccessToken(scope, { skewMs: 3 * 60_000 })).toBe(true); } finally { server.restore(); }
	expect(server.calls.length).toBe(1);
	expect(getAuthToken(scope)).toBe('access-2');
});

test('being offline keeps the whole remembered session', async () => {
	login(true, jwt(-600), 'refresh-1'); killApp();
	const previous = globalThis.fetch;
	globalThis.fetch = mock(async () => { throw new TypeError('network down'); }) as unknown as typeof fetch;
	try { expect(await ensureFreshAccessToken(scope)).toBe(false); } finally { globalThis.fetch = previous; }
	expect(getPersistedRefreshToken(scope)).toBe('refresh-1');
	expect(getAuthToken(scope)).not.toBeNull();
});

test('a rejected refresh token ends the remembered session everywhere', async () => {
	login(true, jwt(-600), 'refresh-1'); killApp();
	const server = stubRefresh(() => new Response('{}', { status: 401 }));
	try { expect(await tryRefresh(scope)).toBe(false); } finally { server.restore(); }
	expect(localStorage.getItem(key('wabi_persisted_auth_token:'))).toBeNull();
	expect(localStorage.getItem(key('wabi_persisted_refresh_token:'))).toBeNull();
	expect(getRefreshToken(scope)).toBeNull();
});

test('logout removes the remembered pair', () => {
	login(true); clearAuthSession(scope); killApp();
	expect(localStorage.getItem(key('wabi_persisted_auth_token:'))).toBeNull();
	expect(localStorage.getItem(key('wabi_persisted_refresh_token:'))).toBeNull();
	expect(getRefreshToken(scope)).toBeNull();
});

test('an orphaned remembered refresh token is ignored', () => {
	localStorage.setItem(key('wabi_persisted_refresh_token:'), 'orphan');
	expect(getPersistedRefreshToken(scope)).toBeNull();
	expect(getRefreshToken(scope)).toBeNull();
});

test('token expiry is read from the JWT without trusting anything else', () => {
	const now = Date.now();
	expect(accessTokenExpiresInMs(jwt(60), now)).toBeGreaterThan(50_000);
	expect(accessTokenExpiresInMs(jwt(-60), now)).toBeLessThan(0);
	expect(accessTokenExpiresInMs('not-a-jwt', now)).toBeNull();
	expect(accessTokenExpiresInMs(null, now)).toBeNull();
});
