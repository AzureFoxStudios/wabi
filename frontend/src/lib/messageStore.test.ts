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
mock.module('$app/environment', () => ({ browser: true, dev: false, building: false }));

const { channelMessages, unreadCount, channelUnreadCounts, markChannelAsRead } = await import(
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
