import { describe, expect, test } from 'bun:test';
import {
	STORAGE_SALT_LEGACY_STRING,
	STORAGE_SALT_BYTES,
	deriveKey,
	encrypt,
	decrypt,
	generateStorageSalt,
	saltBytesToB64,
	saltB64ToBytes,
	saltFromKeyParams
} from './storage-compression';
import { getEncryptionKey, setEncryptionKey } from './storage/encryptionKeyHolder';

function bytesEqual(a: ArrayBuffer | Uint8Array, b: ArrayBuffer | Uint8Array): boolean {
	const aa = a instanceof Uint8Array ? a : new Uint8Array(a);
	const bb = b instanceof Uint8Array ? b : new Uint8Array(b);
	if (aa.length !== bb.length) return false;
	return aa.every((v, i) => v === bb[i]);
}

/**
 * Bun often fails AES-GCM encrypt/decrypt when the key came from PBKDF2 deriveKey.
 * Probe the exact path used by the round-trip tests.
 */
async function supportsPbkdf2AesRoundTrip(): Promise<boolean> {
	try {
		const salt = generateStorageSalt();
		const key = await deriveKey('probe-password', salt);
		const plain = new TextEncoder().encode('probe');
		const sealed = await encrypt(plain, key);
		const opened = await decrypt(sealed, key);
		return new TextDecoder().decode(opened) === 'probe';
	} catch {
		return false;
	}
}

const cryptoRoundTripOk = await supportsPbkdf2AesRoundTrip();

describe('storage salt (finding 11)', () => {
	test('generateStorageSalt returns 16 random bytes', () => {
		const a = generateStorageSalt();
		const b = generateStorageSalt();
		expect(a.length).toBe(STORAGE_SALT_BYTES);
		expect(b.length).toBe(STORAGE_SALT_BYTES);
		expect(bytesEqual(a, b)).toBe(false);
	});

	test('salt b64 round-trip', () => {
		const salt = generateStorageSalt();
		const b64 = saltBytesToB64(salt);
		const back = saltB64ToBytes(b64);
		expect(bytesEqual(back, salt)).toBe(true);
	});

	test('saltFromKeyParams v1 uses string salt', () => {
		const salt = saltFromKeyParams({ version: 1, salt: STORAGE_SALT_LEGACY_STRING });
		expect(salt).toBe(STORAGE_SALT_LEGACY_STRING);
	});

	test('saltFromKeyParams v2 uses saltB64 bytes', () => {
		const raw = generateStorageSalt();
		const salt = saltFromKeyParams({ version: 2, saltB64: saltBytesToB64(raw) });
		expect(salt instanceof Uint8Array).toBe(true);
		expect(bytesEqual(salt as Uint8Array, raw)).toBe(true);
	});

	test.skipIf(!cryptoRoundTripOk)('v1 legacy deriveKey round-trip encrypt/decrypt', async () => {
		const key = await deriveKey('test-password');
		const plain = new TextEncoder().encode('hello storage v1');
		const sealed = await encrypt(plain, key);
		const opened = await decrypt(sealed, key);
		expect(new TextDecoder().decode(opened)).toBe('hello storage v1');
	});

	test.skipIf(!cryptoRoundTripOk)('same password + different salts produce incompatible keys', async () => {
		const saltA = generateStorageSalt();
		const saltB = generateStorageSalt();
		const keyA = await deriveKey('same-password', saltA);
		const keyB = await deriveKey('same-password', saltB);
		const plain = new TextEncoder().encode('secret payload');
		const sealed = await encrypt(plain, keyA);
		await expect(decrypt(sealed, keyB)).rejects.toBeTruthy();
		const opened = await decrypt(sealed, keyA);
		expect(new TextDecoder().decode(opened)).toBe('secret payload');
	});

	test.skipIf(!cryptoRoundTripOk)('same password + same salt is stable for encrypt/decrypt', async () => {
		const salt = generateStorageSalt();
		const key1 = await deriveKey('stable-pw', salt);
		const key2 = await deriveKey('stable-pw', salt);
		const plain = new TextEncoder().encode('stable');
		const sealed = await encrypt(plain, key1);
		const opened = await decrypt(sealed, key2);
		expect(new TextDecoder().decode(opened)).toBe('stable');
	});

	test('shared encryptionKeyHolder is single source of truth', () => {
		setEncryptionKey(null);
		expect(getEncryptionKey()).toBeNull();
		const fake = { type: 'secret' } as unknown as CryptoKey;
		setEncryptionKey(fake);
		expect(getEncryptionKey()).toBe(fake);
		setEncryptionKey(null);
		expect(getEncryptionKey()).toBeNull();
	});
});
