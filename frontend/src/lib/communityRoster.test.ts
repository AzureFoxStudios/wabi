import { expect, mock, test } from 'bun:test';

mock.module('$app/environment', () => ({ browser: false, dev: false, building: false }));

const { verifyCommunityRoster, canCarrySessionTo } = await import('./communityRoster');

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
