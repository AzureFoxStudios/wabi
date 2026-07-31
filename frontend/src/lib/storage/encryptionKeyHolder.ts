/**
 * Single in-memory AES key holder for at-rest storage encryption.
 * Both legacy (storageDb) and storage/ (indexeddb) wrappers must use this
 * so enable on one path arms the other.
 */
let encryptionKey: CryptoKey | null = null;

export function setEncryptionKey(key: CryptoKey | null): void {
	encryptionKey = key;
}

export function getEncryptionKey(): CryptoKey | null {
	return encryptionKey;
}
