/**
 * storageEncryption.ts
 * Storage encryption setup and management
 */

import { browser } from '$app/environment';
import { deriveKey } from './storage-compression';
import { ENCRYPTION_KEY_SETTING, ENCRYPTION_ENABLED_SETTING } from './storageTypes';
import { setEncryptionKey } from './storageDb';

export async function enableStorageEncryption(password: string): Promise<void> {
	if (!browser) throw new Error('Encryption not available in SSR');

	const encryptionKey = await deriveKey(password);

	const salt = 'wabi-storage-salt-v1';
	localStorage.setItem(ENCRYPTION_KEY_SETTING, JSON.stringify({ salt, version: 1 }));
	localStorage.setItem(ENCRYPTION_ENABLED_SETTING, 'true');

	setEncryptionKey(encryptionKey);

	console.log('[Storage] Encryption enabled');
}

export async function disableStorageEncryption(): Promise<void> {
	setEncryptionKey(null);
	localStorage.removeItem(ENCRYPTION_KEY_SETTING);
	localStorage.removeItem(ENCRYPTION_ENABLED_SETTING);
	console.log('[Storage] Encryption disabled');
}

export function isEncryptionEnabled(): boolean {
	if (!browser) return false;
	return localStorage.getItem(ENCRYPTION_ENABLED_SETTING) === 'true';
}
