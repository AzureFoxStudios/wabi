import { describe, expect, test } from 'bun:test';
import { badgeStatus } from './connectionBadgeStatus';

describe('the connection badge', () => {
	test('a connected socket reads Online even when the browser claims to be offline', () => {
		expect(badgeStatus('connected', false, false)).toBe('online');
	});

	test('"Work offline" stops applying once the socket connects', () => {
		expect(badgeStatus('disconnected', true, true)).toBe('offline');
		expect(badgeStatus('connected', true, true)).toBe('online');
	});

	test('without a connection, the browser being offline wins over the socket state', () => {
		for (const state of ['connecting', 'reconnecting', 'failed', 'disconnected'] as const) {
			expect(badgeStatus(state, false, false)).toBe('offline');
		}
	});

	test('with the browser online, the socket state is shown', () => {
		expect(badgeStatus('connecting', true, false)).toBe('connecting');
		expect(badgeStatus('reconnecting', true, false)).toBe('reconnecting');
		expect(badgeStatus('failed', true, false)).toBe('unreachable');
		expect(badgeStatus('disconnected', true, false)).toBe('idle');
	});
});
