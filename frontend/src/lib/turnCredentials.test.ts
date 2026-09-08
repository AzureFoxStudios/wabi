import { expect, test } from 'bun:test';
import { createTurnCredentialSource, readTurnCredentials, readTurnEndpoint, stunUrl, turnUrls, type TurnCredentialScope } from './turnCredentials';

const alpha: TurnCredentialScope = { server: 'https://alpha.test/wabi', account: '1', generation: 1, token: 'alpha-access', preferredRelayId: null };
const wire = (overrides = {}) => ({ turn: { server: 'turn.alpha.test', port: 3478, useTurns: false, username: '4000:1', credential: 'ephemeral-canary', expiresAt: 4000, ...overrides } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(timeoutMs = 1000) {
	let context: TurnCredentialScope | null = { ...alpha };
	let now = 1000;
	let send: (url: string, token: string, signal: AbortSignal) => Promise<Response> = async () => Response.json(wire());
	const requests: { url: string; token: string; signal: AbortSignal }[] = [];
	const source = createTurnCredentialSource({ context: () => context ? { ...context } : null, now: () => now, timeoutMs,
		request: (url, token, signal) => { requests.push({ url, token, signal }); return send(url, token, signal); } });
	return { source, requests, send: (next: typeof send) => { send = next; },
		select: (next: TurnCredentialScope | null) => { context = next; source.reconcile(); },
		time: (next: number) => { now = next; } };
}

test('runtime endpoints generate self-hosted STUN and valid UDP/TCP TURN, including IPv6', () => {
	for (const host of ['turn.alpha.test', '[2001:db8::1]', '2001:db8::1']) {
		const endpoint = readTurnEndpoint(host, 3478, false)!;
		const normalized = host.includes(':') ? '[2001:db8::1]' : host;
		expect(turnUrls(endpoint)).toEqual([`turn:${normalized}:3478?transport=udp`, `turn:${normalized}:3478?transport=tcp`]);
		expect(stunUrl(endpoint)).toBe(`stun:${normalized}:3478`);
	}
	const tls = readTurnEndpoint('turn.alpha.test', '5349', true)!;
	expect(turnUrls(tls)).toEqual(['turns:turn.alpha.test:5349?transport=tcp']);
	expect(stunUrl(tls)).toBeNull();
});

test('invalid endpoints and unusable credential responses never reach RTC configuration', () => {
	for (const server of ['', 'https://turn.test', 'turn:turn.test', 'turn.test:3478', 'user@turn.test', 'turn.test/path', 'turn.test?transport=tcp', 'bad host', '[::1]:3478', '[::1]:80', 'turn.test\\']) {
		expect(readTurnEndpoint(server, 3478, false)).toBeNull();
	}
	for (const port of [0, -1, 65536, 12.5, '', '3478suffix', null, true]) expect(readTurnEndpoint('turn.test', port, false)).toBeNull();
	for (const payload of [null, {}, wire({ username: '' }), wire({ credential: '' }), wire({ expiresAt: 1030 }), wire({ expiresAt: Infinity }), wire({ useTurns: 'false' }), wire({ server: 'bad/host' })]) {
		expect(readTurnCredentials(payload, 1000)).toBeNull();
	}
	expect(readTurnCredentials(wire(), 1000)?.credential).toBe('ephemeral-canary');
});

test('one scoped issuance coalesces callers and caches only usable credentials', async () => {
	const f = fixture(); const response = deferred<Response>(); f.send(() => response.promise);
	const a = f.source.prefetch(); const b = f.source.prefetch();
	expect(a).toBe(b); await Promise.resolve(); expect(f.requests).toHaveLength(1);
	expect(f.requests[0].url).toBe('https://alpha.test/wabi/api/media/turn-credentials');
	expect(f.requests[0].token).toBe('alpha-access'); expect(f.source.get()).toBeNull();
	response.resolve(Response.json(wire())); await a;
	expect(f.source.get()?.username).toBe('4000:1'); await f.source.prefetch(); expect(f.requests).toHaveLength(1);
	const copy = f.source.get()!; copy.credential = 'changed'; expect(f.source.get()?.credential).toBe('ephemeral-canary');
	f.time(3970); expect(f.source.get()).toBeNull();
});

test('server, account, generation and preferred-relay changes cannot reuse cached credentials', async () => {
	for (const next of [{ ...alpha, server: 'https://beta.test' }, { ...alpha, account: '2', token: 'beta-access' }, { ...alpha, generation: 2 }, { ...alpha, preferredRelayId: 7 }, null]) {
		const f = fixture(); await f.source.prefetch(); expect(f.source.get()).not.toBeNull();
		f.select(next); expect(f.source.get()).toBeNull();
	}
});

test('same-account access renewal preserves valid TURN credentials', async () => {
	const f = fixture(); await f.source.prefetch();
	f.select({ ...alpha, token: 'alpha-refreshed' });
	expect(f.source.get()).not.toBeNull(); await f.source.prefetch(); expect(f.requests).toHaveLength(1);
});

test('A→B→A, logout ABA and relay reselection cancel old work without joining or deleting the replacement', async () => {
	for (const other of [{ ...alpha, server: 'https://beta.test' }, { ...alpha, preferredRelayId: 7 }, null]) {
		const f = fixture(); const old = deferred<Response>(); const fresh = deferred<Response>();
		f.send(() => f.requests.length === 1 ? old.promise : fresh.promise);
		const retired = f.source.prefetch(); await Promise.resolve();
		f.select(other); f.select({ ...alpha, generation: other === null ? 2 : 1 });
		const current = f.source.prefetch(); await Promise.resolve(); expect(f.requests).toHaveLength(2);
		expect(f.requests[0].signal.aborted).toBe(true);
		old.resolve(Response.json(wire({ credential: 'retired' }))); await retired;
		expect(f.source.get()).toBeNull(); expect(f.source.prefetch()).toBe(current);
		fresh.resolve(Response.json(wire({ credential: 'current' }))); await current;
		expect(f.source.get()?.credential).toBe('current');
	}
});

test('selection switches while consuming response JSON cannot publish old credentials', async () => {
	const f = fixture(); const body = deferred<unknown>(); const entered = deferred<void>();
	f.send(async () => ({ ok: true, json: () => { entered.resolve(); return body.promise; } }) as Response);
	const pending = f.source.prefetch(); await entered.promise;
	f.select({ ...alpha, account: '2', token: 'other-token' }); body.resolve(wire()); await pending;
	expect(f.source.get()).toBeNull();
});

test('preferred relay belongs to the request scope even when server falls back to origin', async () => {
	const f = fixture(); f.select({ ...alpha, preferredRelayId: 7 }); await f.source.prefetch();
	expect(f.requests[0].url).toEndWith('?relayId=7');
	// Cache by the requested selection, not the optional returned relayId.
	expect(f.source.get()).not.toBeNull(); await f.source.prefetch(); expect(f.requests).toHaveLength(1);
});

test('disabled, denied, unavailable or malformed credentials do not become usable or block a later retry', async () => {
	for (const status of [400, 401, 403, 503]) {
		const f = fixture(); f.send(async () => new Response('{}', { status }));
		await f.source.prefetch(); expect(f.source.get()).toBeNull();
		f.send(async () => Response.json(wire())); await f.source.prefetch(); expect(f.source.get()).not.toBeNull();
	}
	const f = fixture(); f.send(async () => new Response('not json')); await f.source.prefetch(); expect(f.source.get()).toBeNull();
});

test('the complete credential request including a stalled body has a bounded deadline', async () => {
	for (const stalledBody of [false, true]) {
		const f = fixture(2);
		f.send(() => stalledBody ? Promise.resolve({ ok: true, json: () => new Promise(() => {}) } as Response) : new Promise(() => {}));
		await f.source.prefetch(); expect(f.source.get()).toBeNull(); expect(f.requests[0].signal.aborted).toBe(true);
		f.send(async () => Response.json(wire())); await f.source.prefetch(); expect(f.source.get()).not.toBeNull();
	}
});

test('without an authenticated session prefetch is immediate and performs no network work', async () => {
	const f = fixture(); f.select(null); await f.source.prefetch();
	expect(f.requests).toHaveLength(0); expect(f.source.get()).toBeNull();
});
