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
	if (!window.crypto || !window.crypto.subtle) {
		throw new Error('Web Crypto API not available in this environment');
	}

	const keyPair = await window.crypto.subtle.generateKey(
		{
			name: 'ECDH',
			namedCurve: 'P-256'
		},
		true,
		['deriveKey', 'deriveBits']
	);

	// Export keys for storage
	const publicKeyExported = await window.crypto.subtle.exportKey('raw', keyPair.publicKey);
	const privateKeyExported = await window.crypto.subtle.exportKey('pkcs8', keyPair.privateKey);

	// Convert to base64
	const publicKeyBase64 = arrayBufferToBase64(publicKeyExported);
	const privateKeyBase64 = arrayBufferToBase64(privateKeyExported);

	return {
		publicKey: publicKeyBase64,
		privateKey: privateKeyBase64
	};
}

/**
 * Encrypt content using AES-GCM
 */
export async function encryptContent(
	content: string
): Promise<{
	encryptedData: string;
	iv: string;
	key: string;
}> {
	if (!window.crypto || !window.crypto.subtle) {
		throw new Error('Web Crypto API not available');
	}

	// Generate symmetric key
	const key = await window.crypto.subtle.generateKey(
		{
			name: 'AES-GCM',
			length: 256
		},
		true,
		['encrypt', 'decrypt']
	);

	// Export key as base64 for storage
	const keyExported = await window.crypto.subtle.exportKey('raw', key);
	const keyBase64 = arrayBufferToBase64(keyExported);

	// Generate initialization vector
	const iv = window.crypto.getRandomValues(new Uint8Array(12));

	// Encrypt content
	const encoder = new TextEncoder();
	const data = encoder.encode(content);

	const encryptedData = await window.crypto.subtle.encrypt(
		{
			name: 'AES-GCM',
			iv: iv
		},
		key,
		data
	);

	return {
		encryptedData: arrayBufferToBase64(encryptedData as ArrayBuffer),
		iv: arrayBufferToBase64(iv as any),
		key: keyBase64
	};
}

/**
 * Decrypt content using AES-GCM
 */
export async function decryptContent(
	encryptedDataBase64: string,
	ivBase64: string,
	keyBase64: string
): Promise<string> {
	if (!window.crypto || !window.crypto.subtle) {
		throw new Error('Web Crypto API not available');
	}

	// Import key
	const key = await window.crypto.subtle.importKey(
		'raw',
		base64ToArrayBuffer(keyBase64),
		{
			name: 'AES-GCM',
			length: 256
		},
		false,
		['encrypt', 'decrypt']
	);

	// Decode base64
	const encryptedData = base64ToArrayBuffer(encryptedDataBase64);
	const iv = base64ToArrayBuffer(ivBase64);

	// Decrypt content
	const decryptedData = await window.crypto.subtle.decrypt(
		{
			name: 'AES-GCM',
			iv: iv
		},
		key,
		encryptedData
	);

	// Decode and return
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
 * Store encryption keys in localStorage (for demo - in production, use secure storage)
 */
export const ENCRYPTION_STORAGE_KEY = 'wabi_encryption_keys';

export function saveUserKeys(userId: number, publicKey: string, privateKey: string): void {
	const keys = loadAllKeys();
	keys[userId.toString()] = { publicKey, privateKey };
	localStorage.setItem(ENCRYPTION_STORAGE_KEY, JSON.stringify(keys));
}

export function loadUserKeys(userId: number): { publicKey: string; privateKey: string } | null {
	const keys = loadAllKeys();
	return keys[userId.toString()] || null;
}

function loadAllKeys(): Record<string, { publicKey: string; privateKey: string }> {
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
	// Format: encryptedData::iv or just encrypted::iv
	if (!content) return false;
	const parts = content.split('::');
	return parts.length === 2 && /^[A-Za-z0-9+/]+=*$/.test(parts[0]);
}
