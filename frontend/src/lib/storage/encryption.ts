import { browser } from '$app/environment';
import { deriveKey } from '../storage-compression';
import { setEncryptionKey } from './indexeddb';
import { ENCRYPTION_KEY_SETTING, ENCRYPTION_ENABLED_SETTING, safeLocalGet, safeLocalSet } from './utils';

export async function enableStorageEncryption(password: string): Promise<void> {
	if (!browser) throw new Error('Encryption not available in SSR');

	const encryptionKey = await deriveKey(password);
	setEncryptionKey(encryptionKey);

	const salt = 'wabi-storage-salt-v1';
	localStorage.setItem(ENCRYPTION_KEY_SETTING, JSON.stringify({ salt, version: 1 }));
	localStorage.setItem(ENCRYPTION_ENABLED_SETTING, 'true');

	console.log('[Storage] Encryption enabled');
}

export async function disableStorageEncryption(): Promise<void> {
	setEncryptionKey(null);
	localStorage.removeItem(ENCRYPTION_KEY_SETTING);
	localStorage.removeItem(ENCRYPTION_ENABLED_SETTING);

	console.log('[Storage] Encryption disabled');
}

export async function initializeStorageEncryption(password?: string): Promise<void> {
	if (!browser) return;

	const enabled = localStorage.getItem(ENCRYPTION_ENABLED_SETTING) === 'true';
	const keyParams = localStorage.getItem(ENCRYPTION_KEY_SETTING);

	if (!enabled || !keyParams || !password) {
		setEncryptionKey(null);
		return;
	}

	try {
		const params = JSON.parse(keyParams);
		const encryptionKey = await deriveKey(password);
		setEncryptionKey(encryptionKey);
		console.log('[Storage] Encryption initialized');
	} catch (err) {
		console.error('[Storage] Failed to initialize encryption:', err);
		setEncryptionKey(null);
	}
}

export function isStorageEncryptionEnabled(): boolean {
	return browser && localStorage.getItem(ENCRYPTION_ENABLED_SETTING) === 'true';
}
