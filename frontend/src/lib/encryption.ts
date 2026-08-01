/**
 * Hybrid Encryption Utilities for Art Resource Graph
 * - Metadata (name, tags) stored unencrypted for searchability
 * - Content (file data, descriptions) encrypted client-side
 */

/**
 * Generate a new ECDH key pair for client-side encryption
 */
export async function generateKeyPair(): Promise<{
	publicKey: string;
	privateKey: string;
}> {
	if (!((typeof globalThis !== "undefined" && (globalThis as any).crypto) || (typeof window !== "undefined" && window.crypto))) {
		throw new Error('Web Crypto API not available in this environment');
	}

	const keyPair = await getSubtle().generateKey(
		{
			name: 'ECDH',
			namedCurve: 'P-256'
		},
		true,
		['deriveKey', 'deriveBits']
	);

	// Export keys for storage
	const publicKeyExported = await getSubtle().exportKey('raw', keyPair.publicKey);
	const privateKeyExported = await getSubtle().exportKey('pkcs8', keyPair.privateKey);

	// Convert to base64
	const publicKeyBase64 = arrayBufferToBase64(publicKeyExported);
	const privateKeyBase64 = arrayBufferToBase64(privateKeyExported);

	return {
		publicKey: publicKeyBase64,
		privateKey: privateKeyBase64
	};
}

/**
 * Derive a shared AES key from private key and recipient's public key
 */
export async function deriveSharedKey(
	privateKeyBase64: string,
	publicKeyBase64: string
): Promise<CryptoKey> {
	if (!((typeof globalThis !== "undefined" && (globalThis as any).crypto) || (typeof window !== "undefined" && window.crypto))) {
		throw new Error('Web Crypto API not available');
	}

	// Import keys
	const privateKey = await getSubtle().importKey(
		'pkcs8',
		base64ToArrayBuffer(privateKeyBase64),
		{
			name: 'ECDH',
			namedCurve: 'P-256'
		},
		true,
		['deriveKey']
	);

	const publicKey = await getSubtle().importKey(
		'raw',
		base64ToArrayBuffer(publicKeyBase64),
		{
			name: 'ECDH',
			namedCurve: 'P-256'
		},
		false,
		[]
	);

	// Derive shared secret
	const sharedKey = await getSubtle().deriveKey(
		{
			name: 'ECDH',
			public: publicKey
		},
		privateKey,
		{
			name: 'AES-GCM',
			length: 256
		},
		true,
		['encrypt', 'decrypt']
	);

	return sharedKey;
}

/**
 * Encrypt content using AES-GCM
 */
export async function encryptContent(
	content: string,
	sharedKey: CryptoKey
): Promise<{
	encryptedData: string;
	iv: string;
}> {
	if (!((typeof globalThis !== "undefined" && (globalThis as any).crypto) || (typeof window !== "undefined" && window.crypto))) {
		throw new Error('Web Crypto API not available');
	}

	// Generate initialization vector
	const iv = getCrypto().getRandomValues(new Uint8Array(12));

	// Encrypt content
	const encoder = new TextEncoder();
	const data = encoder.encode(content);

	const encryptedData = await getSubtle().encrypt(
		{
			name: 'AES-GCM',
			iv: iv
		},
		sharedKey,
		data
	);

	return {
		encryptedData: arrayBufferToBase64(encryptedData),
		iv: arrayBufferToBase64(iv)
	};
}

/**
 * Decrypt content using AES-GCM
 */
export async function decryptContent(
	encryptedDataBase64: string,
	ivBase64: string,
	sharedKey: CryptoKey
): Promise<string> {
	if (!((typeof globalThis !== "undefined" && (globalThis as any).crypto) || (typeof window !== "undefined" && window.crypto))) {
		throw new Error('Web Crypto API not available');
	}

	// Decode base64
	const encryptedData = base64ToArrayBuffer(encryptedDataBase64);
	const iv = base64ToArrayBuffer(ivBase64);

	// Decrypt content
	const decryptedData = await getSubtle().decrypt(
		{
			name: 'AES-GCM',
			iv: iv
		},
		sharedKey,
		encryptedData
	);

	// Decode and return
	const decoder = new TextDecoder();
	return decoder.decode(decryptedData);
}

/**
 * Encrypt resource content for multiple users
 * Returns a map of userId -> encrypted content
 */
export async function encryptForUsers(
	content: string,
	userPublicKeys: Map<number, string>,
	userPrivateKey: string
): Promise<Map<number, { encryptedData: string; iv: string }>> {
	const results = new Map<number, { encryptedData: string; iv: string }>();

	for (const [userId, userPublicKey] of userPublicKeys) {
		try {
			const sharedKey = await deriveSharedKey(userPrivateKey, userPublicKey);
			const encrypted = await encryptContent(content, sharedKey);
			results.set(userId, encrypted);
		} catch (error) {
			console.error(`Failed to encrypt for user ${userId}:`, error);
		}
	}

	return results;
}

/**
 * Generate a random encryption key for symmetric encryption
 */
export async function generateSymmetricKey(): Promise<CryptoKey> {
	if (!((typeof globalThis !== "undefined" && (globalThis as any).crypto) || (typeof window !== "undefined" && window.crypto))) {
		throw new Error('Web Crypto API not available');
	}

	return getSubtle().generateKey(
		{
			name: 'AES-GCM',
			length: 256
		},
		true,
		['encrypt', 'decrypt']
	);
}

/**
 * Encrypt with symmetric key (for self-encryption)
 */
export async function encryptSymmetric(
	content: string,
	key: CryptoKey
): Promise<{
	encryptedData: string;
	iv: string;
}> {
	if (!((typeof globalThis !== "undefined" && (globalThis as any).crypto) || (typeof window !== "undefined" && window.crypto))) {
		throw new Error('Web Crypto API not available');
	}

	const iv = getCrypto().getRandomValues(new Uint8Array(12));
	const encoder = new TextEncoder();
	const data = encoder.encode(content);

	const encryptedData = await getSubtle().encrypt(
		{
			name: 'AES-GCM',
			iv: iv
		},
		key,
		data
	);

	return {
		encryptedData: arrayBufferToBase64(encryptedData),
		iv: arrayBufferToBase64(iv)
	};
}

/**
 * Decrypt with symmetric key
 */
export async function decryptSymmetric(
	encryptedDataBase64: string,
	ivBase64: string,
	key: CryptoKey
): Promise<string> {
	if (!((typeof globalThis !== "undefined" && (globalThis as any).crypto) || (typeof window !== "undefined" && window.crypto))) {
		throw new Error('Web Crypto API not available');
	}

	const encryptedData = base64ToArrayBuffer(encryptedDataBase64);
	const iv = base64ToArrayBuffer(ivBase64);

	const decryptedData = await getSubtle().decrypt(
		{
			name: 'AES-GCM',
			iv: iv
		},
		key,
		encryptedData
	);

	const decoder = new TextDecoder();
	return decoder.decode(decryptedData);
}

// Utility: Convert ArrayBuffer to Base64
function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	let binary = '';
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

// Utility: Convert Base64 to ArrayBuffer
function base64ToArrayBuffer(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const buffer = new ArrayBuffer(binary.length);
	const bytes = new Uint8Array(buffer);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return buffer;
}

/**
 * Encryption key storage with at-rest protection.
 *
 * Private keys are wrapped with AES-GCM using a key derived (PBKDF2) from
 * a wrapping secret before being persisted to localStorage.  The wrapping
 * secret should be session-scoped (e.g. the auth token kept in sessionStorage)
 * so that raw private keys are never stored long-term.
 *
 * When no wrapping secret is available (e.g. the session has ended), the
 * encrypted blob stays in localStorage and can be unlocked on the next login.
 *
 * Migration: on first load, any legacy plaintext keys are automatically
 * wrapped and re-saved.
 */
export const ENCRYPTION_STORAGE_KEY = 'wabi_encryption_keys';
/** Per-install device secret used when no session wrapping secret is set. Never reuse a hardcoded salt. */
export const DEVICE_WRAP_SECRET_KEY = 'wabi_device_wrap_secret_v1';

function getCrypto(): Crypto {
	const c = (typeof globalThis !== 'undefined' && (globalThis as any).crypto) || (typeof window !== 'undefined' ? window.crypto : undefined);
	if (!c) throw new Error('Web Crypto unavailable');
	return c;
}
function getSubtle(): SubtleCrypto {
	const s = getCrypto().subtle;
	if (!s) throw new Error('Web Crypto subtle unavailable');
	return s;
}


// Module-level wrapping secret — set once per session via setKeyWrappingSecret()
let wrappingSecret: string | null = null;

export function setKeyWrappingSecret(secret: string | null): void {
	wrappingSecret = secret;
}

/**
 * Device-scoped secret for at-rest key wrapping when no user/session passphrase is active.
 * Generated once per browser profile and stored separately from the encrypted private keys.
 *
 * ## Threat model (finding 24)
 *
 * Protects against: cold-disk / stolen-profile theft of the *wrapped private key blob alone*
 * (without also having this per-install secret).
 *
 * Does NOT protect against:
 * - Active XSS / same-origin script that can read both localStorage keys
 * - Full browser-profile exfiltration (wrapped key + this secret together)
 * - Malicious extensions with storage access
 *
 * Defense-in-depth only. Prefer setKeyWrappingSecret() with a short-lived in-memory
 * session secret when available. Stronger options (not yet shipped): user passphrase
 * KDF, or Tauri/platform secure storage instead of colocating wrap secret + ciphertext.
 *
 * UI copy that mentions local key storage should state this limitation honestly.
 */
export function getOrCreateDeviceWrapSecret(): string {
	try {
		const existing = localStorage.getItem(DEVICE_WRAP_SECRET_KEY);
		if (existing && existing.length >= 16) return existing;
	} catch {
		// ignore storage failures; fall through to ephemeral secret for this session
	}
	const cryptoApi =
		(typeof globalThis !== 'undefined' && (globalThis as { crypto?: Crypto }).crypto) ||
		(typeof window !== 'undefined' ? window.crypto : undefined);
	if (!cryptoApi?.getRandomValues) {
		// Extremely degraded environment — still avoid empty secret
		const fallback = `fallback-${Date.now()}-${Math.random()}`;
		try {
			localStorage.setItem(DEVICE_WRAP_SECRET_KEY, fallback);
		} catch {
			/* ignore */
		}
		return fallback;
	}
	const bytes = cryptoApi.getRandomValues(new Uint8Array(32));
	const secret = arrayBufferToBase64(bytes.buffer);
	try {
		localStorage.setItem(DEVICE_WRAP_SECRET_KEY, secret);
	} catch {
		// still return secret so this process wraps keys even if persistence fails
	}
	return secret;
}

function resolveWrappingSecret(): string {
	return wrappingSecret && wrappingSecret.length > 0
		? wrappingSecret
		: getOrCreateDeviceWrapSecret();
}

async function deriveWrappingKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
	const enc = new TextEncoder();
	const keyMaterial = await getSubtle().importKey(
		'raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']
	);
	return getSubtle().deriveKey(
		{ name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: 100_000, hash: 'SHA-256' },
		keyMaterial,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

async function wrapPrivateKey(privateKeyB64: string, secret: string): Promise<string> {
	const salt = getCrypto().getRandomValues(new Uint8Array(16));
	const iv = getCrypto().getRandomValues(new Uint8Array(12));
	const wrappingKey = await deriveWrappingKey(secret, salt);
	const enc = new TextEncoder();
	const ciphertext = await getSubtle().encrypt(
		{ name: 'AES-GCM', iv },
		wrappingKey,
		enc.encode(privateKeyB64)
	);
	// Format: base64(salt) . base64(iv) . base64(ciphertext)
	return `${arrayBufferToBase64(salt)}.${arrayBufferToBase64(iv)}.${arrayBufferToBase64(ciphertext)}`;
}

async function unwrapPrivateKey(wrapped: string, secret: string): Promise<string> {
	const parts = wrapped.split('.');
	if (parts.length !== 3) throw new Error('Invalid wrapped key format');
	const salt = new Uint8Array(base64ToArrayBuffer(parts[0]));
	const iv = new Uint8Array(base64ToArrayBuffer(parts[1]));
	const ciphertext = base64ToArrayBuffer(parts[2]);
	const wrappingKey = await deriveWrappingKey(secret, salt);
	const plaintext = await getSubtle().decrypt(
		{ name: 'AES-GCM', iv },
		wrappingKey,
		ciphertext
	);
	return new TextDecoder().decode(plaintext);
}

function isWrappedKey(value: string): boolean {
	// Wrapped keys have the 3-part dot-separated format
	return typeof value === 'string' && value.split('.').length === 3;
}

interface StoredKeyEntry {
	publicKey: string;
	privateKey: string; // may be plaintext (legacy) or wrapped (3-part dot format)
}

export async function saveUserKeys(userId: number, publicKey: string, privateKey: string): Promise<void> {
	const keys = loadAllKeysRaw();
	// Always wrap before persistence — never write a raw private key to localStorage.
	const secret = resolveWrappingSecret();
	const wrappedPrivate = await wrapPrivateKey(privateKey, secret);
	keys[userId.toString()] = { publicKey, privateKey: wrappedPrivate };
	localStorage.setItem(ENCRYPTION_STORAGE_KEY, JSON.stringify(keys));
}

export async function loadUserKeys(userId: number): Promise<{ publicKey: string; privateKey: string } | null> {
	const keys = loadAllKeysRaw();
	const entry = keys[userId.toString()];
	if (!entry) return null;

	// If the stored key is wrapped, try session secret then device secret
	if (isWrappedKey(entry.privateKey)) {
		const candidates = [
			wrappingSecret,
			// Always allow device secret as fallback so keys unlock without an active session passphrase
			typeof localStorage !== 'undefined' ? localStorage.getItem(DEVICE_WRAP_SECRET_KEY) : null,
		].filter((s): s is string => typeof s === 'string' && s.length > 0);

		// Prefer explicit session secret first, then device secret (may already be in list)
		const tried = new Set<string>();
		for (const secret of candidates) {
			if (tried.has(secret)) continue;
			tried.add(secret);
			try {
				const decryptedPrivate = await unwrapPrivateKey(entry.privateKey, secret);
				return { publicKey: entry.publicKey, privateKey: decryptedPrivate };
			} catch {
				// try next secret
			}
		}
		console.warn('[Encryption] Failed to unwrap private key — no matching wrapping secret');
		return null;
	}

	// Legacy plaintext key — always migrate to wrapped format on load
	try {
		const secret = resolveWrappingSecret();
		const wrappedPrivate = await wrapPrivateKey(entry.privateKey, secret);
		keys[userId.toString()] = { publicKey: entry.publicKey, privateKey: wrappedPrivate };
		localStorage.setItem(ENCRYPTION_STORAGE_KEY, JSON.stringify(keys));
	} catch {
		// Migration failed; still return plaintext once so the session can recover, but prefer not to re-save raw
	}
	return { publicKey: entry.publicKey, privateKey: entry.privateKey };
}

function loadAllKeysRaw(): Record<string, StoredKeyEntry> {
	try {
		const stored = localStorage.getItem(ENCRYPTION_STORAGE_KEY);
		return stored ? JSON.parse(stored) : {};
	} catch {
		return {};
	}
}

/**
 * Check if content is encrypted (simple heuristic)
 */
export function isEncryptedContent(content: string): boolean {
	// Base64 encoded content (with IV)
	// Format: encryptedData::iv
	return content.includes('::') && /^[A-Za-z0-9+/]+=*$/.test(content.split('::')[0]);
}
