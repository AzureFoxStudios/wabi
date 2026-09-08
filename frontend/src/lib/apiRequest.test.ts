import { describe, expect, test } from 'bun:test';
import { accountTokenSubject, apiRequestScope, createApiRequester, type ApiRequestSession } from './apiRequest';

const A = 'https://alpha.test/prefix';
const B = 'https://beta.test';
const token = (sub: string, version = 'old') => `e30.${btoa(JSON.stringify({ sub, jti: version }))}.signature`;
const unauthorized = () => new Response('{"error":"expired"}', { status: 401, headers: { 'Content-Type': 'application/json' } });
const accepted = () => new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

function fixture() {
	const sessions = new Map<string, ApiRequestSession>([
		[A, { generation: 1, accountId: '1', token: token('1') }],
		[B, { generation: 1, accountId: '2', token: token('2') }],
	]);
	let active = A;
	const calls: Array<{ url: string; options: RequestInit }> = [];
	const refreshes: string[] = [];
	const listeners = new Set<(server: string) => void>();
	let send: (url: string, options: RequestInit) => Promise<Response> = async () => accepted();
	let refresh: (server: string) => Promise<boolean> = async server => {
		const session = sessions.get(server)!;
		session.token = token(session.accountId!, 'fresh');
		return true;
	};
	const request = createApiRequester({
		base: () => active,
		fetch: (url, options) => { calls.push({ url, options }); return send(url, options); },
		session: server => ({ ...(sessions.get(server) ?? { generation: 0, accountId: null, token: null }) }),
		refresh: server => { refreshes.push(server); return refresh(server); },
		onSessionCleared: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		retryDelays: [0, 0],
	});
	return { request, calls, refreshes, sessions, listeners,
		select: (server: string) => { active = server; },
		send: (next: typeof send) => { send = next; }, refresh: (next: typeof refresh) => { refresh = next; },
		logout: (server: string) => { sessions.get(server)!.generation++; for (const listener of listeners) listener(server); },
		headers: (server = A) => ({ Authorization: `Bearer ${sessions.get(server)!.token}` }),
	};
}

describe('immutable request/refresh ownership', () => {
	test('scope keeps proxy prefixes and explicit server destinations', () => {
		expect(apiRequestScope(A + '/api/channels', B).server).toBe(A);
		expect(apiRequestScope('https://example.test/api/proxy/api/channels', B).server).toBe('https://example.test/api/proxy');
		expect(apiRequestScope('/api/channels', B).server).toBe(B);
		expect(apiRequestScope(A + '/api/addons/lore/files/folder/api/readme', A).server).toBe(A);
		expect(apiRequestScope('https://storage.test/signed-file', A).server).toBeNull();
		expect(accountTokenSubject(token('9007199254740993'))).toBe('9007199254740993');
		expect(accountTokenSubject('wblore_scoped_credential')).toBeNull();
	});

	test('one same-account refresh preserves URL, body, headers and explicit credentials mode', async () => {
		const f = fixture(); f.send(async () => f.calls.length === 1 ? unauthorized() : accepted());
		const headers = { ...f.headers(), 'If-Match': '"revision"' };
		const response = await f.request(A + '/api/admin/users/reset-password', { method: 'POST', headers, body: '{"targetUserId":7}', credentials: 'omit' });
		expect(response.status).toBe(200); expect(f.refreshes).toEqual([A]); expect(f.calls.length).toBe(2);
		expect(f.calls[1].url).toBe(f.calls[0].url);
		expect(f.calls[1].options.body).toBe(f.calls[0].options.body);
		expect(f.calls[1].options.credentials).toBe('omit');
		expect(new Headers(f.calls[1].options.headers).get('If-Match')).toBe('"revision"');
		expect(new Headers(f.calls[1].options.headers).get('Authorization')).toBe(`Bearer ${token('1', 'fresh')}`);
		expect(headers.Authorization).toBe(`Bearer ${token('1')}`);
		expect(f.listeners.size).toBe(0);
	});

	test('delayed A 401 after selecting B refreshes only A and never sends B credentials', async () => {
		const f = fixture(); const first = deferred<Response>();
		f.send(async () => f.calls.length === 1 ? first.promise : accepted());
		const pending = f.request(A + '/api/admin/users/reset-password', { method: 'POST', headers: f.headers() });
		f.select(B); first.resolve(unauthorized()); await pending;
		expect(f.refreshes).toEqual([A]);
		expect(f.calls.every(call => call.url.startsWith(A + '/api/'))).toBe(true);
		expect(new Headers(f.calls[1].options.headers).get('Authorization')).toBe(`Bearer ${token('1', 'fresh')}`);
	});

	test('explicit background A requests may refresh A while B is selected initially', async () => {
		const f = fixture(); f.select(B); f.send(async () => f.calls.length === 1 ? unauthorized() : accepted());
		await f.request(A + '/api/following/poll', { method: 'POST', headers: f.headers(A) });
		expect(f.refreshes).toEqual([A]);
	});

	test('logout and identical-credential same-account login cannot revive a pending mutation', async () => {
		const f = fixture(); const first = deferred<Response>(); f.send(() => first.promise);
		const pending = f.request(A + '/api/admin/users/reset-password', { method: 'POST', headers: f.headers() });
		f.logout(A); // deliberately retain the exact token/account to exercise ABA
		first.resolve(unauthorized());
		await expect(pending).rejects.toThrow('session changed'); expect(f.calls.length).toBe(1); expect(f.refreshes).toEqual([]);
	});

	test('replacement account without an explicit clear still cannot receive a replay', async () => {
		const f = fixture(); const first = deferred<Response>(); f.send(() => first.promise);
		const pending = f.request(A + '/api/admin/payments/blocks', { method: 'POST', headers: f.headers() });
		f.sessions.set(A, { generation: 1, accountId: '7', token: token('7') }); first.resolve(unauthorized());
		await expect(pending).rejects.toThrow('session changed'); expect(f.calls.length).toBe(1); expect(f.refreshes.length).toBe(0);
	});

	test('a new subject is rejected even before stored account metadata catches up', async () => {
		const f = fixture(); const first = deferred<Response>(); f.send(() => first.promise);
		const pending = f.request(A + '/api/admin/payments/blocks', { method: 'POST', headers: f.headers() });
		f.sessions.get(A)!.token = token('7'); first.resolve(unauthorized());
		await expect(pending).rejects.toThrow('session changed'); expect(f.calls.length).toBe(1);
	});

	test('logout during refresh cannot retry after its late completion', async () => {
		const f = fixture(); const refresh = deferred<boolean>(); const entered = deferred<void>();
		f.send(async () => unauthorized()); f.refresh(() => { entered.resolve(); return refresh.promise; });
		const pending = f.request(A + '/api/admin/users/reset-password', { method: 'POST', headers: f.headers() });
		await entered.promise; f.logout(A); refresh.resolve(true);
		await expect(pending).rejects.toThrow('session changed'); expect(f.calls.length).toBe(1);
	});

	test('a sibling refresh that completes before our 401 needs no second token rotation', async () => {
		const f = fixture(); const first = deferred<Response>(); f.send(async () => f.calls.length === 1 ? first.promise : accepted());
		const pending = f.request(A + '/api/user/settings', { headers: f.headers() });
		f.sessions.get(A)!.token = token('1', 'sibling'); first.resolve(unauthorized()); await pending;
		expect(f.refreshes.length).toBe(0);
		expect(new Headers(f.calls[1].options.headers).get('Authorization')).toBe(`Bearer ${token('1', 'sibling')}`);
	});

	test('a persistent 401 stops after one refresh even when refresh always succeeds', async () => {
		const f = fixture(); f.send(async () => unauthorized());
		expect((await f.request(A + '/api/user/settings', { headers: f.headers(), retries: 2 })).status).toBe(401);
		expect(f.refreshes).toEqual([A]); expect(f.calls.length).toBe(2);
	});

	test('same-session refresh denial returns the original 401 after removing expired credentials', async () => {
		const f = fixture(); f.send(async () => unauthorized());
		f.refresh(async server => { f.sessions.get(server)!.token = null; return false; });
		const response = await f.request(A + '/api/user/settings', { headers: f.headers(), retries: 2 });
		expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'expired' });
		expect(f.calls.length).toBe(1); expect(f.refreshes).toEqual([A]);
	});

	test('missing auth, bot/Lore/unknown tokens, auth endpoints and HTML never invoke account refresh', async () => {
		for (const authorization of [null, 'Bot bot-credential', 'Bearer wblore_scoped', `Bearer ${token('9')}`]) {
			const f = fixture(); f.send(async () => unauthorized());
			await f.request(A + '/api/addons/lore/repos', { headers: authorization ? { Authorization: authorization } : {} });
			expect(f.refreshes.length).toBe(0); expect(f.calls.length).toBe(1);
		}
		for (const path of ['/api/auth/login', '/api/auth/refresh/']) {
			const f = fixture(); f.send(async () => unauthorized()); await f.request(A + path, { headers: f.headers() }); expect(f.refreshes.length).toBe(0);
		}
		const f = fixture(); f.send(async () => new Response('<html>login</html>', { status: 401, headers: { 'Content-Type': 'text/html' } }));
		await f.request(A + '/api/user/settings', { headers: f.headers() }); expect(f.refreshes.length).toBe(0);
	});
});

describe('bounded transport and cancellation', () => {
	test('already-aborted callers never issue a request', async () => {
		const f = fixture(); const controller = new AbortController(); controller.abort();
		await expect(f.request(A + '/api/channels', { signal: controller.signal, retries: 2 })).rejects.toThrow(); expect(f.calls.length).toBe(0);
	});

	test('caller cancellation aborts a hanging fetch without retrying', async () => {
		const f = fixture(); const controller = new AbortController(); f.send(() => new Promise(() => {}));
		const pending = f.request(A + '/api/channels', { signal: controller.signal, retries: 2 }); controller.abort(new Error('Caller cancelled'));
		await expect(pending).rejects.toThrow('Caller cancelled'); expect(f.calls.length).toBe(1); expect(f.calls[0].options.signal?.aborted).toBe(true);
	});

	test('caller cancellation during shared refresh settles without a late replay', async () => {
		const f = fixture(); const controller = new AbortController(); const entered = deferred<void>(); const refresh = deferred<boolean>();
		f.send(async () => unauthorized()); f.refresh(() => { entered.resolve(); return refresh.promise; });
		const pending = f.request(A + '/api/channels', { headers: f.headers(), signal: controller.signal });
		await entered.promise; controller.abort(); await expect(pending).rejects.toThrow(); refresh.resolve(true);
		await Promise.resolve(); expect(f.calls.length).toBe(1);
	});

	test('native signal composition preserves caller cancellation for a returned response body', async () => {
		const f = fixture(); const controller = new AbortController();
		await f.request(A + '/api/addons/lore/files/readme', { signal: controller.signal });
		controller.abort(); expect(f.calls[0].options.signal?.aborted).toBe(true);
	});

	test('deadlines bound fetch and refresh even when they ignore abort', async () => {
		for (const duringRefresh of [false, true]) {
			const f = fixture(); f.send(async () => duringRefresh ? unauthorized() : new Promise(() => {})); f.refresh(() => new Promise(() => {}));
			await expect(f.request(A + '/api/channels', { headers: f.headers(), timeoutMs: 1, retries: 2 })).rejects.toThrow('timed out');
			expect(f.calls.length).toBe(1); expect(f.calls[0].options.signal?.aborted).toBe(true);
		}
	});

	test('configured network failures have one finite budget across auth refresh', async () => {
		const f = fixture(); f.send(async () => {
			if (f.calls.length === 1 || f.calls.length === 3) throw new TypeError('network');
			return f.calls.length === 2 ? unauthorized() : accepted();
		});
		expect((await f.request(A + '/api/channels', { headers: f.headers(), retries: 2 })).status).toBe(200);
		expect(f.calls.length).toBe(4); expect(f.refreshes).toEqual([A]);
		const exhausted = fixture(); exhausted.send(async () => { throw new TypeError('offline'); });
		await expect(exhausted.request(A + '/api/channels', { retries: 2 })).rejects.toThrow('offline'); expect(exhausted.calls.length).toBe(3);
	});

	test('abort or logout during retry backoff prevents another network attempt', async () => {
		for (const logout of [false, true]) {
			const f = fixture(); const controller = new AbortController(); const failed = deferred<void>();
			f.send(async () => { failed.resolve(); throw new TypeError('offline'); });
			const pending = f.request(A + '/api/channels', { headers: f.headers(), retries: 2, signal: controller.signal });
			await failed.promise; await Promise.resolve();
			if (logout) f.logout(A); else controller.abort();
			await expect(pending).rejects.toThrow(); expect(f.calls.length).toBe(1);
		}
	});

	test('HTTP failures and non-replayable streaming bodies are not automatically resubmitted', async () => {
		const f = fixture(); f.send(async () => new Response('{}', { status: 503 }));
		expect((await f.request(A + '/api/channels', { retries: 2 })).status).toBe(503); expect(f.calls.length).toBe(1);
		const stream = fixture(); stream.send(async () => unauthorized());
		await stream.request(A + '/api/upload', { headers: stream.headers(), method: 'POST', body: new ReadableStream(), retries: 2 });
		expect(stream.calls.length).toBe(1); expect(stream.refreshes.length).toBe(0);
	});
});
