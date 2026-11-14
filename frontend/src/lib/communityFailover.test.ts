/**
 * Community failover with the REAL pin store, real roster signatures and the real
 * SocketReconnectionManager; only auth storage and the saved-server list are in-memory fakes.
 * docs/audits/2026-11-hostile-server-audit.md: R1 (another server's roster must not decide where a
 * server's token goes), R2 (no session written over another server's identity), F3 (two hops
 * inside one community still work offline).
 */
import { beforeEach, expect, mock, test } from 'bun:test';

mock.module('$app/environment', () => ({ browser: false, dev: false, building: false }));
if (typeof globalThis.localStorage === 'undefined') {
	const data = new Map<string, string>();
	(globalThis as any).localStorage = {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, String(value)),
		removeItem: (key: string) => void data.delete(key),
		clear: () => data.clear()
	};
}

const roster = await import('./communityRoster');
const { SocketReconnectionManager } = await import('./socketConnectionReconnect');
type Roster = Awaited<ReturnType<typeof signed>>;

function base64url(bytes: ArrayBuffer | Uint8Array): string {
	const octets = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	return btoa(String.fromCharCode(...octets)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signed(urls: string[], version = 1) {
	const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
	const publicKey = await crypto.subtle.exportKey('raw', keys.publicKey);
	const communityId = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey)),
		(byte) => byte.toString(16).padStart(2, '0')).join('');
	const issuedAt = Math.floor(Date.now() / 1000);
	const body = {
		schemaVersion: 1, communityId, version, issuedAt, expiresAt: issuedAt + 3600,
		entries: urls.map((url, index) => ({ nodeId: `n${index}`, role: index === 0 ? 'authority' as const : 'anchor' as const, url }))
	};
	const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(JSON.stringify(body)));
	return { body, publicKey: base64url(publicKey), signature: base64url(signature) };
}

let active = '';
const tokens = new Map<string, string>();
const accounts = new Map<string, number>();
const usernames = new Map<string, string>();
const saved = new Set<string>();
const env = {
	getAuthToken: (url: string) => tokens.get(url) ?? null,
	getStoredDbUserId: (url: string) => accounts.get(url) ?? null,
	getStoredUsername: (url: string) => usernames.get(url) ?? null,
	isSavedServer: (url: string) => saved.has(url)
};
function manager() {
	return new SocketReconnectionManager({
		getServerUrl: () => active,
		setConfiguredServerUrl: (url: string) => { active = url; return url; },
		getConfiguredServerRememberPreference: () => true,
		authSessionGeneration: () => 0,
		getAuthToken: (url?: string | null) => tokens.get(url ?? active) ?? null,
		getStoredDbUserId: (url?: string | null) => accounts.get(url ?? active) ?? null,
		getStoredUsername: (url?: string | null) => usernames.get(url ?? active) ?? null,
		setAuthToken: (value: string | null | undefined, url?: string | null) => { if (value) tokens.set(url ?? active, value); },
		setStoredDbUserId: (value: number | string | null | undefined, url?: string | null) => { if (value != null) accounts.set(url ?? active, Number(value)); },
		setStoredUsername: (value: string | null | undefined, url?: string | null) => { if (value) usernames.set(url ?? active, value); },
		canCarrySessionTo: roster.canCarrySessionTo,
		getPinnedCommunityRoster: (url: string, accountId: number) => roster.getPinnedCommunityRoster(url, accountId, env),
		prepareSessionCarry: (value: Roster, from: string, to: string, accountId: number, token: string) =>
			roster.prepareSessionCarry(value, from, to, accountId, token, env),
		// The community is offline: no roster can be fetched from any address after the first.
		refreshCommunityRoster: async () => null
	} as any);
}
function signIn(url: string, token: string, id = 7, name = 'member') {
	tokens.set(url, token); accounts.set(url, id); usernames.set(url, name); saved.add(url);
}

const A = 'https://a.example', ANCHOR1 = 'https://anchor1.example', ANCHOR2 = 'https://anchor2.example';
const B = 'https://b.example', EVIL = 'https://evil.example';

beforeEach(() => {
	localStorage.removeItem('wabi.communityRosterPins.v1');
	tokens.clear(); accounts.clear(); usernames.clear(); saved.clear();
	active = A;
});

test('F3: two hops inside one community work offline, and the session can come back', async () => {
	const community = await signed([A, ANCHOR1, ANCHOR2]);
	signIn(A, 'member-token');
	expect(roster.pinCommunityRoster(community, A, 7)).toBe(true);
	const reconnect = manager();
	expect(await reconnect.rotateToNextFailoverCandidate(A)).toEqual({ rotated: true, nextUrl: ANCHOR1 });
	expect(tokens.get(ANCHOR1)).toBe('member-token');
	// anchor1 is unreachable for its own roster; the carried pin is what the second hop follows.
	expect(await reconnect.rotateToNextFailoverCandidate(ANCHOR1)).toEqual({ rotated: true, nextUrl: ANCHOR2 });
	expect(await reconnect.rotateToNextFailoverCandidate(ANCHOR2)).toEqual({ rotated: true, nextUrl: A });
	expect(active).toBe(A);
});

test('F3: a carried pin speaks only for the carried session; a later login there ignores it', async () => {
	const community = await signed([A, ANCHOR1, ANCHOR2]);
	signIn(A, 'member-token');
	roster.pinCommunityRoster(community, A, 7);
	expect(await manager().rotateToNextFailoverCandidate(A)).toEqual({ rotated: true, nextUrl: ANCHOR1 });
	expect(await roster.getPinnedCommunityRoster(ANCHOR1, 7, env)).not.toBeNull();
	tokens.set(ANCHOR1, 'a-different-login');
	expect(await roster.getPinnedCommunityRoster(ANCHOR1, 7, env)).toBeNull();
});

test('R1: a hostile roster from A never steers B: no pin, no carry, in every state B can be in', async () => {
	const hostile = await signed([A, B, EVIL]);
	signIn(A, 'a-token');
	signIn(B, 'b-token');
	expect(roster.pinCommunityRoster(hostile, A, 7)).toBe(true);
	// B's own failover finds nothing to follow.
	active = B;
	expect(await manager().rotateToNextFailoverCandidate(B)).toEqual({ rotated: false, nextUrl: null });
	expect(tokens.has(EVIL)).toBe(false);
	// A's failover may not write A's session over B: with B's token present...
	active = A;
	expect(await roster.prepareSessionCarry(hostile, A, B, 7, 'a-token', env)).toBe(false);
	// ...after a desktop restart (B's token is in the OS store, so not visible here; R2)...
	tokens.delete(B);
	expect(await roster.prepareSessionCarry(hostile, A, B, 7, 'a-token', env)).toBe(false);
	// ...or when B is saved but was never signed in.
	accounts.delete(B); usernames.delete(B);
	expect(await roster.prepareSessionCarry(hostile, A, B, 7, 'a-token', env)).toBe(false);
	expect(await roster.getPinnedCommunityRoster(B, 7, env)).toBeNull();
	// A rotating carries A's own session only to an address with no identity: the attacker host.
	expect(await manager().rotateToNextFailoverCandidate(A)).toEqual({ rotated: true, nextUrl: EVIL });
	expect(tokens.get(EVIL)).toBe('a-token');
	expect(tokens.get(B)).toBeUndefined();
	expect(accounts.get(B)).toBeUndefined();
});

test('R2: a switch never writes one server\'s session over another saved server', async () => {
	const community = await signed([A, B]);
	signIn(A, 'a-token');
	saved.add(B);
	roster.pinCommunityRoster(community, A, 7);
	expect(await roster.prepareSessionCarry(community, A, B, 7, 'a-token', env)).toBe(false);
	// Opened without saving (openUnsavedServer) and signed in: after a restart its token is not
	// visible, but its stored account id and username are its own identity.
	saved.delete(B);
	accounts.set(B, 7);
	usernames.set(B, 'someone-else');
	expect(await roster.prepareSessionCarry(community, A, B, 7, 'a-token', env)).toBe(false);
	accounts.delete(B);
	expect(await roster.prepareSessionCarry(community, A, B, 7, 'a-token', env)).toBe(false);
	usernames.delete(B);
	saved.add(B);
	// Same session already there (carried earlier): allowed.
	tokens.set(B, 'a-token');
	expect(await roster.prepareSessionCarry(community, A, B, 7, 'a-token', env)).toBe(true);
});

test('a pin is never rolled back to an older version of the same roster', async () => {
	const keyed = await signed([A], 3);
	expect(roster.pinCommunityRoster(keyed, A, 7)).toBe(true);
	// pinCommunityRoster runs after verification (refreshCommunityRoster), so it is given the
	// same key with an older version directly: it must be refused and version 3 must stay.
	const older = { ...keyed, body: { ...keyed.body, version: 2 } };
	expect(roster.pinCommunityRoster(older, A, 7)).toBe(false);
	const pins = JSON.parse(localStorage.getItem('wabi.communityRosterPins.v1')!);
	expect(Object.values(pins).map((pin: any) => pin.version)).toEqual([3]);
});

test('N1: after a restart the anchor a carry created is not mistaken for a separate server', async () => {
	const community = await signed([A, ANCHOR1, ANCHOR2]);
	signIn(A, 'member-token');
	roster.pinCommunityRoster(community, A, 7);
	// Outage 1: carry to anchor1, connect (the app saves the address it connected to).
	expect(await manager().rotateToNextFailoverCandidate(A)).toEqual({ rotated: true, nextUrl: ANCHOR1 });
	saved.add(ANCHOR1);
	// Back on A; restart: anchor1's session-only token is gone, its username, account id and
	// saved entry remain.
	active = A;
	tokens.delete(ANCHOR1);
	expect(accounts.get(ANCHOR1)).toBe(7);
	// Outage 2 rotates again, as main's code did.
	expect(await manager().rotateToNextFailoverCandidate(A)).toEqual({ rotated: true, nextUrl: ANCHOR1 });
	expect(tokens.get(ANCHOR1)).toBe('member-token');
});

test('N1: the carried provenance never lets a different community or account in', async () => {
	const community = await signed([A, ANCHOR1]);
	signIn(A, 'member-token');
	roster.pinCommunityRoster(community, A, 7);
	expect(await manager().rotateToNextFailoverCandidate(A)).toEqual({ rotated: true, nextUrl: ANCHOR1 });
	saved.add(ANCHOR1);
	tokens.delete(ANCHOR1);
	// Someone signs in at anchor1 directly with another account: that identity is its own now.
	accounts.set(ANCHOR1, 8);
	expect(await roster.prepareSessionCarry(community, A, ANCHOR1, 7, 'member-token', env)).toBe(false);
	accounts.set(ANCHOR1, 7);
	// A roster with another key (another server listing anchor1) gets no benefit from that pin.
	const other = await signed([B, ANCHOR1]);
	signIn(B, 'b-token');
	expect(await roster.prepareSessionCarry(other, B, ANCHOR1, 7, 'b-token', env)).toBe(false);
	// The real community still may.
	expect(await roster.prepareSessionCarry(community, A, ANCHOR1, 7, 'member-token', env)).toBe(true);
});

test('R1/R2: B with its identity in storage and its token only in the OS store is never written over', async () => {
	const hostile = await signed([A, B, EVIL]);
	signIn(A, 'a-token');
	signIn(B, 'b-token');
	tokens.delete(B);
	roster.pinCommunityRoster(hostile, A, 7);
	expect(await roster.prepareSessionCarry(hostile, A, B, 7, 'a-token', env)).toBe(false);
	saved.delete(B);
	expect(await roster.prepareSessionCarry(hostile, A, B, 7, 'a-token', env)).toBe(false);
	expect(await manager().rotateToNextFailoverCandidate(A)).toEqual({ rotated: true, nextUrl: EVIL });
	expect(accounts.get(B)).toBe(7);
	expect(tokens.get(B)).toBeUndefined();
});

test('N4: a carry never replaces the address\'s own pin of another key', async () => {
	const community = await signed([A, ANCHOR1]);
	const anchorsOwn = await signed([ANCHOR1]);
	signIn(A, 'member-token');
	roster.pinCommunityRoster(community, A, 7);
	expect(roster.pinCommunityRoster(anchorsOwn, ANCHOR1, 7)).toBe(true);
	expect(await roster.prepareSessionCarry(community, A, ANCHOR1, 7, 'member-token', env)).toBe(false);
	const pins = JSON.parse(localStorage.getItem('wabi.communityRosterPins.v1')!);
	const anchorPin = pins[`${encodeURIComponent(ANCHOR1)}|7`];
	expect(anchorPin.publicKey).toBe(anchorsOwn.publicKey);
	expect(anchorPin.carriedFrom).toBeUndefined();
});

test('N4: the manual switch goes through prepareSessionCarry before writing any session (wiring)', async () => {
	const { readFileSync } = await import('node:fs');
	const source = readFileSync(new URL('./savedServerActions.ts', import.meta.url), 'utf8').replace(/\/\/[^\n]*/g, '');
	const body = source.slice(source.indexOf('export function switchToSavedServer('), source.indexOf('export function switchToSavedServerChannel('));
	const carry = body.indexOf('await prepareSessionCarry(roster, fromUrl, normalizedUrl, accountId, token)');
	const write = body.indexOf('setAuthToken(token, normalizedUrl)');
	expect(carry).toBeGreaterThan(0);
	expect(write).toBeGreaterThan(carry);
	expect(body.slice(carry, write)).toMatch(/if \(carry &&/);
	expect(body.match(/setAuthToken\(/g)?.length).toBe(1);
});
