import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { get, writable } from 'svelte/store';

let encryptCalls = 0;
let prepareCalls = 0;
const emitted: Array<{ event: string; payload: any }> = [];
const socket = {
	id: 'socket-test',
	connected: true,
	emit(event: string, payload: any) { emitted.push({ event, payload }); }
};
const connection = writable(true);
let localQueue: { enqueue: (action: any) => Promise<void> } | null = null;
let releaseEncryption: (() => void) | null = null;

mock.module('$app/environment', () => ({ browser: false, dev: false, building: false }));
mock.module('../src/lib/socketConnection', () => ({
	getSocket: () => socket,
	connected: connection
}));
mock.module('$lib/wabidb', () => ({ getWabiDB: () => localQueue }));
mock.module('../src/lib/groupAccess', () => ({
	groupMembership: {
		acceptsContent: () => true,
		realm: () => 'test',
		tracks: () => false,
		capture: () => null,
		current: () => true
	}
}));
mock.module('../src/lib/authSession', () => ({
	authSessionGeneration: () => 1,
	getGuestSessionId: () => null,
	onAuthSessionCleared: () => () => {}
}));
mock.module('../src/lib/serverUrl', () => ({
	getServerUrl: () => 'http://example.invalid',
	normalizeServerUrl: (value: string) => value
}));
mock.module('../src/lib/messageDelivery', () => ({
	UNCONFIRMED_MESSAGE: 'unconfirmed',
	messageDeliveries: {
		start: () => () => {},
		has: () => false,
		unconfirm: () => {}
	}
}));
mock.module('../src/lib/e2ee', () => ({
	E2EE_MESSAGE_PREFIX: 'wabi-e2ee-v1:',
	encryptMessageForChannel: async () => {
		encryptCalls += 1;
		if (releaseEncryption) await new Promise<void>((resolve) => { releaseEncryption = resolve; });
		return null;
	},
	prepareIncomingE2eeMessage: async (_channelId: string, message: any) => {
		prepareCalls += 1;
		return message;
	}
}));
mock.module('../src/lib/toast', () => ({ showToast: () => {} }));

const channels = writable<any[]>([]);
mock.module('../src/lib/channelStore', () => ({ channels }));

const { sendMessage, channelMessages } = await import('../src/lib/messageStore');
const { currentUser } = await import('../src/lib/presenceStore');

describe('message E2EE boundary', () => {
	beforeEach(() => {
		encryptCalls = 0;
		prepareCalls = 0;
		emitted.length = 0;
		socket.connected = true;
		connection.set(true);
		localQueue = null;
		releaseEncryption = null;
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

	test('a DM send stays in the draft when the socket drops during encryption', async () => {
		channels.set([{ id: 'private', type: 'dm' }]);
		releaseEncryption = () => {};
		const sending = sendMessage('private', 'phone message');
		while (encryptCalls === 0 || !releaseEncryption) await Bun.sleep(0);
		socket.connected = false;
		connection.set(false);
		releaseEncryption?.();
		const result = await sending;
		expect(result).toEqual({ ok: false, reason: 'no_socket' });
		expect(emitted).toEqual([]);
		expect(get(channelMessages).private).toBeUndefined();
	});

	test('a DM send queues under its account when connection drops during encryption', async () => {
		channels.set([{ id: 'private', type: 'dm' }]);
		const queued: any[] = [];
		localQueue = { enqueue: async (action) => { queued.push(action); } };
		releaseEncryption = () => {};
		const sending = sendMessage('private', 'phone message');
		while (encryptCalls === 0 || !releaseEncryption) await Bun.sleep(0);
		socket.connected = false;
		connection.set(false);
		releaseEncryption?.();
		const result = await sending;
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.queuedOffline).toBe(true);
		expect(emitted).toEqual([]);
		expect(queued).toHaveLength(1);
		expect(queued[0].payload.text).toBe('phone message');
	});

});
