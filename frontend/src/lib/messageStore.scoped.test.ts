import { describe, test, expect, mock } from 'bun:test';
import { get } from 'svelte/store';

// messageStore pulls in the socket chain (which transitively needs the
// $app/environment virtual module); stub everything.
mock.module('./socketConnection', () => ({
	getSocket: () => ({ emit: () => {} }),
	connected: { subscribe: (fn: (v: boolean) => void) => (fn(true), () => {}) }
}));
mock.module('$lib/wabidb', () => ({ getWabiDB: () => null }));
mock.module('$app/environment', () => ({ browser: true, dev: false, building: false }));

const {
	channelMessages,
	channelMessagesStore,
	dropChannelMessagesStore,
	_appendOptimisticMessage
} = await import('./messageStore');

describe('channelMessagesStore scoped invalidation (god-store fix)', () => {
	test('emits only for the subscribed channel; other channels do not re-emit', () => {
		dropChannelMessagesStore('ch_a');
		dropChannelMessagesStore('ch_b');
		const storeA = channelMessagesStore('ch_a');

		let emissionsA = 0;
		const unsub = storeA.subscribe(() => emissionsA++);
		expect(emissionsA).toBe(1); // initial

		// Message lands in channel B — A's slice must NOT re-emit.
		_appendOptimisticMessage('ch_b', fakeMsg('b1'));
		expect(emissionsA).toBe(1);

		// Message lands in channel A — exactly one new emission.
		_appendOptimisticMessage('ch_a', fakeMsg('a1'));
		expect(emissionsA).toBe(2);
		expect(get(storeA).map((m) => m.id)).toEqual(['a1']);

		unsub();
	});

	test('dropChannelMessagesStore releases the cached slice', async () => {
		dropChannelMessagesStore('ch_tmp');
		channelMessagesStore('ch_tmp'); // create + cache
		dropChannelMessagesStore('ch_tmp');
		// Re-creating after drop must reflect the current map state.
		_appendOptimisticMessage('ch_tmp', fakeMsg('t1'));
		const fresh = channelMessagesStore('ch_tmp');
		expect(get(fresh).length).toBeGreaterThanOrEqual(1);
	});
});

function fakeMsg(id: string) {
	return {
		id,
		clientMessageId: `cm_${id}`,
		user: 't',
		userId: 'u1',
		color: '#fff',
		text: 'x',
		timestamp: Date.now(),
		type: 'text'
	} as Parameters<typeof _appendOptimisticMessage>[1];
}
