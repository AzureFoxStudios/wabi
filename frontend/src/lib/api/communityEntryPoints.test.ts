import { beforeEach, expect, mock, test } from 'bun:test';

mock.module('$app/environment', () => ({ browser: true, dev: false, building: false }));

function memoryStorage(): Storage {
	const values = new Map<string, string>();
	return {
		get length() { return values.size; }, clear() { values.clear(); },
		getItem(key: string) { return values.get(key) ?? null; },
		key(index: number) { return [...values.keys()][index] ?? null; },
		removeItem(key: string) { values.delete(key); },
		setItem(key: string, value: string) { values.set(key, value); }
	};
}

function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
	globalThis.fetch = Object.assign(handler, { preconnect: () => {} });
}

Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
Object.defineProperty(globalThis, 'sessionStorage', { value: memoryStorage(), configurable: true });
Object.defineProperty(globalThis, 'window', {
	value: { location: { origin: 'https://app.example', hostname: 'app.example', port: '', protocol: 'https:' } },
	configurable: true
});
Object.defineProperty(globalThis, 'document', { value: {}, configurable: true });

const { setAuthToken, clearAuthSession } = await import('../authSession');
const { readCommunityEntryPoints, publishCommunityEntryPoints } = await import('./communityEntryPoints');

function base64url(bytes: ArrayBuffer | Uint8Array): string {
	const octets = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	return btoa(String.fromCharCode(...octets)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signedRoster(version: number) {
	const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
	const publicKey = await crypto.subtle.exportKey('raw', keys.publicKey);
	const communityId = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey)),
		(byte) => byte.toString(16).padStart(2, '0')).join('');
	const issuedAt = Math.floor(Date.now() / 1000);
	const body = {
		schemaVersion: 1, communityId, version, issuedAt, expiresAt: issuedAt + 3600,
		entries: [{ nodeId: 'site_a', role: 'authority' as const, url: 'https://site-a.example' }]
	};
	const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey,
		new TextEncoder().encode(JSON.stringify(body)));
	return { body, publicKey: base64url(publicKey), signature: base64url(signature) };
}

beforeEach(() => {
	localStorage.clear(); sessionStorage.clear();
	setAuthToken('owner-access', 'https://site-a.example');
});

test('read treats an unpublished roster as empty and rejects an altered signature', async () => {
	stubFetch(async () => new Response(null, { status: 404 }));
	expect(await readCommunityEntryPoints('https://site-a.example')).toBeNull();
	const roster = await signedRoster(1);
	stubFetch(async () => Response.json({ ...roster, body: { ...roster.body, version: 2 } }));
	await expect(readCommunityEntryPoints('https://site-a.example')).rejects.toThrow('invalid signed');
});

test('publish re-proves the owner password and verifies the signed update', async () => {
	const roster = await signedRoster(1);
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	stubFetch(async (input, init) => {
		calls.push({ url: String(input), init });
		return calls.length === 1 ? Response.json({ stepupToken: 'short-lived-proof' }) : Response.json(roster);
	});
	const result = await publishCommunityEntryPoints('https://site-a.example', 'password123', 0, roster.body.entries);
	expect(result.body.version).toBe(1);
	expect(calls.map((call) => call.url)).toEqual([
		'https://site-a.example/api/auth/stepup', 'https://site-a.example/api/community/roster'
	]);
	expect(JSON.parse(String(calls[0].init?.body))).toEqual({ password: 'password123' });
	expect(JSON.parse(String(calls[1].init?.body))).toEqual({ expectedVersion: 0, entries: roster.body.entries });
	expect((calls[1].init?.headers as Record<string, string>)['X-Stepup-Token']).toBe('short-lived-proof');
});

test('session change after step-up prevents sending the roster update', async () => {
	let calls = 0;
	stubFetch(async () => {
		calls++;
		clearAuthSession('https://site-a.example');
		return Response.json({ stepupToken: 'stale-proof' });
	});
	await expect(publishCommunityEntryPoints('https://site-a.example', 'password123', 0,
		[{ nodeId: 'site_a', role: 'authority', url: 'https://site-a.example' }])).rejects.toThrow('session changed');
	expect(calls).toBe(1);
});
