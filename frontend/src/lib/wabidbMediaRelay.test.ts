import { describe, expect, test } from 'bun:test';
import { wabidbDmSessionKey, resolveWabidbSessionKey } from './wabidbMediaRelay';
describe('wabidbDmSessionKey', () => {
	test('is deterministic for the same two peers', () => {
		expect(wabidbDmSessionKey('user-5', 'user-7')).toBe(wabidbDmSessionKey('user-5', 'user-7'));
	});

	test('is symmetric regardless of caller/callee order', () => {
		expect(wabidbDmSessionKey('user-5', 'user-7')).toBe(wabidbDmSessionKey('user-7', 'user-5'));
	});

	test('normalizes bare numeric ids to the stable user-{id} form', () => {
		expect(wabidbDmSessionKey('5', '7')).toBe(wabidbDmSessionKey('user-7', 'user-5'));
		expect(wabidbDmSessionKey('5', 'user-7')).toBe(wabidbDmSessionKey('user-5', 'user-7'));
	});

	test('is distinct per peer pair', () => {
		expect(wabidbDmSessionKey('user-5', 'user-7')).not.toBe(wabidbDmSessionKey('user-5', 'user-8'));
		expect(wabidbDmSessionKey('user-5', 'user-7')).not.toBe(wabidbDmSessionKey('user-7', 'user-8'));
	});

	test('cannot collide with channel session ids (dm: prefix)', () => {
		expect(wabidbDmSessionKey('user-5', 'user-7').startsWith('dm:')).toBe(true);
		expect(wabidbDmSessionKey('user-5', 'user-7')).not.toBe('session-1720000000000-abc123');
	});
});

describe('resolveWabidbSessionKey', () => {
	test('channel kind keeps the caller-provided sessionId', () => {
		expect(resolveWabidbSessionKey('channel', 'session-abc', '5', 'user-7')).toBe('session-abc');
	});

	test('undefined kind keeps the caller-provided sessionId', () => {
		expect(resolveWabidbSessionKey(undefined, 'session-abc', '5')).toBe('session-abc');
	});

	test('dm kind derives a shared rendezvous key from both peers', () => {
		expect(resolveWabidbSessionKey('dm', 'session-ignored', 'user-5', 'user-7')).toBe(
			wabidbDmSessionKey('user-5', 'user-7')
		);
	});

	test('dm kind is symmetric across the two endpoints', () => {
		const callerKey = resolveWabidbSessionKey('dm', 'caller-session', 'user-5', 'user-7');
		const calleeKey = resolveWabidbSessionKey('dm', 'callee-session', 'user-7', 'user-5');
		expect(callerKey).toBe(calleeKey);
		expect(callerKey).not.toBe('caller-session');
		expect(calleeKey).not.toBe('callee-session');
	});

	test('dm kind without a peer falls back to sessionId', () => {
		expect(resolveWabidbSessionKey('dm', 'session-abc', 'user-5')).toBe('session-abc');
	});
});
