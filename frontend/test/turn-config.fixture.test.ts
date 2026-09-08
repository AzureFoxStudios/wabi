import { afterAll, expect, mock, test } from 'bun:test';
import { writable } from 'svelte/store';

// Process-isolated production wiring: no browser/auth mocks leak into calling tests.
const A = 'https://alpha-turn.test'; const B = 'https://beta-turn.test';
let active = A;
const activeServerUrl = writable(A);
const selectedTurnRelay = writable<null | { relay_id: number }>(null);
let relayId: number | null = null;
selectedTurnRelay.subscribe(value => { relayId = value?.relay_id ?? null; });
const sessions = new Map<string, { token: string | null; generation: number; account: number }>();
const clearListeners = new Set<(server: string) => void>();
const storage = new Map<string, string>();
const originalFetch = globalThis.fetch;
function fixtureFetch(handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): typeof fetch {
	return Object.assign(handler, { preconnect: originalFetch.preconnect });
}
Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
Object.defineProperty(globalThis, 'document', { configurable: true, value: {} });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
	getItem: (key: string) => storage.get(key) ?? null,
	setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key),
} });
for (const key of ['VITE_TURN_SERVER', 'VITE_TURN_PORT', 'VITE_TURN_USERNAME', 'VITE_TURN_PASSWORD', 'VITE_USE_TURNS', 'VITE_ENABLE_GOOGLE_STUN']) delete process.env[key];
mock.module('$app/environment', () => ({ browser: true }));
mock.module('../src/lib/serverUrl', () => ({ activeServerUrl, getServerUrl: () => active, normalizeServerUrl: (value: string) => value.replace(/\/+$/, '') }));
mock.module('../src/lib/relaySelector', () => ({ selectedTurnRelay, getPreferredTurnRelayId: () => relayId }));
mock.module('../src/lib/authSession', () => ({
	getAuthToken: (server = active) => sessions.get(server)?.token ?? null,
	setAuthToken: (token: string | null, server = active) => { sessions.get(server)!.token = token; },
	clearAuthToken: (server = active) => { sessions.get(server)!.token = null; },
	getStoredDbUserId: (server = active) => sessions.get(server)?.account ?? null,
	authSessionGeneration: (server = active) => sessions.get(server)?.generation ?? 0,
	onAuthSessionCleared: (listener: (server: string) => void) => { clearListeners.add(listener); return () => clearListeners.delete(listener); },
}));
const { prefetchTurnCredentials, buildRTCConfig } = await import('../src/lib/turnConfig');
const { setRefreshToken } = await import('../src/lib/api/authRefresh');
afterAll(() => { globalThis.fetch = originalFetch; });
const access = (subject: number, version = 'old') => `e30.${btoa(JSON.stringify({ sub: String(subject), jti: version }))}.signature`;
const credentials = (server = 'coturn.alpha.test', useTurns = false) => Response.json({ turn: {
	server, port: useTurns ? 5349 : 3478, useTurns, username: 'time:account', credential: 'issued-canary', expiresAt: Date.now() / 1000 + 3600,
	relayId: null, source: 'origin',
} });
function select(server: string) { active = server; activeServerUrl.set(server); }
function reset() {
	storage.clear();
	sessions.set(A, { token: access(1), generation: (sessions.get(A)?.generation ?? 0) + 1, account: 1 });
	sessions.set(B, { token: access(2), generation: (sessions.get(B)?.generation ?? 0) + 1, account: 2 });
	setRefreshToken('alpha-refresh', A); setRefreshToken('beta-refresh', B);
	select(A); selectedTurnRelay.set(null); for (const listener of clearListeners) listener(A);
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('actual runtime issuance feeds STUN and TURN without build-time host or Google discovery', async () => {
	reset(); globalThis.fetch = fixtureFetch(async () => credentials());
	await prefetchTurnCredentials();
	expect(buildRTCConfig().iceServers).toEqual([
		{ urls: 'stun:coturn.alpha.test:3478' },
		{ urls: ['turn:coturn.alpha.test:3478?transport=udp', 'turn:coturn.alpha.test:3478?transport=tcp'], username: 'time:account', credential: 'issued-canary' },
	]);
});

test('production 401 refresh is scoped, finite, and feeds renewed credentials into RTC configuration', async () => {
	reset(); const calls: { url: string; auth: string | null }[] = [];
	globalThis.fetch = fixtureFetch(async (url, options) => {
		calls.push({ url: String(url), auth: new Headers(options?.headers).get('Authorization') });
		if (String(url).endsWith('/api/auth/refresh')) return Response.json({ accessToken: access(1, 'fresh'), refreshToken: 'rotated-refresh' });
		return calls.length === 1 ? Response.json({ error: 'expired' }, { status: 401 }) : credentials();
	});
	await prefetchTurnCredentials();
	expect(calls.map(call => call.url)).toEqual([A + '/api/media/turn-credentials', A + '/api/auth/refresh', A + '/api/media/turn-credentials']);
	expect(calls[2].auth).toBe(`Bearer ${access(1, 'fresh')}`);
	expect(buildRTCConfig().iceServers).toHaveLength(2);
});

test('server reselection cancels old credentials and cannot reuse the former cached server', async () => {
	reset(); const old = deferred<Response>(); const entered = deferred<void>();
	globalThis.fetch = fixtureFetch(async () => { entered.resolve(); return old.promise; });
	const pending = prefetchTurnCredentials(); await entered.promise;
	select(B); select(A); old.resolve(credentials('retired.test')); await pending;
	expect(buildRTCConfig().iceServers).toEqual([]);
	globalThis.fetch = fixtureFetch(async () => credentials('current.test'));
	await prefetchTurnCredentials(); expect(buildRTCConfig().iceServers?.[0].urls).toBe('stun:current.test:3478');
	select(B); expect(buildRTCConfig().iceServers).toEqual([]);
});

test('same-server account replacement and explicit same-account logout ABA clear cached credentials', async () => {
	for (const changeAccount of [false, true]) {
		reset(); globalThis.fetch = fixtureFetch(async () => credentials()); await prefetchTurnCredentials();
		if (changeAccount) sessions.set(A, { ...sessions.get(A)!, account: 3, token: access(3) });
		else { sessions.get(A)!.generation++; for (const listener of clearListeners) listener(A); }
		expect(buildRTCConfig().iceServers).toEqual([]);
	}
});

test('relay selection triggers a separately scoped request even when origin fallback is returned', async () => {
	reset(); const urls: string[] = []; globalThis.fetch = fixtureFetch(async url => { urls.push(String(url)); return credentials(); });
	await prefetchTurnCredentials(); selectedTurnRelay.set({ relay_id: 7 }); expect(buildRTCConfig().iceServers).toEqual([]);
	await prefetchTurnCredentials(); await prefetchTurnCredentials();
	expect(urls).toEqual([A + '/api/media/turn-credentials', A + '/api/media/turn-credentials?relayId=7']);
});

test('TLS runtime credentials avoid plaintext STUN and unsupported turns UDP URLs', async () => {
	reset(); globalThis.fetch = fixtureFetch(async () => credentials('[2001:db8::1]', true)); await prefetchTurnCredentials();
	expect(buildRTCConfig().iceServers).toEqual([{ urls: ['turns:[2001:db8::1]:5349?transport=tcp'], username: 'time:account', credential: 'issued-canary' }]);
});

test('disabled or denied issuance does not claim an available TURN service', async () => {
	for (const status of [400, 401, 503]) {
		reset(); let requests = 0; globalThis.fetch = fixtureFetch(async () => { requests++; return Response.json({ error: 'unavailable' }, { status }); });
		await prefetchTurnCredentials(); expect(buildRTCConfig().iceServers).toEqual([]); expect(requests).toBe(status === 401 ? 2 : 1);
	}
});

test('explicit static compatibility remains available, with correct TLS defaults and opt-in Google only', async () => {
	reset(); globalThis.fetch = fixtureFetch(async () => Response.json({ error: 'TURN server not enabled' }, { status: 400 }));
	await prefetchTurnCredentials();
	try {
		process.env.VITE_TURN_SERVER = 'static.turn.test';
		process.env.VITE_TURN_USERNAME = 'static-user'; process.env.VITE_TURN_PASSWORD = 'static-secret';
		expect(buildRTCConfig().iceServers).toEqual([
			{ urls: 'stun:static.turn.test:3478' },
			{ urls: ['turn:static.turn.test:3478?transport=udp', 'turn:static.turn.test:3478?transport=tcp'], username: 'static-user', credential: 'static-secret' },
		]);
		process.env.VITE_USE_TURNS = 'true';
		expect(buildRTCConfig().iceServers).toEqual([{ urls: ['turns:static.turn.test:5349?transport=tcp'], username: 'static-user', credential: 'static-secret' }]);
		process.env.VITE_ENABLE_GOOGLE_STUN = 'true'; expect(buildRTCConfig().iceServers).toHaveLength(3);
	} finally {
		for (const key of ['VITE_TURN_SERVER', 'VITE_TURN_USERNAME', 'VITE_TURN_PASSWORD', 'VITE_USE_TURNS', 'VITE_ENABLE_GOOGLE_STUN']) delete process.env[key];
	}
});
