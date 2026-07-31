import { browser } from '$app/environment';
import {
	deriveKey,
	generateStorageSalt,
	saltBytesToB64,
	saltFromKeyParams,
	type StorageKeyParams,
	STORAGE_PBKDF2_ITERATIONS
} from '../storage-compression';
import { setEncryptionKey } from './encryptionKeyHolder';
import { ENCRYPTION_KEY_SETTING, ENCRYPTION_ENABLED_SETTING } from './utils';

function readKeyParams(): StorageKeyParams | null {
	if (!browser) return null;
	try {
		const raw = localStorage.getItem(ENCRYPTION_KEY_SETTING);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<StorageKeyParams> & { salt?: string; saltB64?: string };
		if (parsed?.version === 2 && typeof parsed.saltB64 === 'string' && parsed.saltB64.length > 0) {
			return { version: 2, saltB64: parsed.saltB64, iterations: parsed.iterations as number | undefined };
		}
		if (typeof parsed?.salt === 'string' && parsed.salt.length > 0) {
			return { version: 1, salt: parsed.salt };
		}
		// Unknown / empty → treat as legacy static salt
		return { version: 1, salt: 'wabi-storage-salt-v1' };
	} catch {
		return null;
	}
}

function writeKeyParams(params: StorageKeyParams): void {
	if (!browser) return;
	localStorage.setItem(ENCRYPTION_KEY_SETTING, JSON.stringify(params));
}

/**
 * Enable at-rest encryption with a fresh per-install random salt (v2).
 */
export async function enableStorageEncryption(password: string): Promise<void> {
	if (!browser) throw new Error('Encryption not available in SSR');

	const salt = generateStorageSalt();
	const encryptionKey = await deriveKey(password, salt);
	setEncryptionKey(encryptionKey);

	writeKeyParams({
		version: 2,
		saltB64: saltBytesToB64(salt),
		iterations: STORAGE_PBKDF2_ITERATIONS
	});
	localStorage.setItem(ENCRYPTION_ENABLED_SETTING, 'true');

	console.log('[Storage] Encryption enabled (v2 random salt)');
}

export async function disableStorageEncryption(): Promise<void> {
	setEncryptionKey(null);
	if (browser) {
		localStorage.removeItem(ENCRYPTION_KEY_SETTING);
		localStorage.removeItem(ENCRYPTION_ENABLED_SETTING);
	}
	console.log('[Storage] Encryption disabled');
}

/**
 * Re-derive key from password + stored salt metadata (v1 static or v2 random).
 */
export async function initializeStorageEncryption(password?: string): Promise<void> {
	if (!browser) return;

	const enabled = localStorage.getItem(ENCRYPTION_ENABLED_SETTING) === 'true';
	const params = readKeyParams();

	if (!enabled || !params || !password) {
		setEncryptionKey(null);
		return;
	}

	try {
		const salt = saltFromKeyParams(params);
		const encryptionKey = await deriveKey(password, salt);
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

/** Alias used by legacy barrel. */
export function isEncryptionEnabled(): boolean {
	return isStorageEncryptionEnabled();
}
