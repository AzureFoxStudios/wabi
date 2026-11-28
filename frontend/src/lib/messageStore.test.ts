import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { get } from 'svelte/store';

// messageStore pulls in the socket chain (which transitively needs the
// $app/environment virtual module); stub everything — markChannelAsRead
// only needs a socket with .emit and no local WabiDB.
mock.module('./socketConnection', () => ({
	getSocket: () => ({ emit: () => {} }),
	connected: { subscribe: (fn: (v: boolean) => void) => (fn(true), () => {}) }
}));
mock.module('$lib/wabidb', () => ({ getWabiDB: () => null }));
// This unit suite exercises ordinary-channel state, not browser auth storage.
mock.module('./groupAccess', () => ({ groupMembership: { acceptsContent: () => true } }));
// No DOM is installed in this store-only suite; auth/server imports must not
// initialize browser storage merely because a socket boundary is stubbed.
mock.module('$app/environment', () => ({ browser: false, dev: false, building: false }));

const { channelMessages, unreadCount, channelUnreadCounts, channelFirstUnread, forgetFirstUnread, markChannelAsRead, _incrementUnreadCount } = await import(
	'./messageStore'
);
const { currentUser } = await import('./presenceStore');

describe('markChannelAsRead unread ordering', () => {
	beforeEach(() => {
		channelUnreadCounts.set({ a: 3, b: 2 });
		unreadCount.set(5);
		currentUser.set({
			id: 'u1',
			username: 'tester',
			color: '#fff',
			status: 'offline'
		} as Parameters<typeof currentUser.set>[0]);
		channelMessages.set({});
	});

	test('decrements the global count by the channel prior count', () => {
		markChannelAsRead('a');
		expect(get(channelUnreadCounts)['a']).toBe(0);
		// 5 - 3; the old code read the count AFTER zeroing it and always
		// subtracted 0, letting the global badge drift upward forever.
		expect(get(unreadCount)).toBe(2);
	});

	test('clamps at zero instead of going negative', () => {
		markChannelAsRead('a');
		markChannelAsRead('a'); // prior is now 0
		expect(get(unreadCount)).toBe(2);

		channelUnreadCounts.set({ b: 99 });
		unreadCount.set(1);
		markChannelAsRead('b');
		expect(get(unreadCount)).toBe(0); // Math.max clamp
	});
});

describe('the "new" divider belongs to one channel and marks its first unread message', () => {
	beforeEach(() => {
		channelUnreadCounts.set({});
		unreadCount.set(0);
		channelFirstUnread.set({});
	});

	test('later arrivals, here or elsewhere, do not move it', () => {
		_incrementUnreadCount('a', 'a-1');
		_incrementUnreadCount('a', 'a-2');
		_incrementUnreadCount('b', 'b-1');
		expect(get(channelFirstUnread)).toEqual({ a: 'a-1', b: 'b-1' });
	});

	test('opening a channel clears its count for good but keeps the divider for the visit', () => {
		_incrementUnreadCount('a', 'a-1');
		_incrementUnreadCount('b', 'b-1');
		markChannelAsRead('a', { keepDivider: true });
		expect(get(channelUnreadCounts)).toEqual({ a: 0, b: 1 });
		expect(get(unreadCount)).toBe(1);
		expect(get(channelFirstUnread).a).toBe('a-1');
		// Moving on drops the divider; the next unread message starts a new one.
		forgetFirstUnread('a');
		expect(get(channelFirstUnread)).toEqual({ b: 'b-1' });
		_incrementUnreadCount('a', 'a-9');
		expect(get(channelFirstUnread).a).toBe('a-9');
	});

	test('an explicit mark as read clears the divider too', () => {
		_incrementUnreadCount('a', 'a-1');
		markChannelAsRead('a');
		expect(get(channelFirstUnread)).toEqual({});
		expect(get(channelUnreadCounts).a).toBe(0);
	});
});
