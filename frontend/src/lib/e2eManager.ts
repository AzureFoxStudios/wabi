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

/**
 * Initialize E2E encryption for the current user.
 * On registration: generates new keys, saves locally, uploads public key to server.
 * On login: loads existing keys from localStorage.
 */
export async function initE2E(dbUserId: number, token: string, isNewRegistration: boolean): Promise<void> {
	currentDbUserId = dbUserId;
	currentToken = token;
	sharedKeyCache.clear();
	publicKeyCache.clear();

	if (isNewRegistration) {
		try {
			const keyPair = await generateKeyPair();
			saveUserKeys(dbUserId, keyPair.publicKey, keyPair.privateKey);
			currentPublicKey = keyPair.publicKey;
			currentPrivateKey = keyPair.privateKey;

			// Upload public key + encrypted private key to server
			await storeEncryptionKeys(token, keyPair.publicKey, keyPair.privateKey);
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
				await storeEncryptionKeys(token, stored.publicKey, stored.privateKey);
			} catch (err) {
				// 409 is expected if keys already exist
				// 401/403 means user was deleted or session is invalid
				if (err instanceof Error && (err.message.includes('401') || err.message.includes('403'))) {
					console.error('[E2E] User no longer exists or session invalid:', err);
					throw err; // Propagate to trigger logout
				}
				// Other errors are ignored
			}
		} else {
			console.log('[E2E] No local keys found — encryption unavailable until key recovery');
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
	if (!currentPrivateKey || !currentToken) return null;

	// Check cache first
	const cached = sharedKeyCache.get(otherDbUserId);
	if (cached) return cached;

	// Get other user's public key
	let otherPublicKey = publicKeyCache.get(otherDbUserId);
	if (otherPublicKey === undefined) {
		otherPublicKey = await getPublicKey(currentToken, otherDbUserId);
		publicKeyCache.set(otherDbUserId, otherPublicKey);
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
	token: string
): Promise<{ text: string; encrypted: boolean; iv: string } | null> {
	if (!isE2EAvailable()) return null;

	// Update token in case it changed
	currentToken = token;

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
	token: string
): Promise<string> {
	if (!message.encrypted || !message.iv) return message.text;
	if (!isE2EAvailable()) return '[Encrypted message]';

	currentToken = token;

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
}
