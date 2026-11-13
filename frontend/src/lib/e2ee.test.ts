import { beforeEach, expect, mock, test } from 'bun:test';
import type { Message } from '$lib/socket-types';

const SERVER = 'https://wabi.test';
const ME = 3;
const SENDER_USER = 2;
const SENDER_DEVICE = 'd_sender';
const REALM = `${SERVER}|${ME}`;

function b64(bytes: Uint8Array): string { return Buffer.from(bytes).toString('base64'); }
function jwt(sub: number): string {
	const enc = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
	return `${enc({ alg: 'none' })}.${enc({ sub })}.sig`;
}

// A plain Map-backed localStorage and a switchable fetch: the code under test
// reads both through globals, so no module-internal state is poked.
let store = new Map<string, string>();
(globalThis as any).localStorage = {
	getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
	setItem: (key: string, value: string) => { store.set(key, value); },
	removeItem: (key: string) => { store.delete(key); },
};
let token: string | null = jwt(ME);
let roomStatus: () => Response = () => new Response('{}', { status: 500 });
let registeredDeviceId = '';
(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
	if (String(url).includes('/api/e2ee/devices')) {
		registeredDeviceId = JSON.parse(String(init?.body)).deviceId;
		return new Response('{}', { status: 200 });
	}
	return roomStatus();
};

mock.module('$app/environment', () => ({ browser: true }));
mock.module('$lib/authSession', () => ({ getAuthToken: () => token }));
mock.module('$lib/api/authRefresh', () => ({ tryRefresh: async () => false }));
mock.module('$lib/serverUrl', () => ({ getServerUrl: () => SERVER }));

const { E2EE_MESSAGE_PREFIX, prepareIncomingE2eeMessage } = await import('./e2ee');
const { isE2eeObserved } = await import('./e2eeEnvelope');

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const signingPair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const otherPair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const senderSigningPublic = b64(new Uint8Array(await subtle.exportKey('raw', signingPair.publicKey)));
const senderEncryptionPublic = b64(new Uint8Array(await subtle.exportKey('raw',
	(await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])).publicKey)));

const senderBundle = {
	userId: SENDER_USER, deviceId: SENDER_DEVICE, label: 'x',
	encryptionPublicKey: senderEncryptionPublic, signingPublicKey: senderSigningPublic,
	createdAt: '', lastSeenAt: '', revokedAt: null,
};

let channel = '';
let counter = 0;
beforeEach(() => {
	store = new Map();
	token = jwt(ME);
	channel = `dm-user-2-user-3-${counter += 1}`;
	setStatus({});
});

// The client registers this device once and caches the identity in memory, so register it up
// front and keep its id for the tests that address a room-key envelope to this device.
setStatus({});
await prepareIncomingE2eeMessage('warmup', message(await envelopeText({ room: 'warmup' })));

function setStatus(over: Record<string, unknown>) {
	const status = {
		enabled: true, epoch: 1, membershipRevision: 'r1', currentMembershipRevision: 'r1', needsRekey: false,
		devices: [senderBundle], missingUserIds: [], keyEnvelopes: [], downgradeAllowed: false, ...over,
	};
	roomStatus = () => new Response(JSON.stringify(status), { status: 200 });
}

function message(text: string, userId: unknown = `user-${SENDER_USER}`): Message {
	return { id: 'm1', text, userId, user: 'wabi', timestamp: 0 } as unknown as Message;
}

/** Signed with the same canonical string the client verifies. */
async function envelopeText(over: Record<string, unknown> = {}, signWith: CryptoKey = signingPair.privateKey, ciphertext?: string) {
	const body = {
		v: 1, room: channel, epoch: 1, membershipRevision: 'r1', senderDeviceId: SENDER_DEVICE,
		iv: b64(crypto.getRandomValues(new Uint8Array(12))),
		ciphertext: ciphertext ?? b64(crypto.getRandomValues(new Uint8Array(32))),
		...over,
	} as any;
	const canonical = ['wabi-e2ee-v1', body.room, String(body.epoch), body.membershipRevision, body.senderDeviceId, body.iv, body.ciphertext].join('|');
	const signature = b64(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signWith, enc.encode(canonical))));
	return `${E2EE_MESSAGE_PREFIX}${JSON.stringify({ ...body, signature })}`;
}

/** Put a room key where this device would have cached it. */
async function seedRoomKey(epoch: number, key: Uint8Array) {
	const secret = crypto.getRandomValues(new Uint8Array(32));
	store.set(`wabi:e2ee-wrap-secret:v1:${REALM}`, b64(secret));
	const wrap = await subtle.importKey('raw', secret, { name: 'AES-GCM' }, false, ['encrypt']);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, wrap, key as BufferSource));
	store.set(`wabi:e2ee-room-key:v1:${REALM}:${channel}:${epoch}`, JSON.stringify({ iv: b64(iv), ciphertext: b64(ciphertext) }));
}

const NO_KEY_TEXT = '[This message uses experimental encryption. This device does not have its key, so it cannot be shown]';
const FAILED_TEXT = '[This message uses experimental encryption. It failed a check on this device and is not shown]';

function expectNoKey(prepared: any) {
	expect(prepared.e2eeUnreadable).toBe('no-key');
	expect(prepared.text).toBe(NO_KEY_TEXT);
	expectSafe(prepared);
}
function expectFailedCheck(prepared: any) {
	expect(prepared.e2eeUnreadable).toBe('failed-check');
	expect(prepared.text).toBe(FAILED_TEXT);
	expectSafe(prepared);
}
function expectSafe(prepared: any) {
	expect(prepared.e2eeVerified).toBe(false);
	expect(prepared.text).not.toContain(E2EE_MESSAGE_PREFIX);
	expect(prepared.text.toLowerCase()).not.toContain('end-to-end');
	expect(prepared.id).toBe('m1');
	expect(prepared.e2eeError).toBeTruthy();
	// This client saw an envelope it could not open: its content stays on the device.
	expect(isE2eeObserved(prepared)).toBe(true);
}

// ---- class "failed-check": the message failed a check -------------------------------------

test('a prefixed message with a malformed envelope never reaches the renderer as raw text', async () => {
	const raw = `${E2EE_MESSAGE_PREFIX}{"v":1,"room":"dm-user-2-user-3936"`;
	const prepared = await prepareIncomingE2eeMessage('dm-user-2-user-3936', message(raw));
	expect(prepared.text).not.toContain('dm-user-2-user-3936"');
	expectFailedCheck(prepared);
	expect(prepared.e2eeError).toBe('envelope_did_not_parse');
});

test('a prefixed message that is not even close to an envelope is a failed check', async () => {
	const prepared = await prepareIncomingE2eeMessage('dm-x', message(`${E2EE_MESSAGE_PREFIX}not-json-at-all`));
	expectFailedCheck(prepared);
});

test('room mismatch is a failed check', async () => {
	expectFailedCheck(await prepareIncomingE2eeMessage(channel, message(await envelopeText({ room: 'dm-other' }))));
});

test('a missing sender identity is a failed check', async () => {
	expectFailedCheck(await prepareIncomingE2eeMessage(channel, message(await envelopeText(), '')));
});

test('a room status that cannot be fetched is a failed check (cause not distinguishable)', async () => {
	roomStatus = () => new Response('{}', { status: 500 });
	expectFailedCheck(await prepareIncomingE2eeMessage(channel, message(await envelopeText())));
});

test('being signed out is a failed check (cause not distinguishable)', async () => {
	token = null;
	expectFailedCheck(await prepareIncomingE2eeMessage(channel, message(await envelopeText())));
});

test('an unknown sender device is a failed check', async () => {
	setStatus({ devices: [] });
	expectFailedCheck(await prepareIncomingE2eeMessage(channel, message(await envelopeText())));
});

test('a sender device whose pinned keys changed is a failed check', async () => {
	store.set(`wabi:e2ee-pin:v1:${REALM}:${SENDER_USER}:${SENDER_DEVICE}`, JSON.stringify({ encryptionPublicKey: 'old', signingPublicKey: 'old' }));
	expectFailedCheck(await prepareIncomingE2eeMessage(channel, message(await envelopeText())));
});

test('a bad message signature is a failed check', async () => {
	expectFailedCheck(await prepareIncomingE2eeMessage(channel, message(await envelopeText({}, otherPair.privateKey))));
});

test('a room-key envelope for this device whose sender device is gone is a failed check', async () => {
	const deviceId = registeredDeviceId;
	setStatus({ keyEnvelopes: [{ recipientUserId: ME, recipientDeviceId: deviceId, senderDeviceId: 'd_gone', ephemeralPublicKey: '', salt: '', iv: '', ciphertext: '', signature: '' }] });
	expectFailedCheck(await prepareIncomingE2eeMessage(channel, message(await envelopeText())));
});

test('a room-key envelope with a bad signature is a failed check', async () => {
	const deviceId = registeredDeviceId;
	setStatus({ keyEnvelopes: [{ recipientUserId: ME, recipientDeviceId: deviceId, senderDeviceId: SENDER_DEVICE, ephemeralPublicKey: senderEncryptionPublic, salt: '', iv: '', ciphertext: '', signature: b64(new Uint8Array(64)) }] });
	expectFailedCheck(await prepareIncomingE2eeMessage(channel, message(await envelopeText())));
});

test('a cached key that cannot open the message is a failed check', async () => {
	await seedRoomKey(1, crypto.getRandomValues(new Uint8Array(32)));
	expectFailedCheck(await prepareIncomingE2eeMessage(channel, message(await envelopeText())));
});

test('a decrypted payload with the wrong shape is a failed check', async () => {
	const roomKey = crypto.getRandomValues(new Uint8Array(32));
	await seedRoomKey(1, roomKey);
	const key = await subtle.importKey('raw', roomKey, { name: 'AES-GCM' }, false, ['encrypt']);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const aad = enc.encode(['wabi-e2ee-payload-v1', channel, '1', 'r1', SENDER_DEVICE].join('|'));
	const ciphertext = b64(new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, enc.encode('{"v":2}'))));
	expectFailedCheck(await prepareIncomingE2eeMessage(channel, message(await envelopeText({ iv: b64(iv) }, signingPair.privateKey, ciphertext))));
});

test('a message this device decrypts carries the local "observed" marker (wire JSON cannot)', async () => {
	const roomKey = crypto.getRandomValues(new Uint8Array(32));
	await seedRoomKey(1, roomKey);
	const key = await subtle.importKey('raw', roomKey, { name: 'AES-GCM' }, false, ['encrypt']);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const aad = enc.encode(['wabi-e2ee-payload-v1', channel, '1', 'r1', SENDER_DEVICE].join('|'));
	const payload = JSON.stringify({ v: 1, text: 'meet at https://example.org/plan', type: 'text', options: {} });
	const ciphertext = b64(new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, enc.encode(payload))));
	const prepared: any = await prepareIncomingE2eeMessage(channel, message(await envelopeText({ iv: b64(iv) }, signingPair.privateKey, ciphertext)));
	expect(prepared.text).toBe('meet at https://example.org/plan');
	expect(prepared.e2eeVerified).toBe(true);
	expect(isE2eeObserved(prepared)).toBe(true);
	expect(isE2eeObserved(JSON.parse(JSON.stringify(prepared)))).toBe(false);
});

// ---- class "no-key": this device has no key for this message ------------------------------

test('no cached key and the room is now on a later epoch is "no key"', async () => {
	setStatus({ epoch: 2 });
	expectNoKey(await prepareIncomingE2eeMessage(channel, message(await envelopeText({ epoch: 1 }))));
});

test('no cached key and no room-key envelope addressed to this device is "no key"', async () => {
	setStatus({ keyEnvelopes: [] });
	expectNoKey(await prepareIncomingE2eeMessage(channel, message(await envelopeText())));
});

test('local keys cleared after a key was cached: the message is "no key", not a failed check', async () => {
	await seedRoomKey(1, crypto.getRandomValues(new Uint8Array(32)));
	store.set(`wabi:e2ee-wrap-secret:v1:${REALM}`, b64(crypto.getRandomValues(new Uint8Array(32))));
	expectNoKey(await prepareIncomingE2eeMessage(channel, message(await envelopeText())));
});

// ---- unchanged behaviour -------------------------------------------------------------------

test('a message without the envelope prefix is left untouched', async () => {
	const input = { ...message('hello'), encrypted: true, e2ee: true } as Message;
	expect(await prepareIncomingE2eeMessage('dm-x', input)).toBe(input);
	expect(isE2eeObserved(input)).toBe(false);
});

test('the prepared message keeps the id and clientMessageId it came in with', async () => {
	const input = { ...message(await envelopeText({ room: 'dm-other' })), clientMessageId: 'c-1' } as Message;
	const prepared = await prepareIncomingE2eeMessage(channel, input);
	expect(prepared.id).toBe('m1');
	expect(prepared.clientMessageId).toBe('c-1');
});
