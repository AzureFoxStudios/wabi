import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_INVITE_HOURS,
	INVITE_LIFETIMES,
	createInvite,
	invitationLink,
	inviteReach,
	listInvites,
	outstandingInvites,
	revokeInvite,
	timeLeft
} from './invitations';

const token = 'ab'.repeat(32);

describe('browser invitations', () => {
	test('lifetimes stay inside what the server accepts, with one day as the default', () => {
		expect(DEFAULT_INVITE_HOURS).toBe(24);
		for (const choice of INVITE_LIFETIMES) expect(choice.hours >= 1 && choice.hours <= 168).toBe(true);
	});

	test('says who could open a link made from the address in use', () => {
		expect(inviteReach('https://chat.example.org')).toBe('anywhere');
		expect(inviteReach('https://chat.example.org:8443')).toBe('anywhere');
		for (const lan of ['http://192.168.1.20:3000', 'http://10.0.0.5', 'http://172.20.1.1:3001', 'https://192.168.1.20', 'https://nas.local', 'https://100.101.102.103']) {
			expect(inviteReach(lan)).toBe('network');
		}
		for (const self of ['http://localhost:3000', 'http://127.0.0.1:5173', 'http://[::1]:3000', 'https://localhost', 'http://app.localhost']) {
			expect(inviteReach(self)).toBe('this-device');
		}
		// Plain HTTP to anything but a private IPv4 is refused by the join page (hostInvites.ts).
		for (const insecure of ['http://chat.example.org', 'http://203.0.113.9:3000', 'http://nas.local:3000']) {
			expect(inviteReach(insecure)).toBe('needs-https');
		}
	});

	test('links come from the address in use and keep the HTTPS rule', () => {
		expect(invitationLink('https://chat.example.org/', token)).toBe(`https://chat.example.org/join#invite=${token}`);
		expect(invitationLink('http://192.168.1.20:3000', token)).toBe(`http://192.168.1.20:3000/join#invite=${token}`);
		expect(() => invitationLink('http://chat.example.org', token)).toThrow();
		expect(() => invitationLink('http://localhost:3000', token)).toThrow();
	});

	test('only invitations that can still admit someone are listed as waiting', () => {
		const now = 1_000;
		const waiting = outstandingInvites([
			{ id: 'later', expiresAt: 5_000, consumed: false, revoked: false },
			{ id: 'used', expiresAt: 5_000, consumed: true, revoked: false },
			{ id: 'cancelled', expiresAt: 5_000, consumed: false, revoked: true },
			{ id: 'expired', expiresAt: 1_000, consumed: false, revoked: false },
			{ id: 'sooner', expiresAt: 2_000, consumed: false, revoked: false }
		], now);
		expect(waiting.map((invite) => invite.id)).toEqual(['sooner', 'later']);
	});

	test('time left is said in whole units and never as zero', () => {
		expect(timeLeft(100, 100)).toBe('in 1 minute');
		expect(timeLeft(45 * 60, 0)).toBe('in 45 minutes');
		expect(timeLeft(24 * 3600, 0)).toBe('in 24 hours');
		expect(timeLeft(7 * 24 * 3600, 0)).toBe('in 7 days');
	});

	test('talks to the owner-only API with a bearer token and never sends the token in a URL', async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const reply = (status: number, body: unknown) => async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return new Response(JSON.stringify(body), { status });
		};
		const created = await createInvite('https://chat.example.org', 'owner-jwt', 24, reply(200, { id: 'i1', token, expiresAt: 99, uses: 1 }));
		expect(created.token).toBe(token);
		expect(calls[0].url).toBe('https://chat.example.org/api/invites');
		expect(calls[0].init.method).toBe('POST');
		expect(calls[0].init.body).toBe(JSON.stringify({ expiresInHours: 24 }));
		expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer owner-jwt');

		expect(await listInvites('https://chat.example.org', 'owner-jwt', reply(200, { invites: [{ id: 'i1', expiresAt: 99, consumed: false, revoked: false }] }))).toHaveLength(1);
		await revokeInvite('https://chat.example.org', 'owner-jwt', 'a/b', reply(200, { revoked: 'a/b' }));
		expect(calls[2].url).toBe('https://chat.example.org/api/invites/a%2Fb');
		expect(calls[2].init.method).toBe('DELETE');

		await expect(createInvite('https://x.org', 'admin-jwt', 24, reply(403, { error: 'Owner access required to manage invitations' }))).rejects.toThrow('Only the server owner can manage invitations.');
		await expect(createInvite('https://x.org', 'owner-jwt', 24, reply(200, { id: 'i', token: 'short', expiresAt: 1 }))).rejects.toThrow();
	});
});
