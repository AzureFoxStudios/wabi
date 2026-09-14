// @ts-nocheck — TS 6.0 typed-array generics vs Web Crypto BufferSource types; verified runtime-safe.
import { browser } from '$app/environment';
import { getAuthToken } from '$lib/authSession';
import { tryRefresh } from '$lib/api/authRefresh';
import { getServerUrl } from '$lib/serverUrl';
import type { Message } from '$lib/socket-types';
import type { AttachmentEncryptionMeta } from '../../../packages/wabi-protocol/src';

export const E2EE_MESSAGE_PREFIX = 'wabi-e2ee-v1:';
const DEVICE_VERSION = 1;
const FILE_CHUNK_SIZE = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type WrappedLocalBytes = { iv: string; ciphertext: string };

type StoredDeviceIdentity = {
	v: 1;
	deviceId: string;
	label: string;
	encryptionPublicKey: string;
	signingPublicKey: string;
	encryptionPrivateKey: WrappedLocalBytes;
	signingPrivateKey: WrappedLocalBytes;
	createdAt: string;
};

export type E2eeDeviceBundle = {
	userId: number;
	deviceId: string;
	label?: string | null;
	encryptionPublicKey: string;
	signingPublicKey: string;
	createdAt: string;
	lastSeenAt: string;
	revokedAt?: string | null;
};

export type WrappedRoomKey = {
	recipientUserId: number;
	recipientDeviceId: string;
	ephemeralPublicKey: string;
	salt: string;
	iv: string;
	ciphertext: string;
	senderDeviceId: string;
	signature: string;
};

export type E2eeRoomStatus = {
	enabled: boolean;
	epoch: number;
	membershipRevision: string;
	currentMembershipRevision: string;
	needsRekey: boolean;
	devices: E2eeDeviceBundle[];
	missingUserIds: number[];
	keyEnvelopes: WrappedRoomKey[];
	downgradeAllowed: false;
};

export type E2eeAttachmentMeta = AttachmentEncryptionMeta & {
	epoch: number;
	chunkSize: number;
	noncePrefix: string;
	fileId: string;
};

type LocalIdentity = {
	deviceId: string;
	label: string;
	encryptionPublicKey: string;
	signingPublicKey: string;
	encryptionPrivateKey: CryptoKey;
	signingPrivateKey: CryptoKey;
};

type E2eeMessageEnvelope = {
	v: 1;
	room: string;
	epoch: number;
	membershipRevision: string;
	senderDeviceId: string;
	iv: string;
	ciphertext: string;
	signature: string;
};

type E2eePayload = {
	v: 1;
	text: string;
	type: string;
	options: Record<string, unknown>;
};

export type E2eePreparedMessage = Message & {
	e2ee?: boolean;
	e2eeVerified?: boolean;
	e2eeEpoch?: number;
	e2eeSenderDeviceId?: string;
	e2eeError?: string;
};

export class E2eeTrustError extends Error {
	devices: Array<{ userId: number; deviceId: string; fingerprint: string; label?: string | null }>;
	constructor(message: string, devices: E2eeTrustError['devices']) {
		super(message);
		this.name = 'E2eeTrustError';
		this.devices = devices;
	}
}

function requireCrypto(): SubtleCrypto {
	if (!browser || !globalThis.crypto?.subtle) throw new Error('This client does not provide WebCrypto required for E2EE.');
	return globalThis.crypto.subtle;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
	}
	return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
	return out;
}

function decodeJwtUserId(token: string): number {
	try {
		const raw = token.split('.')[1];
		if (!raw) return 0;
		const normalized = raw.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(raw.length / 4) * 4, '=');
		const payload = JSON.parse(atob(normalized));
		const value = Number(payload?.sub);
		return Number.isInteger(value) && value > 0 ? value : 0;
	} catch {
		return 0;
	}
}

function realm(): { server: string; token: string; userId: number; key: string } {
	const server = getServerUrl().replace(/\/+$/, '');
	const token = getAuthToken(server) || getAuthToken();
	if (!token) throw new Error('Sign in with a registered account to use E2EE.');
	const userId = decodeJwtUserId(token);
	if (!userId) throw new Error('E2EE requires a registered account.');
	return { server, token, userId, key: `${server}|${userId}` };
}

function safeLocalGet(key: string): string | null {
	try { return localStorage.getItem(key); } catch { return null; }
}
function safeLocalSet(key: string, value: string): void {
	try { localStorage.setItem(key, value); } catch { throw new Error('This client cannot persist E2EE key material locally.'); }
}

async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
	const r = realm();
	const request = async (): Promise<Response> => {
		const token = getAuthToken(r.server) || getAuthToken();
		if (!token) throw new Error('Your session expired. Sign in again before using E2EE.');
		return fetch(`${r.server}${path}`, {
			...init,
			credentials: 'include',
			headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) }
		});
	};
	let response = await request();
	if (response.status === 401 && await tryRefresh(r.server)) response = await request();
	return response;
}

async function responseJson(response: Response): Promise<any> {
	const value = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(value?.error || `E2EE request failed (${response.status}).`);
	return value;
}

function deviceStorageKey(): string { return `wabi:e2ee-device:v${DEVICE_VERSION}:${realm().key}`; }
function wrapSecretKey(): string { return `wabi:e2ee-wrap-secret:v1:${realm().key}`; }
function roomKeyStorageKey(channelId: string, epoch: number): string { return `wabi:e2ee-room-key:v1:${realm().key}:${channelId}:${epoch}`; }
function roomStatusStorageKey(channelId: string): string { return `wabi:e2ee-room-status:v1:${realm().key}:${channelId}`; }
function pinStorageKey(userId: number, deviceId: string): string { return `wabi:e2ee-pin:v1:${realm().key}:${userId}:${deviceId}`; }

function getOrCreateWrapSecret(): Uint8Array {
	const key = wrapSecretKey();
	const existing = safeLocalGet(key);
	if (existing) return base64ToBytes(existing);
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	safeLocalSet(key, bytesToBase64(bytes));
	return bytes;
}

async function localWrapKey(): Promise<CryptoKey> {
	return requireCrypto().importKey('raw', getOrCreateWrapSecret(), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function wrapLocalBytes(bytes: Uint8Array): Promise<WrappedLocalBytes> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await requireCrypto().encrypt({ name: 'AES-GCM', iv }, await localWrapKey(), bytes);
	return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

async function unwrapLocalBytes(value: WrappedLocalBytes): Promise<Uint8Array> {
	const clear = await requireCrypto().decrypt(
		{ name: 'AES-GCM', iv: base64ToBytes(value.iv) }, await localWrapKey(), base64ToBytes(value.ciphertext)
	);
	return new Uint8Array(clear);
}

function defaultDeviceLabel(): string {
	if (!browser) return 'Wabi device';
	const platform = navigator.platform?.trim();
	return platform ? `Wabi · ${platform}` : 'Wabi device';
}

async function createIdentity(): Promise<StoredDeviceIdentity> {
	const subtle = requireCrypto();
	const encryption = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
	const signing = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
	const encryptionPublic = new Uint8Array(await subtle.exportKey('raw', encryption.publicKey));
	const signingPublic = new Uint8Array(await subtle.exportKey('raw', signing.publicKey));
	const encryptionPrivate = new Uint8Array(await subtle.exportKey('pkcs8', encryption.privateKey));
	const signingPrivate = new Uint8Array(await subtle.exportKey('pkcs8', signing.privateKey));
	return {
		v: 1,
		deviceId: `d_${crypto.randomUUID().replace(/-/g, '')}`,
		label: defaultDeviceLabel(),
		encryptionPublicKey: bytesToBase64(encryptionPublic),
		signingPublicKey: bytesToBase64(signingPublic),
		encryptionPrivateKey: await wrapLocalBytes(encryptionPrivate),
		signingPrivateKey: await wrapLocalBytes(signingPrivate),
		createdAt: new Date().toISOString(),
	};
}

async function loadLocalIdentity(): Promise<LocalIdentity> {
	const key = deviceStorageKey();
	let stored: StoredDeviceIdentity | null = null;
	const raw = safeLocalGet(key);
	if (raw) {
		try { stored = JSON.parse(raw); } catch { stored = null; }
	}
	if (!stored || stored.v !== 1 || !stored.deviceId) {
		stored = await createIdentity();
		safeLocalSet(key, JSON.stringify(stored));
	}
	const subtle = requireCrypto();
	const encryptionPrivateKey = await subtle.importKey(
		'pkcs8', await unwrapLocalBytes(stored.encryptionPrivateKey), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']
	);
	const signingPrivateKey = await subtle.importKey(
		'pkcs8', await unwrapLocalBytes(stored.signingPrivateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
	);
	return {
		deviceId: stored.deviceId,
		label: stored.label,
		encryptionPublicKey: stored.encryptionPublicKey,
		signingPublicKey: stored.signingPublicKey,
		encryptionPrivateKey,
		signingPrivateKey,
	};
}

export async function ensureE2eeDeviceRegistered(): Promise<LocalIdentity> {
	const identity = await loadLocalIdentity();
	const response = await authorizedFetch('/api/e2ee/devices', {
		method: 'POST',
		body: JSON.stringify({
			deviceId: identity.deviceId,
			label: identity.label,
			encryptionPublicKey: identity.encryptionPublicKey,
			signingPublicKey: identity.signingPublicKey,
		})
	});
	await responseJson(response);
	return identity;
}

export async function revokeCurrentE2eeDevice(): Promise<void> {
	const identity = await loadLocalIdentity();
	await responseJson(await authorizedFetch(`/api/e2ee/devices/${encodeURIComponent(identity.deviceId)}`, { method: 'DELETE' }));
}

export async function fingerprintDevice(device: Pick<E2eeDeviceBundle, 'encryptionPublicKey' | 'signingPublicKey'>): Promise<string> {
	const digest = new Uint8Array(await requireCrypto().digest('SHA-256', encoder.encode(`${device.encryptionPublicKey}|${device.signingPublicKey}`)));
	return [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('').match(/.{1,4}/g)?.join(' ') || '';
}

async function pinDevice(device: E2eeDeviceBundle, allowNew: boolean): Promise<void> {
	const key = pinStorageKey(device.userId, device.deviceId);
	const raw = safeLocalGet(key);
	if (raw) {
		const stored = JSON.parse(raw) as { encryptionPublicKey: string; signingPublicKey: string };
		if (stored.encryptionPublicKey !== device.encryptionPublicKey || stored.signingPublicKey !== device.signingPublicKey) {
			throw new E2eeTrustError('A previously known E2EE device changed identity keys. Wabi refused the change.', [{
				userId: device.userId, deviceId: device.deviceId, label: device.label, fingerprint: await fingerprintDevice(device),
			}]);
		}
		return;
	}
	if (!allowNew) {
		throw new E2eeTrustError('A new participant device needs verification before Wabi can rotate this room key.', [{
			userId: device.userId, deviceId: device.deviceId, label: device.label, fingerprint: await fingerprintDevice(device),
		}]);
	}
	safeLocalSet(key, JSON.stringify({ encryptionPublicKey: device.encryptionPublicKey, signingPublicKey: device.signingPublicKey }));
}

async function pinDevices(devices: E2eeDeviceBundle[], allowNew: boolean): Promise<void> {
	const unknown: E2eeTrustError['devices'] = [];
	for (const device of devices) {
		try { await pinDevice(device, allowNew); }
		catch (error) {
			if (error instanceof E2eeTrustError) unknown.push(...error.devices);
			else throw error;
		}
	}
	if (unknown.length) throw new E2eeTrustError('New or changed E2EE devices require verification before rekeying.', unknown);
}

function cacheRoomStatus(channelId: string, status: E2eeRoomStatus): void {
	const existing = safeLocalGet(roomStatusStorageKey(channelId));
	if (existing) {
		try {
			const prior = JSON.parse(existing) as E2eeRoomStatus;
			// E2EE has no downgrade endpoint. Never let a stale/lying disabled
			// response erase a locally observed encrypted-room boundary.
			if (prior.enabled && !status.enabled) return;
		} catch {}
	}
	safeLocalSet(roomStatusStorageKey(channelId), JSON.stringify(status));
}

function cachedRoomStatus(channelId: string): E2eeRoomStatus | null {
	const raw = safeLocalGet(roomStatusStorageKey(channelId));
	if (!raw) return null;
	try { return JSON.parse(raw) as E2eeRoomStatus; } catch { return null; }
}

export async function getE2eeRoomStatus(channelId: string, allowCached = true): Promise<E2eeRoomStatus> {
	try {
		const response = await authorizedFetch(`/api/e2ee/channels/${encodeURIComponent(channelId)}`);
		const status = await responseJson(response) as E2eeRoomStatus;
		cacheRoomStatus(channelId, status);
		return status;
	} catch (error) {
		if (allowCached) {
			const cached = cachedRoomStatus(channelId);
			if (cached) return cached;
		}
		throw error;
	}
}

function roomKeyCanonical(channelId: string, epoch: number, revision: string, envelope: Omit<WrappedRoomKey, 'signature'>): string {
	return [
		'wabi-room-key-v1', channelId, String(epoch), revision,
		String(envelope.recipientUserId), envelope.recipientDeviceId, envelope.ephemeralPublicKey,
		envelope.salt, envelope.iv, envelope.ciphertext, envelope.senderDeviceId,
	].join('|');
}

function messageAad(channelId: string, epoch: number, revision: string, senderDeviceId: string): Uint8Array {
	return encoder.encode(['wabi-e2ee-payload-v1', channelId, String(epoch), revision, senderDeviceId].join('|'));
}

function messageCanonical(envelope: Omit<E2eeMessageEnvelope, 'signature'>): string {
	return [
		'wabi-e2ee-v1', envelope.room, String(envelope.epoch), envelope.membershipRevision,
		envelope.senderDeviceId, envelope.iv, envelope.ciphertext,
	].join('|');
}

async function sign(privateKey: CryptoKey, value: string): Promise<string> {
	const signature = await requireCrypto().sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, encoder.encode(value));
	return bytesToBase64(new Uint8Array(signature));
}

async function verify(publicKeyBase64: string, value: string, signature: string): Promise<boolean> {
	const key = await requireCrypto().importKey(
		'raw', base64ToBytes(publicKeyBase64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
	);
	return requireCrypto().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, base64ToBytes(signature), encoder.encode(value));
}

async function deriveWrappingKey(privateKey: CryptoKey, publicKeyBase64: string, salt: Uint8Array, info: string): Promise<CryptoKey> {
	const subtle = requireCrypto();
	const publicKey = await subtle.importKey('raw', base64ToBytes(publicKeyBase64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
	const bits = await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
	const hkdf = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
	return subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) },
		hkdf,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

async function wrapRoomKey(
	channelId: string, epoch: number, revision: string, roomKey: Uint8Array,
	recipient: E2eeDeviceBundle, identity: LocalIdentity,
): Promise<WrappedRoomKey> {
	const ephemeral = await requireCrypto().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
	const ephemeralPublicKey = bytesToBase64(new Uint8Array(await requireCrypto().exportKey('raw', ephemeral.publicKey)));
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const wrappingKey = await deriveWrappingKey(
		ephemeral.privateKey, recipient.encryptionPublicKey, salt,
		`wabi-room-key-v1|${channelId}|${epoch}|${revision}|${recipient.deviceId}`
	);
	const ciphertext = await requireCrypto().encrypt({ name: 'AES-GCM', iv }, wrappingKey, roomKey);
	const unsigned = {
		recipientUserId: recipient.userId,
		recipientDeviceId: recipient.deviceId,
		ephemeralPublicKey,
		salt: bytesToBase64(salt),
		iv: bytesToBase64(iv),
		ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
		senderDeviceId: identity.deviceId,
	};
	return { ...unsigned, signature: await sign(identity.signingPrivateKey, roomKeyCanonical(channelId, epoch, revision, unsigned)) };
}

async function cacheRoomKey(channelId: string, epoch: number, roomKey: Uint8Array): Promise<void> {
	safeLocalSet(roomKeyStorageKey(channelId, epoch), JSON.stringify(await wrapLocalBytes(roomKey)));
}

async function cachedRoomKey(channelId: string, epoch: number): Promise<Uint8Array | null> {
	const raw = safeLocalGet(roomKeyStorageKey(channelId, epoch));
	if (!raw) return null;
	try { return await unwrapLocalBytes(JSON.parse(raw)); } catch { return null; }
}

function normalizeMessageUserId(value: string | undefined): number {
	if (!value) return 0;
	const raw = value.startsWith('user-') ? value.slice(5) : value;
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

async function currentRoomKey(channelId: string, epoch: number, status?: E2eeRoomStatus): Promise<Uint8Array> {
	const cached = await cachedRoomKey(channelId, epoch);
	if (cached) return cached;
	const room = status ?? await getE2eeRoomStatus(channelId);
	if (!room.enabled || room.epoch !== epoch) {
		throw new Error('This device does not have the historical E2EE key for that message epoch.');
	}
	const identity = await ensureE2eeDeviceRegistered();
	const envelope = room.keyEnvelopes.find((entry) => entry.recipientDeviceId === identity.deviceId);
	if (!envelope) throw new Error('This device was not a recipient of the current E2EE room key. Rekey the room from a participant device.');
	const sender = room.devices.find((device) => device.deviceId === envelope.senderDeviceId);
	if (!sender) throw new Error('The E2EE room-key sender device is no longer available for verification.');
	await pinDevice(sender, true);
	const unsigned = { ...envelope } as WrappedRoomKey;
	const signature = unsigned.signature;
	delete (unsigned as any).signature;
	if (!await verify(sender.signingPublicKey, roomKeyCanonical(channelId, epoch, room.membershipRevision, unsigned), signature)) {
		throw new Error('Room-key signature verification failed. Wabi refused the key.');
	}
	const wrappingKey = await deriveWrappingKey(
		identity.encryptionPrivateKey,
		envelope.ephemeralPublicKey,
		base64ToBytes(envelope.salt),
		`wabi-room-key-v1|${channelId}|${epoch}|${room.membershipRevision}|${identity.deviceId}`
	);
	const clear = await requireCrypto().decrypt(
		{ name: 'AES-GCM', iv: base64ToBytes(envelope.iv) }, wrappingKey, base64ToBytes(envelope.ciphertext)
	);
	const keyBytes = new Uint8Array(clear);
	if (keyBytes.length !== 32) throw new Error('Invalid E2EE room key length.');
	await cacheRoomKey(channelId, epoch, keyBytes);
	return keyBytes;
}

async function buildRoomEnvelopes(channelId: string, status: E2eeRoomStatus, epoch: number, roomKey: Uint8Array, allowNewDevices: boolean) {
	if (status.missingUserIds.length) {
		throw new Error(`Every participant must open an updated Wabi client before E2EE can start. Missing E2EE devices for user IDs: ${status.missingUserIds.join(', ')}`);
	}
	await pinDevices(status.devices, allowNewDevices);
	const identity = await ensureE2eeDeviceRegistered();
	return Promise.all(status.devices.map((device) => wrapRoomKey(
		channelId, epoch, status.currentMembershipRevision, roomKey, device, identity,
	)));
}

async function setRoom(channelId: string, rekey: boolean, allowNewDevices: boolean): Promise<E2eeRoomStatus> {
	const identity = await ensureE2eeDeviceRegistered();
	const status = await getE2eeRoomStatus(channelId, false);
	if (status.enabled && !rekey && !status.needsRekey) return status;
	if (!status.enabled && rekey) throw new Error('E2EE is not enabled in this conversation.');
	const epoch = rekey ? status.epoch + 1 : 1;
	const roomKey = crypto.getRandomValues(new Uint8Array(32));
	const envelopes = await buildRoomEnvelopes(channelId, status, epoch, roomKey, allowNewDevices);
	const endpoint = rekey ? 'rekey' : 'enable';
	await responseJson(await authorizedFetch(`/api/e2ee/channels/${encodeURIComponent(channelId)}/${endpoint}`, {
		method: 'POST',
		body: JSON.stringify({
			senderDeviceId: identity.deviceId,
			epoch,
			membershipRevision: status.currentMembershipRevision,
			envelopes,
		})
	}));
	await cacheRoomKey(channelId, epoch, roomKey);
	return getE2eeRoomStatus(channelId, false);
}

/** Explicit user action: first-time enabling accepts/pins the currently shown participant devices. */
export async function enableE2eeRoom(channelId: string): Promise<E2eeRoomStatus> {
	return setRoom(channelId, false, true);
}

/** Rekey refuses newly introduced device identities unless the caller explicitly approves them. */
export async function rekeyE2eeRoom(channelId: string, allowNewDevices = false): Promise<E2eeRoomStatus> {
	return setRoom(channelId, true, allowNewDevices);
}

export async function getE2eeSecuritySummary(channelId: string): Promise<{ status: E2eeRoomStatus; devices: Array<E2eeDeviceBundle & { fingerprint: string }> }> {
	const status = await getE2eeRoomStatus(channelId, false);
	const devices = await Promise.all(status.devices.map(async (device) => ({ ...device, fingerprint: await fingerprintDevice(device) })));
	return { status, devices };
}

function sensitiveOptions(options: Record<string, unknown>): Record<string, unknown> {
	const allowed = ['replyTo', 'gifUrl', 'emojiUrl', 'emojiName', 'fileUrl', 'fileName', 'fileSize', 'files', 'attachmentEncryption', 'attachmentStorage', 'isSpoiler', 'entities'];
	const out: Record<string, unknown> = {};
	for (const key of allowed) if (options[key] !== undefined) out[key] = options[key];
	return out;
}

function opaqueFileRefs(options: Record<string, unknown>): Array<{ fileUrl: string; fileName: string; fileSize: number }> {
	const refs: Array<{ fileUrl: string; fileName: string; fileSize: number }> = [];
	if (Array.isArray(options.files)) {
		for (const file of options.files as any[]) {
			if (typeof file?.fileUrl === 'string' && file.fileUrl) refs.push({ fileUrl: file.fileUrl, fileName: 'encrypted.bin', fileSize: 0 });
		}
	} else if (typeof options.fileUrl === 'string' && options.fileUrl) {
		refs.push({ fileUrl: options.fileUrl, fileName: 'encrypted.bin', fileSize: 0 });
	}
	return refs;
}

export async function encryptMessageForChannel(
	channelId: string, text: string, type: string, options: Record<string, unknown> = {},
): Promise<null | { wireText: string; wireType: 'text'; wireOptions: Record<string, unknown>; epoch: number }> {
	let status = await getE2eeRoomStatus(channelId);
	if (!status.enabled) return null;
	if (status.needsRekey) status = await rekeyE2eeRoom(channelId, false);
	const identity = await ensureE2eeDeviceRegistered();
	const roomKeyBytes = await currentRoomKey(channelId, status.epoch, status);
	const roomKey = await requireCrypto().importKey('raw', roomKeyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
	const payload: E2eePayload = { v: 1, text, type, options: sensitiveOptions(options) };
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const aad = messageAad(channelId, status.epoch, status.membershipRevision, identity.deviceId);
	const ciphertext = await requireCrypto().encrypt(
		{ name: 'AES-GCM', iv, additionalData: aad }, roomKey, encoder.encode(JSON.stringify(payload))
	);
	const unsigned: Omit<E2eeMessageEnvelope, 'signature'> = {
		v: 1,
		room: channelId,
		epoch: status.epoch,
		membershipRevision: status.membershipRevision,
		senderDeviceId: identity.deviceId,
		iv: bytesToBase64(iv),
		ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
	};
	const envelope: E2eeMessageEnvelope = { ...unsigned, signature: await sign(identity.signingPrivateKey, messageCanonical(unsigned)) };
	const refs = opaqueFileRefs(options);
	return {
		wireText: E2EE_MESSAGE_PREFIX + JSON.stringify(envelope),
		wireType: 'text',
		wireOptions: { encrypted: true, ...(refs.length ? { files: refs } : {}) },
		epoch: status.epoch,
	};
}

function parseEnvelope(content: string): E2eeMessageEnvelope | null {
	if (!content.startsWith(E2EE_MESSAGE_PREFIX)) return null;
	try {
		const value = JSON.parse(content.slice(E2EE_MESSAGE_PREFIX.length));
		if (value?.v !== 1 || typeof value.room !== 'string' || typeof value.senderDeviceId !== 'string') return null;
		return value as E2eeMessageEnvelope;
	} catch { return null; }
}

function safeDecryptedOptions(options: Record<string, unknown>): Partial<Message> {
	const out: Record<string, unknown> = {};
	for (const key of ['replyTo', 'gifUrl', 'emojiUrl', 'emojiName', 'fileUrl', 'fileName', 'fileSize', 'files', 'attachmentEncryption', 'attachmentStorage', 'isSpoiler', 'entities']) {
		if (options[key] !== undefined) out[key] = options[key];
	}
	return out as Partial<Message>;
}

export async function prepareIncomingE2eeMessage(channelId: string, message: Message): Promise<E2eePreparedMessage> {
	const envelope = parseEnvelope(String(message.text || ''));
	if (!envelope) return message;
	try {
		if (envelope.room !== channelId) throw new Error('Encrypted message room mismatch.');
		const senderUserId = normalizeMessageUserId(message.userId);
		if (!senderUserId) throw new Error('Encrypted message sender identity is missing.');
		const status = await getE2eeRoomStatus(channelId);
		let sender = status.devices.find((device) => device.userId === senderUserId && device.deviceId === envelope.senderDeviceId);
		if (!sender) {
			const pinRaw = safeLocalGet(pinStorageKey(senderUserId, envelope.senderDeviceId));
			if (!pinRaw) throw new Error('Sender device is not known to this E2EE conversation.');
			const pin = JSON.parse(pinRaw);
			sender = {
				userId: senderUserId, deviceId: envelope.senderDeviceId, label: 'Previously verified device',
				encryptionPublicKey: pin.encryptionPublicKey, signingPublicKey: pin.signingPublicKey,
				createdAt: '', lastSeenAt: '', revokedAt: null,
			};
		}
		await pinDevice(sender, true);
		const unsigned: Omit<E2eeMessageEnvelope, 'signature'> = { ...envelope } as any;
		delete (unsigned as any).signature;
		if (!await verify(sender.signingPublicKey, messageCanonical(unsigned), envelope.signature)) {
			throw new Error('Encrypted message signature verification failed.');
		}
		const keyBytes = await currentRoomKey(channelId, envelope.epoch, status);
		const key = await requireCrypto().importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
		const clear = await requireCrypto().decrypt(
			{
				name: 'AES-GCM',
				iv: base64ToBytes(envelope.iv),
				additionalData: messageAad(channelId, envelope.epoch, envelope.membershipRevision, envelope.senderDeviceId),
			},
			key,
			base64ToBytes(envelope.ciphertext),
		);
		const payload = JSON.parse(decoder.decode(clear)) as E2eePayload;
		if (payload?.v !== 1 || typeof payload.text !== 'string' || typeof payload.type !== 'string') throw new Error('Invalid decrypted message payload.');
		return {
			...message,
			...safeDecryptedOptions(payload.options || {}),
			text: payload.text,
			type: payload.type as Message['type'],
			encrypted: true,
			e2ee: true,
			e2eeVerified: true,
			e2eeEpoch: envelope.epoch,
			e2eeSenderDeviceId: envelope.senderDeviceId,
		};
	} catch (error) {
		const detail = error instanceof Error ? error.message : 'Unable to decrypt message.';
		return {
			...message,
			text: '[Unable to decrypt this end-to-end encrypted message on this device]',
			type: 'text' as Message['type'],
			encrypted: true,
			e2ee: true,
			e2eeVerified: false,
			e2eeError: detail,
		};
	}
}

function chunkIv(prefix: Uint8Array, index: number): Uint8Array {
	const iv = new Uint8Array(12);
	iv.set(prefix.slice(0, 8), 0);
	new DataView(iv.buffer).setUint32(8, index, false);
	return iv;
}

function fileAad(channelId: string, epoch: number, fileId: string, index: number): Uint8Array {
	return encoder.encode(`wabi-e2ee-file-v1|${channelId}|${epoch}|${fileId}|${index}`);
}

export async function encryptAttachmentForChannel(
	channelId: string, file: File,
): Promise<null | { file: File; metadata: E2eeAttachmentMeta; originalName: string }> {
	let status = await getE2eeRoomStatus(channelId);
	if (!status.enabled) return null;
	if (status.needsRekey) status = await rekeyE2eeRoom(channelId, false);
	const keyBytes = await currentRoomKey(channelId, status.epoch, status);
	const key = await requireCrypto().importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
	const noncePrefix = crypto.getRandomValues(new Uint8Array(8));
	const fileId = crypto.randomUUID();
	const parts: ArrayBuffer[] = [];
	let index = 0;
	for (let offset = 0; offset < file.size; offset += FILE_CHUNK_SIZE, index += 1) {
		const plain = await file.slice(offset, Math.min(offset + FILE_CHUNK_SIZE, file.size)).arrayBuffer();
		parts.push(await requireCrypto().encrypt({
			name: 'AES-GCM', iv: chunkIv(noncePrefix, index), additionalData: fileAad(channelId, status.epoch, fileId, index),
		}, key, plain));
	}
	const opaqueName = `e2ee-${crypto.randomUUID()}.wabi`;
	const encryptedFile = new File(parts, opaqueName, { type: 'application/octet-stream', lastModified: file.lastModified });
	const prefix = bytesToBase64(noncePrefix);
	const metadata: E2eeAttachmentMeta = {
		scheme: 'dm-e2ee-v1',
		iv: prefix,
		mimeType: file.type || 'application/octet-stream',
		originalSize: file.size,
		epoch: status.epoch,
		chunkSize: FILE_CHUNK_SIZE,
		noncePrefix: prefix,
		fileId,
	};
	return { file: encryptedFile, metadata, originalName: file.name };
}

export async function decryptAttachmentBlob(
	channelId: string, encrypted: Blob, metadata: E2eeAttachmentMeta,
): Promise<Blob> {
	const epoch = Number(metadata.epoch || 0);
	const originalSize = Number(metadata.originalSize || 0);
	const chunkSize = Number(metadata.chunkSize || FILE_CHUNK_SIZE);
	const fileId = String(metadata.fileId || '');
	const prefix = base64ToBytes(String(metadata.noncePrefix || metadata.iv || ''));
	if (!epoch || !originalSize || !fileId || prefix.length !== 8 || !chunkSize) throw new Error('Encrypted attachment metadata is incomplete.');
	const keyBytes = await currentRoomKey(channelId, epoch);
	const key = await requireCrypto().importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
	const parts: ArrayBuffer[] = [];
	const chunks = Math.ceil(originalSize / chunkSize);
	let encryptedOffset = 0;
	for (let index = 0; index < chunks; index += 1) {
		const plainLength = Math.min(chunkSize, originalSize - index * chunkSize);
		const cipherLength = plainLength + 16;
		const cipher = await encrypted.slice(encryptedOffset, encryptedOffset + cipherLength).arrayBuffer();
		encryptedOffset += cipherLength;
		parts.push(await requireCrypto().decrypt({
			name: 'AES-GCM', iv: chunkIv(prefix, index), additionalData: fileAad(channelId, epoch, fileId, index),
		}, key, cipher));
	}
	return new Blob(parts, { type: metadata.mimeType || 'application/octet-stream' });
}

/** Web/Tauri clients can show this caveat beside the E2EE badge. */
export const E2EE_CLIENT_INTEGRITY_NOTE =
	'E2EE keeps plaintext and room keys off the Wabi server. A malicious web server could still serve modified JavaScript; the installed desktop client provides a stronger client-integrity boundary.';
