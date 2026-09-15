import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { writable } from 'svelte/store';

let encryptCalls = 0;
const emitted: Array<{ event: string; payload: any }> = [];
const socket = {
	id: 'socket-test',
	emit(event: string, payload: any) { emitted.push({ event, payload }); }
};

mock.module('$app/environment', () => ({ browser: false, dev: false, building: false }));
mock.module('./socketConnection', () => ({
	getSocket: () => socket,
	connected: writable(true)
}));
mock.module('$lib/wabidb', () => ({ getWabiDB: () => null }));
mock.module('./groupAccess', () => ({
	groupMembership: {
		acceptsContent: () => true,
		realm: () => 'test',
		tracks: () => false,
		capture: () => null,
		current: () => true
	}
}));
mock.module('./authSession', () => ({
	authSessionGeneration: () => 1,
	getGuestSessionId: () => null,
	onAuthSessionCleared: () => () => {}
}));
mock.module('./serverUrl', () => ({
	getServerUrl: () => 'http://example.invalid',
	normalizeServerUrl: (value: string) => value
}));
mock.module('./messageDelivery', () => ({
	UNCONFIRMED_MESSAGE: 'unconfirmed',
	messageDeliveries: {
		start: () => () => {},
		has: () => false,
		unconfirm: () => {}
	}
}));
mock.module('./e2ee', () => ({
	E2EE_MESSAGE_PREFIX: 'wabi-e2ee-v1:',
	encryptMessageForChannel: async () => {
		encryptCalls += 1;
		return null;
	},
	prepareIncomingE2eeMessage: async (_channelId: string, message: any) => message
}));
mock.module('./toast', () => ({ showToast: () => {} }));

const channels = writable<any[]>([]);
mock.module('./channelStore', () => ({ channels }));

const { sendMessage, channelMessages } = await import('./messageStore');
const { currentUser } = await import('./presenceStore');

describe('message E2EE boundary', () => {
	beforeEach(() => {
		encryptCalls = 0;
		emitted.length = 0;
		channelMessages.set({});
		currentUser.set({ id: 'u1', username: 'tester', color: '#fff', status: 'online' } as any);
	});

	test('known shared channels do not probe the private-room E2EE path', async () => {
		channels.set([{ id: 'public', type: 'text' }]);
		const result = await sendMessage('public', 'hello shared channel');
		expect(result.ok).toBe(true);
		expect(encryptCalls).toBe(0);
		expect(emitted.some((entry) => entry.event === 'message')).toBe(true);
	});

	test('DMs still attempt E2EE and remain fail-closed at that boundary', async () => {
		channels.set([{ id: 'private', type: 'dm' }]);
		const result = await sendMessage('private', 'hello dm');
		expect(result.ok).toBe(true);
		expect(encryptCalls).toBe(1);
	});

	test('unknown channels still attempt E2EE instead of assuming plaintext is safe', async () => {
		channels.set([]);
		const result = await sendMessage('unknown', 'hello');
		expect(result.ok).toBe(true);
		expect(encryptCalls).toBe(1);
	});
});
