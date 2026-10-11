import { expect, mock, test } from 'bun:test';
import type { Message } from '$lib/socket-types';

mock.module('$app/environment', () => ({ browser: false }));

const { E2EE_MESSAGE_PREFIX, prepareIncomingE2eeMessage } = await import('./e2ee');

function message(text: string): Message {
	return { id: 'm1', text, userId: 2, user: 'wabi', timestamp: 0 } as unknown as Message;
}

test('a prefixed message with a malformed envelope never reaches the renderer as raw text', async () => {
	// Truncated JSON: the prefix says "ciphertext", so the failure marker is
	// the only thing allowed on screen — the raw envelope is a leak.
	const raw = `${E2EE_MESSAGE_PREFIX}{"v":1,"room":"dm-user-2-user-3936"`;
	const prepared = await prepareIncomingE2eeMessage('dm-user-2-user-3936', message(raw));
	expect(prepared.text).not.toContain(E2EE_MESSAGE_PREFIX);
	expect(prepared.text).not.toContain('dm-user-2-user-3936"');
	expect(prepared.text).toBe('[Unable to decrypt this end-to-end encrypted message on this device]');
	expect(prepared.e2eeVerified).toBe(false);
});

test('a prefixed message that is not even close to an envelope gets the marker', async () => {
	const prepared = await prepareIncomingE2eeMessage('dm-x', message(`${E2EE_MESSAGE_PREFIX}not-json-at-all`));
	expect(prepared.text).not.toContain(E2EE_MESSAGE_PREFIX);
	expect(prepared.e2eeError).toBe('envelope_did_not_parse');
});

test('a message without the envelope prefix is left untouched', async () => {
	const input = message('hello');
	expect(await prepareIncomingE2eeMessage('dm-x', input)).toBe(input);
});
