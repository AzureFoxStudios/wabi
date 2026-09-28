import { describe, test, expect, mock } from 'bun:test';
import { get } from 'svelte/store';

// messageStore pulls in the socket chain (which transitively needs the
// $app/environment virtual module); stub everything.
mock.module('./socketConnection', () => ({
	getSocket: () => ({ emit: () => {} }),
	connected: { subscribe: (fn: (v: boolean) => void) => (fn(true), () => {}) }
}));
mock.module('$lib/wabidb', () => ({ getWabiDB: () => null }));
mock.module('./groupAccess', () => ({ groupMembership: { acceptsContent: () => true } }));
// Store invalidation is DOM-independent. Keep transitive auth/server imports
// in their real non-browser mode; browser behavior has a separate harness.
mock.module('$app/environment', () => ({ browser: false, dev: false, building: false }));

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

	test('dropChannelMessagesStore remains compatible with fresh slices', async () => {
		dropChannelMessagesStore('ch_tmp');
		channelMessagesStore('ch_tmp');
		dropChannelMessagesStore('ch_tmp');
		// Re-creating after drop must reflect the current map state.
		_appendOptimisticMessage('ch_tmp', fakeMsg('t1'));
		const fresh = channelMessagesStore('ch_tmp');
		expect(get(fresh).length).toBeGreaterThanOrEqual(1);
	});

	test('switching channels releases each old global subscription', () => {
		const originalSubscribe = channelMessages.subscribe;
		let activeSlices = 0;
		channelMessages.subscribe = (run, invalidate) => {
			activeSlices++;
			const unsubscribe = originalSubscribe(run, invalidate);
			return () => { activeSlices--; unsubscribe(); };
		};
		try {
			for (let index = 0; index < 30; index++) {
				const unsubscribe = channelMessagesStore(`visited_${index}`).subscribe(() => {});
				expect(activeSlices).toBe(1);
				unsubscribe();
				expect(activeSlices).toBe(0);
			}
		} finally {
			channelMessages.subscribe = originalSubscribe;
		}
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
