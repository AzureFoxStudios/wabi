import { expect, mock, test } from 'bun:test';

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

const { verifyCommunityRoster, canCarrySessionTo, pinCommunityRoster, getPinnedCommunityRoster } = await import('./communityRoster');

function base64url(bytes: ArrayBuffer | Uint8Array): string {
	const octets = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	return btoa(String.fromCharCode(...octets)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

test('accepts a correctly signed roster and rejects changed destinations', async () => {
	const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
	const publicKey = await crypto.subtle.exportKey('raw', keys.publicKey);
	const communityId = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey)),
		(byte) => byte.toString(16).padStart(2, '0')).join('');
	const issuedAt = Math.floor(Date.now() / 1000);
	const body = {
		schemaVersion: 1, communityId, version: 1, issuedAt,
		expiresAt: issuedAt + 3600,
		entries: [
			{ nodeId: 'site_a', role: 'authority' as const, url: 'https://a.example' },
			{ nodeId: 'site_b', role: 'anchor' as const, url: 'https://b.example' }
		]
	};
	const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey,
		new TextEncoder().encode(JSON.stringify(body)));
	const signed = { body, publicKey: base64url(publicKey), signature: base64url(signature) };
	expect(await verifyCommunityRoster(signed)).not.toBeNull();
	expect(canCarrySessionTo(signed, 'https://b.example')).toBe(true);
	expect(canCarrySessionTo(signed, 'https://c.example')).toBe(false);
	expect(canCarrySessionTo(signed, 'http://100.64.1.2:3001')).toBe(false);
	expect(await verifyCommunityRoster({ ...signed, body: { ...body, entries: [
		body.entries[0], { ...body.entries[1], url: 'https://evil.example' }
	] } })).toBeNull();
	expect(await verifyCommunityRoster({ ...signed, body: { ...body, expiresAt: issuedAt - 1 } })).toBeNull();
});

async function signedRoster(urls: string[], version = 1) {
	const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
	const publicKey = await crypto.subtle.exportKey('raw', keys.publicKey);
	const communityId = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey)),
		(byte) => byte.toString(16).padStart(2, '0')).join('');
	const issuedAt = Math.floor(Date.now() / 1000);
	const body = {
		schemaVersion: 1, communityId, version, issuedAt, expiresAt: issuedAt + 3600,
		entries: urls.map((url, index) => ({ nodeId: `site_${String.fromCharCode(97 + index)}`, role: index === 0 ? 'authority' as const : 'anchor' as const, url }))
	};
	const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey,
		new TextEncoder().encode(JSON.stringify(body)));
	return { body, publicKey: base64url(publicKey), signature: base64url(signature) };
}

// Hostile-server audit, finding R1: server A's roster must not decide where server B's token goes.
test("a roster from one server is pinned only under that server, never under another saved server's address", async () => {
	localStorage.removeItem('wabi.communityRosterPins.v1');
	const accountId = 1;
	const hostile = await signedRoster(['https://a.example', 'https://b.example', 'https://evil.example']);
	expect(await verifyCommunityRoster(hostile)).not.toBeNull();
	expect(pinCommunityRoster(hostile, 'https://a.example', accountId)).toBe(true);
	// A's failover may follow A's own roster...
	expect(await getPinnedCommunityRoster('https://a.example', accountId)).not.toBeNull();
	// ...but nothing is pinned for B or the attacker host, so B's failover has no roster to follow.
	expect(await getPinnedCommunityRoster('https://b.example', accountId)).toBeNull();
	expect(await getPinnedCommunityRoster('https://evil.example', accountId)).toBeNull();

	// B's own roster is still accepted and is what B's failover uses.
	const honest = await signedRoster(['https://b.example', 'https://b-anchor.example']);
	expect(pinCommunityRoster(honest, 'https://b.example', accountId)).toBe(true);
	const pinned = await getPinnedCommunityRoster('https://b.example', accountId);
	expect(pinned?.publicKey).toBe(honest.publicKey);
	expect(canCarrySessionTo(pinned!, 'https://evil.example')).toBe(false);
	// And a later hostile roster served by A cannot replace it.
	expect(pinCommunityRoster(hostile, 'https://a.example', accountId)).toBe(true);
	expect((await getPinnedCommunityRoster('https://b.example', accountId))?.publicKey).toBe(honest.publicKey);
});

test('a roster is refused as a pin for an address it does not list, and pins from before the fix are ignored', async () => {
	localStorage.removeItem('wabi.communityRosterPins.v1');
	const roster = await signedRoster(['https://a.example', 'https://evil.example']);
	expect(pinCommunityRoster(roster, 'https://b.example', 1)).toBe(false);
	// The pre-fix format pinned every listed URL and carried no source.
	localStorage.setItem('wabi.communityRosterPins.v1', JSON.stringify({
		[`${encodeURIComponent('https://evil.example')}|1`]: { publicKey: roster.publicKey, version: 1, roster }
	}));
	expect(await getPinnedCommunityRoster('https://evil.example', 1)).toBeNull();
	// The pre-fix pin does not block the address's own roster either.
	const own = await signedRoster(['https://evil.example']);
	expect(pinCommunityRoster(own, 'https://evil.example', 1)).toBe(true);
	expect((await getPinnedCommunityRoster('https://evil.example', 1))?.publicKey).toBe(own.publicKey);
});

test('the source keeps its key: a different key or an older version is not pinned over its own pin', async () => {
	localStorage.removeItem('wabi.communityRosterPins.v1');
	const first = await signedRoster(['https://a.example'], 2);
	expect(pinCommunityRoster(first, 'https://a.example', 1)).toBe(true);
	const otherKey = await signedRoster(['https://a.example'], 3);
	expect(pinCommunityRoster(otherKey, 'https://a.example', 1)).toBe(false);
	expect((await getPinnedCommunityRoster('https://a.example', 1))?.publicKey).toBe(first.publicKey);
});
