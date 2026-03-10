import { generateKeyPair, deriveSharedKey, encryptContent, decryptContent, saveUserKeys, loadUserKeys } from './encryption';
import { storeEncryptionKeys, getPublicKey } from './api';

let currentDbUserId: number | null = null;
let currentToken: string | null = null;
let currentPrivateKey: string | null = null;
let currentPublicKey: string | null = null;

// Cache shared keys per DM partner to avoid re-deriving
const sharedKeyCache = new Map<number, CryptoKey>();
// Cache public keys per user to avoid re-fetching
const publicKeyCache = new Map<number, string | null>();
const publicKeyNegativeCacheUntil = new Map<number, number>();
const PUBLIC_KEY_RETRY_MS = 10_000;

function isTransientNetworkError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();
	return message.includes('timed out') || message.includes('abort');
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function storeEncryptionKeysWithRetry(
	token: string | null | undefined,
	publicKey: string,
	privateKeyEncrypted: string
): Promise<void> {
	let lastError: unknown = null;
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			await storeEncryptionKeys(token, publicKey, privateKeyEncrypted);
			return;
		} catch (error) {
			lastError = error;
			if (attempt < 2 && isTransientNetworkError(error)) {
				await sleep(250);
				continue;
			}
			throw error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error('Failed to store encryption keys');
}

/**
 * Initialize E2E encryption for the current user.
 * On registration: generates new keys, saves locally, uploads public key to server.
 * On login: loads existing keys from localStorage.
 */
export async function initE2E(dbUserId: number, token: string | null | undefined, isNewRegistration: boolean): Promise<void> {
	currentDbUserId = dbUserId;
	currentToken = token || null;
	sharedKeyCache.clear();
	publicKeyCache.clear();
	publicKeyNegativeCacheUntil.clear();

	if (isNewRegistration) {
		try {
			const keyPair = await generateKeyPair();
			saveUserKeys(dbUserId, keyPair.publicKey, keyPair.privateKey);
			currentPublicKey = keyPair.publicKey;
			currentPrivateKey = keyPair.privateKey;

			// Upload public key + encrypted private key to server
			await storeEncryptionKeysWithRetry(currentToken, keyPair.publicKey, keyPair.privateKey);
			console.log('[E2E] Keys generated and uploaded for new registration');
		} catch (err) {
			console.error('[E2E] Failed to generate keys on registration:', err);
		}
	} else {
		// Login — load existing keys from localStorage
		const stored = loadUserKeys(dbUserId);
		if (stored) {
			currentPublicKey = stored.publicKey;
			currentPrivateKey = stored.privateKey;
			console.log('[E2E] Loaded existing keys from localStorage');

			// Ensure server has our public key (may have been lost)
			try {
				await storeEncryptionKeysWithRetry(currentToken, stored.publicKey, stored.privateKey);
			} catch (err) {
				// 409 is expected if keys already exist
				// 401/403 means user was deleted or session is invalid
				const status = (err as any)?.status;
				if (status === 401 || status === 403) {
					console.error('[E2E] User no longer exists or session invalid (HTTP', status + '):', err);
					throw err; // Propagate to trigger logout
				}
				// Other errors are ignored
				console.warn('[E2E] Error storing encryption keys:', err);
			}
		} else {
			// Recovery path for fresh device/profile: generate keys so outbound E2E works.
			// Older encrypted history may remain unreadable without the previous private key.
			try {
				const keyPair = await generateKeyPair();
				saveUserKeys(dbUserId, keyPair.publicKey, keyPair.privateKey);
				currentPublicKey = keyPair.publicKey;
				currentPrivateKey = keyPair.privateKey;
				await storeEncryptionKeysWithRetry(currentToken, keyPair.publicKey, keyPair.privateKey);
				console.log('[E2E] No local keys found; generated replacement keypair');
			} catch (err) {
				console.error('[E2E] Failed to recover missing local keys:', err);
			}
		}
	}
}

/**
 * Check if E2E encryption is available for the current user.
 */
export function isE2EAvailable(): boolean {
	return currentPrivateKey !== null && currentPublicKey !== null && currentDbUserId !== null;
}

/**
 * Get or derive a shared key for a DM partner.
 */
async function getSharedKey(otherDbUserId: number): Promise<CryptoKey | null> {
	if (!currentPrivateKey) return null;

	// Check cache first
	const cached = sharedKeyCache.get(otherDbUserId);
	if (cached) return cached;

	// Get other user's public key.
	// Important: do not permanently cache failures (null), otherwise a single transient
	// network/auth hiccup can disable DM encryption until logout.
	let otherPublicKey = publicKeyCache.get(otherDbUserId) ?? null;
	if (!otherPublicKey) {
		const now = Date.now();
		const nextAllowed = publicKeyNegativeCacheUntil.get(otherDbUserId) ?? 0;
		if (now < nextAllowed) return null;
		otherPublicKey = await getPublicKey(currentToken, otherDbUserId);
		if (otherPublicKey) {
			publicKeyCache.set(otherDbUserId, otherPublicKey);
			publicKeyNegativeCacheUntil.delete(otherDbUserId);
		} else {
			publicKeyNegativeCacheUntil.set(otherDbUserId, now + PUBLIC_KEY_RETRY_MS);
			return null;
		}
	}

	if (!otherPublicKey) return null;

	try {
		const shared = await deriveSharedKey(currentPrivateKey, otherPublicKey);
		sharedKeyCache.set(otherDbUserId, shared);
		return shared;
	} catch (err) {
		console.error('[E2E] Failed to derive shared key:', err);
		return null;
	}
}

/**
 * Encrypt a DM message for a specific recipient.
 * Returns { text, encrypted, iv } or null if encryption is not available (plaintext fallback).
 */
export async function encryptDMMessage(
	plaintext: string,
	otherDbUserId: number,
	token: string | null | undefined
): Promise<{ text: string; encrypted: boolean; iv: string } | null> {
	if (!isE2EAvailable()) return null;

	// Update token in case it changed
	currentToken = token || currentToken;

	const sharedKey = await getSharedKey(otherDbUserId);
	if (!sharedKey) return null;

	try {
		const { encryptedData, iv } = await encryptContent(plaintext, sharedKey);
		return { text: encryptedData, encrypted: true, iv };
	} catch (err) {
		console.error('[E2E] Encryption failed:', err);
		return null;
	}
}

/**
 * Decrypt a DM message from a specific sender.
 * Returns decrypted plaintext or a placeholder on failure.
 */
export async function decryptDMMessage(
	message: { text: string; encrypted?: boolean; iv?: string },
	otherDbUserId: number,
	token: string | null | undefined
): Promise<string> {
	if (!message.encrypted || !message.iv) return message.text;
	if (!isE2EAvailable()) return '[Encrypted message]';

	currentToken = token || currentToken;

	const sharedKey = await getSharedKey(otherDbUserId);
	if (!sharedKey) return '[Encrypted message]';

	try {
		return await decryptContent(message.text, message.iv, sharedKey);
	} catch (err) {
		console.error('[E2E] Decryption failed:', err);
		return '[Encrypted message]';
	}
}

/**
 * Clear all E2E state on logout.
 */
export function clearE2EState(): void {
	currentDbUserId = null;
	currentToken = null;
	currentPrivateKey = null;
	currentPublicKey = null;
	sharedKeyCache.clear();
	publicKeyCache.clear();
	publicKeyNegativeCacheUntil.clear();
}

function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	let binary = '';
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

export async function encryptDMFile(
	file: File,
	otherDbUserId: number,
	token: string | null | undefined
): Promise<{ encryptedFile: File; iv: string; mimeType: string; originalSize: number } | null> {
	if (!isE2EAvailable()) return null;
	currentToken = token || currentToken;

	const sharedKey = await getSharedKey(otherDbUserId);
	if (!sharedKey) return null;

	try {
		const ivBytes = window.crypto.getRandomValues(new Uint8Array(12));
		const plain = await file.arrayBuffer();
		const encrypted = await window.crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: ivBytes },
			sharedKey,
			plain
		);
		const encryptedFile = new File([new Uint8Array(encrypted)], file.name, {
			type: 'application/octet-stream',
			lastModified: file.lastModified
		});
		return {
			encryptedFile,
			iv: arrayBufferToBase64(ivBytes),
			mimeType: file.type || 'application/octet-stream',
			originalSize: file.size
		};
	} catch (err) {
		console.error('[E2E] File encryption failed:', err);
		return null;
	}
}

export async function decryptDMFileBuffer(
	encryptedBuffer: ArrayBuffer,
	ivBase64: string,
	otherDbUserId: number,
	token: string | null | undefined
): Promise<ArrayBuffer | null> {
	if (!isE2EAvailable()) return null;
	currentToken = token || currentToken;

	const sharedKey = await getSharedKey(otherDbUserId);
	if (!sharedKey) return null;

	try {
		const ivBytes = base64ToUint8Array(ivBase64);
		const iv = new Uint8Array(ivBytes.length);
		iv.set(ivBytes);
		const decrypted = await window.crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv },
			sharedKey,
			encryptedBuffer
		);
		return decrypted;
	} catch (err) {
		console.error('[E2E] File decryption failed:', err);
		return null;
	}
}
