/**
 * Single in-memory AES key holder for at-rest storage encryption.
 * Kept for explicit encryption utilities and format regression tests. The
 * retired chat archive paths no longer read or write encrypted archives;
 * setting a key here does not enable an offline message archive.
 */
let encryptionKey: CryptoKey | null = null;

export function setEncryptionKey(key: CryptoKey | null): void {
	encryptionKey = key;
}

export function getEncryptionKey(): CryptoKey | null {
	return encryptionKey;
}
