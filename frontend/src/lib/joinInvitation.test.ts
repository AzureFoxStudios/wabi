import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { SERVER_CLOSED, USED_OR_EXPIRED, explainJoinRefusal, explainLinkProblem } from './joinInvitation';

const token = 'cd'.repeat(32);

describe('the friend sees what happened in plain words', () => {
	test('used, expired and cancelled links get one honest answer', () => {
		expect(explainJoinRefusal(403, 'Invitation is invalid, expired, revoked or already used')).toBe(USED_OR_EXPIRED);
		expect(USED_OR_EXPIRED).toMatch(/expired, been cancelled, or someone has already used it/);
	});

	test('a closed server is named as closed, not as a bad link', () => {
		expect(explainJoinRefusal(403, 'Registration is closed on this server')).toBe(SERVER_CLOSED);
		// Invite-only refusal (also the default once an owner exists and nothing is saved).
		expect(explainJoinRefusal(403, 'This server is invite only. Ask the server owner for an invitation link')).toMatch(/Ask the server owner for a new invitation link/);
	});

	test('a taken username says the invitation was not used (the server checks names first)', () => {
		expect(explainJoinRefusal(400, 'Username already taken')).toMatch(/has not been used/);
		const server = readFileSync(new URL('../../../core/crates/wabi-server/src/api/auth.rs', import.meta.url), 'utf8');
		expect(server.indexOf('Username already taken')).toBeLessThan(server.indexOf('super::invites::consume('));
	});

	test('server faults are not blamed on the link', () => {
		expect(explainJoinRefusal(500, 'Cannot commit invitation state: disk full')).toMatch(/couldn't create your account/);
	});

	test('a link that cannot be read says why', () => {
		expect(explainLinkProblem('https://chat.example.org/join')).toMatch(/incomplete/);
		expect(explainLinkProblem(`https://chat.example.org/join#invite=${token.slice(4)}`)).toMatch(/incomplete/);
		expect(explainLinkProblem(`http://localhost:3000/join#invite=${token}`)).toMatch(/always means the device you are using/);
		expect(explainLinkProblem(`http://chat.example.org/join#invite=${token}`)).toMatch(/plain HTTP/);
	});
});
