/**
 * Editing an older plaintext message in a room that now encrypts: the optimistic row carries the
 * encryption flags as soon as the edit is encrypted, so its new text is kept on the device
 * (privacy/contentEgress.ts) before the server's echo arrives.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { get, writable } from 'svelte/store';

const emitted: Array<{ event: string; payload: any }> = [];
const socket = { id: 's', connected: true, emit(event: string, payload: any) { emitted.push({ event, payload }); } };
let encryptResult: null | { wireText: string; epoch: number } = null;

mock.module('$app/environment', () => ({ browser: false, dev: false, building: false }));
mock.module('./socketConnection', () => ({ getSocket: () => socket, connected: writable(true) }));
mock.module('$lib/wabidb', () => ({ getWabiDB: () => null }));
mock.module('./toast', () => ({ showToast: () => {} }));
mock.module('./e2ee', () => ({
	E2EE_MESSAGE_PREFIX: 'wabi-e2ee-v1:',
	encryptMessageForChannel: async () => encryptResult,
	prepareIncomingE2eeMessage: async (_channelId: string, message: any) => message
}));
const channels = writable<any[]>([]);
mock.module('./channelStore', () => ({ channels }));

const { editMessage, channelMessages } = await import('./messageStore');
const { contentStaysOnDevice } = await import('./privacy/contentEgress');
const base = { user: 'me', userId: 'user-1', timestamp: 1, type: 'text' };

beforeEach(() => {
	emitted.length = 0;
	encryptResult = null;
});

describe('editMessage and kept content', () => {
	test('an encrypted edit of an older plaintext row flags the row', async () => {
		channels.set([{ id: 'dm-1', type: 'dm' }]);
		channelMessages.set({ 'dm-1': [{ ...base, id: 'm3', text: 'old plaintext' } as any] });
		encryptResult = { wireText: 'wabi-e2ee-v1:{"v":1}', epoch: 3 };
		await editMessage('dm-1', 'm3', 'new secret https://example.org/s');
		const row = get(channelMessages)['dm-1'][0] as any;
		expect(row.text).toBe('new secret https://example.org/s');
		expect(row.e2ee).toBe(true);
		expect(contentStaysOnDevice(row, false)).toBe(true);
		expect(emitted.at(-1)?.payload.newText.startsWith('wabi-e2ee-v1:')).toBe(true);
	});

	test('a plaintext edit (room not encrypting) leaves the row unflagged', async () => {
		channels.set([{ id: 'dm-2', type: 'dm' }]);
		channelMessages.set({ 'dm-2': [{ ...base, id: 'm4', text: 'old' } as any] });
		await editMessage('dm-2', 'm4', 'new');
		const row = get(channelMessages)['dm-2'][0] as any;
		expect(row.text).toBe('new');
		expect(row.e2ee).toBeUndefined();
	});

	test('a shared channel edit is unchanged', async () => {
		channels.set([{ id: 'general', type: 'text' }]);
		channelMessages.set({ general: [{ ...base, id: 'm5', text: 'old' } as any] });
		await editMessage('general', 'm5', 'new');
		expect((get(channelMessages).general[0] as any).text).toBe('new');
		expect(emitted.at(-1)?.payload.newText).toBe('new');
	});
});
