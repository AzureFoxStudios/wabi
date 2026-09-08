import { afterAll, expect, mock, test } from 'bun:test';

// Run in its own process. Browser globals and module mocks must not poison the
// shared auth/session modules imported by the ordinary frontend test suite.
const A = 'https://refresh-alpha.test';
const B = 'https://refresh-beta.test';
let active = A;
const sessions = new Map<string, { generation: number; token: string | null }>();
const storage = new Map<string, string>();
const originalGlobals = {
	window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
	document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
	sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
	fetch: globalThis.fetch,
};
Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
Object.defineProperty(globalThis, 'document', { configurable: true, value: {} });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
	getItem: (key: string) => storage.get(key) ?? null,
	setItem: (key: string, value: string) => storage.set(key, value),
	removeItem: (key: string) => storage.delete(key),
} });
mock.module('../src/lib/serverUrl', () => ({ getServerUrl: () => active, normalizeServerUrl: (value: string) => value.replace(/\/+$/, '') }));
mock.module('../src/lib/authSession', () => ({
	getAuthToken: (server = active) => sessions.get(server)?.token ?? null,
	setAuthToken: (token: string | null, server = active) => { sessions.get(server)!.token = token; },
	clearAuthToken: (server = active) => { sessions.get(server)!.token = null; },
	authSessionGeneration: (server = active) => sessions.get(server)?.generation ?? 0,
	getStoredDbUserId: (server = active) => server === A ? 1 : 2,
	onAuthSessionCleared: () => () => {},
}));
const { tryRefresh, setRefreshToken, getRefreshToken } = await import('../src/lib/api/authRefresh');
const { fetchWithTimeout } = await import('../src/lib/api/utils');
afterAll(() => {
	globalThis.fetch = originalGlobals.fetch;
	for (const key of ['window', 'document', 'sessionStorage'] as const) {
		if (originalGlobals[key]) Object.defineProperty(globalThis, key, originalGlobals[key]!);
		else Reflect.deleteProperty(globalThis, key);
	}
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function reset() {
	active = A; storage.clear(); sessions.clear();
	sessions.set(A, { generation: 1, token: 'alpha-access' }); sessions.set(B, { generation: 1, token: 'beta-access' });
	setRefreshToken('alpha-refresh', A); setRefreshToken('beta-refresh', B);
}
const tokens = (access: string, refresh: string) => Response.json({ accessToken: access, refreshToken: refresh });

test('same-session concurrent calls share one refresh and keep explicit server ownership', async () => {
	reset(); active = B; const response = deferred<Response>(); const urls: string[] = [];
	globalThis.fetch = (async url => { urls.push(String(url)); return response.promise; }) as typeof fetch;
	const first = tryRefresh(A); const second = tryRefresh(A); await Promise.resolve();
	expect(urls).toEqual([A + '/api/auth/refresh']);
	response.resolve(tokens('alpha-fresh', 'alpha-rotated'));
	expect(await first).toBe(true); expect(await second).toBe(true);
	expect(sessions.get(A)!.token).toBe('alpha-fresh'); expect(getRefreshToken(A)).toBe('alpha-rotated');
	expect(sessions.get(B)!.token).toBe('beta-access'); expect(getRefreshToken(B)).toBe('beta-refresh');
});

test('same-token logout/relogin cannot accept an old refresh or join its in-flight promise', async () => {
	reset(); const old = deferred<Response>(); const fresh = deferred<Response>(); let calls = 0;
	globalThis.fetch = (async () => (++calls === 1 ? old.promise : fresh.promise)) as unknown as typeof fetch;
	const previous = tryRefresh(A); await Promise.resolve();
	sessions.get(A)!.generation++; // exact same credential bytes deliberately restored
	const current = tryRefresh(A); await Promise.resolve(); expect(calls).toBe(2);
	old.resolve(tokens('obsolete-access', 'obsolete-refresh')); expect(await previous).toBe(false);
	expect(sessions.get(A)!.token).toBe('alpha-access'); expect(getRefreshToken(A)).toBe('alpha-refresh');
	// Old finalization must not remove the new session's coalescing entry.
	const sibling = tryRefresh(A); await Promise.resolve(); expect(calls).toBe(2);
	fresh.resolve(tokens('current-access', 'current-refresh'));
	expect(await current).toBe(true); expect(await sibling).toBe(true);
	expect(sessions.get(A)!.token).toBe('current-access'); expect(getRefreshToken(A)).toBe('current-refresh');
});

test('an old unauthorized refresh cannot erase a new session with identical credentials', async () => {
	reset(); const response = deferred<Response>();
	globalThis.fetch = (async () => response.promise) as unknown as typeof fetch;
	const pending = tryRefresh(A); await Promise.resolve(); sessions.get(A)!.generation++;
	response.resolve(Response.json({ error: 'revoked' }, { status: 401 }));
	expect(await pending).toBe(false); expect(sessions.get(A)!.token).toBe('alpha-access'); expect(getRefreshToken(A)).toBe('alpha-refresh');
});

test('same-session refresh denial clears only that server and permits a later fresh login', async () => {
	reset(); active = B; globalThis.fetch = (async () => Response.json({ error: 'revoked' }, { status: 401 })) as unknown as typeof fetch;
	expect(await tryRefresh(A)).toBe(false); expect(sessions.get(A)!.token).toBeNull(); expect(getRefreshToken(A)).toBeNull();
	expect(sessions.get(B)!.token).toBe('beta-access');
	sessions.get(A)!.generation++; sessions.get(A)!.token = 'login-access'; setRefreshToken('login-refresh', A);
	globalThis.fetch = (async () => tokens('next-access', 'next-refresh')) as unknown as typeof fetch;
	expect(await tryRefresh(A)).toBe(true); expect(sessions.get(A)!.token).toBe('next-access');
});

test('production wrapper preserves HTTP401 when the real refresh coordinator removes expired credentials', async () => {
	reset(); const urls: string[] = [];
	globalThis.fetch = (async url => { urls.push(String(url)); return Response.json({ error: 'revoked' }, { status: 401 }); }) as typeof fetch;
	const response = await fetchWithTimeout(A + '/api/admin/users/reset-password', { method: 'POST', headers: { Authorization: 'Bearer alpha-access' } });
	expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'revoked' });
	expect(urls).toEqual([A + '/api/admin/users/reset-password', A + '/api/auth/refresh']);
	expect(sessions.get(A)!.token).toBeNull(); expect(getRefreshToken(A)).toBeNull();
});
