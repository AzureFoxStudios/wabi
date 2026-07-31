/**
 * Compression + Encryption for Local-First Storage
 * 
 * Browser-compatible implementation of the compression-storage-smoke.mjs logic.
 * Uses Web Crypto API for encryption, pako for gzip compression.
 */

/** True in browser / Bun / Node with WebCrypto — no SvelteKit virtual import. */
const browser = typeof globalThis !== 'undefined' && typeof globalThis.crypto !== 'undefined' && !!globalThis.crypto.subtle;

const AT_REST_MAGIC = new Uint8Array([0x57, 0x41, 0x42, 0x49, 0x45, 0x4e, 0x43, 0x31]); // 'WABIENC1'
const COMP_MAGIC = new Uint8Array([0x57, 0x42, 0x5a, 0x31]); // 'WBZ1'
const COMP_CODEC_GZIP = 1;
const COMP_HEADER_SIZE = COMP_MAGIC.length + 1 + 4;

/** Legacy static salt (v1 metadata). Kept so existing ciphertext still opens. */
export const STORAGE_SALT_LEGACY_STRING = 'wabi-storage-salt-v1';
export const STORAGE_SALT_BYTES = 16;
export const STORAGE_PBKDF2_ITERATIONS = 100_000;

/** v1: salt was the static UTF-8 string. v2: random 16 bytes as base64. */
export type StorageKeyParamsV1 = { version: 1; salt: string };
export type StorageKeyParamsV2 = { version: 2; saltB64: string; iterations?: number };
export type StorageKeyParams = StorageKeyParamsV1 | StorageKeyParamsV2;

export function generateStorageSalt(byteLength = STORAGE_SALT_BYTES): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(byteLength));
}

export function saltBytesToB64(salt: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < salt.length; i++) binary += String.fromCharCode(salt[i]!);
	return btoa(binary);
}

export function saltB64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

function saltToBuffer(salt: string | Uint8Array): ArrayBuffer {
	if (typeof salt === 'string') {
		return new TextEncoder().encode(salt).buffer as ArrayBuffer;
	}
	const copy = new Uint8Array(salt.byteLength);
	copy.set(salt);
	return copy.buffer as ArrayBuffer;
}

/**
 * Resolve salt bytes from stored key params (v1 string or v2 base64).
 */
export function saltFromKeyParams(params: StorageKeyParams): string | Uint8Array {
	if (params.version === 2 && params.saltB64) {
		return saltB64ToBytes(params.saltB64);
	}
	if (params.version === 1 && typeof params.salt === 'string' && params.salt.length > 0) {
		return params.salt;
	}
	return STORAGE_SALT_LEGACY_STRING;
}

/**
 * Derive AES-GCM key from password + salt.
 * Omit salt (or pass legacy string) to open v1 ciphertext encrypted under the static salt.
 */
export async function deriveKey(
	password: string,
	salt: string | Uint8Array = STORAGE_SALT_LEGACY_STRING
): Promise<CryptoKey> {
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveKey']
	);

	return crypto.subtle.deriveKey(
		{
			name: 'PBKDF2',
			salt: saltToBuffer(salt),
			iterations: STORAGE_PBKDF2_ITERATIONS,
			hash: 'SHA-256'
		},
		keyMaterial,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

/**
 * Compress data using gzip (via pako or native CompressionStream)
 */
export async function compress(data: Uint8Array): Promise<{ data: Uint8Array; compressed: boolean }> {
	if (!browser) return { data, compressed: false };

	try {
		// Try native CompressionStream first (Chrome 80+, Firefox 119+)
		const compressed = await new Response(
			new Blob([data.buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream('gzip'))
		).arrayBuffer();

		const compressedBuffer = new Uint8Array(compressed);
		
		if (compressedBuffer.length >= data.length) {
			return { data, compressed: false };
		}

		// Add compression header
		const header = new Uint8Array(COMP_HEADER_SIZE);
		header.set(COMP_MAGIC, 0);
		header[COMP_MAGIC.length] = COMP_CODEC_GZIP;
		
		// Write original size as big-endian uint32
		const view = new DataView(header.buffer);
		view.setUint32(COMP_MAGIC.length + 1, data.length, false);

		const result = new Uint8Array(header.length + compressedBuffer.length);
		result.set(header, 0);
		result.set(compressedBuffer, header.length);

		return { data: result, compressed: true };
	} catch (err) {
		console.warn('[Storage] Compression failed, storing uncompressed:', err);
		return { data, compressed: false };
	}
}

/**
 * Decompress data
 */
export async function decompress(data: Uint8Array): Promise<{ data: Uint8Array; compressed: boolean }> {
	if (!browser) return { data, compressed: false };

	if (data.length < COMP_HEADER_SIZE) {
		return { data, compressed: false };
	}

	// Check magic bytes
	for (let i = 0; i < COMP_MAGIC.length; i++) {
		if (data[i] !== COMP_MAGIC[i]) {
			return { data, compressed: false };
		}
	}

	const codec = data[COMP_MAGIC.length];
	const originalSize = new DataView(data.buffer).getUint32(COMP_MAGIC.length + 1, false);

	if (codec !== COMP_CODEC_GZIP) {
		return { data, compressed: false };
	}

	try {
		const compressed = data.slice(COMP_HEADER_SIZE);
		const decompressed = await new Response(
			new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))
		).arrayBuffer();

		const result = new Uint8Array(decompressed);
		
		if (result.length !== originalSize) {
			throw new Error(`Decompressed size mismatch: expected ${originalSize}, got ${result.length}`);
		}

		return { data: result, compressed: true };
	} catch (err) {
		console.error('[Storage] Decompression failed:', err);
		return { data, compressed: false };
	}
}

/**
 * Encrypt data with AES-GCM
 */
export async function encrypt(data: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
	if (!browser) return data;

	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		data.buffer as ArrayBuffer
	);

	const cipherBuffer = new Uint8Array(ciphertext);
	
	// Format: magic | iv (12) | tag (16) | ciphertext
	const result = new Uint8Array(AT_REST_MAGIC.length + iv.length + 16 + cipherBuffer.length);
	result.set(AT_REST_MAGIC, 0);
	result.set(iv, AT_REST_MAGIC.length);
	result.set(cipherBuffer.slice(-16), AT_REST_MAGIC.length + iv.length); // tag is last 16 bytes
	result.set(cipherBuffer.slice(0, -16), AT_REST_MAGIC.length + iv.length + 16);

	return result;
}

/**
 * Decrypt data with AES-GCM
 */
export async function decrypt(data: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
	if (!browser) return data;

	if (data.length < AT_REST_MAGIC.length) {
		return data;
	}

	// Check magic bytes
	for (let i = 0; i < AT_REST_MAGIC.length; i++) {
		if (data[i] !== AT_REST_MAGIC[i]) {
			return data;
		}
	}

	const iv = data.slice(AT_REST_MAGIC.length, AT_REST_MAGIC.length + 12);
	const tag = data.slice(AT_REST_MAGIC.length + 12, AT_REST_MAGIC.length + 28);
	const ciphertext = data.slice(AT_REST_MAGIC.length + 28);

	// Reconstruct ciphertext with tag at end (Web Crypto format)
	const fullCiphertext = new Uint8Array(ciphertext.length + 16);
	fullCiphertext.set(ciphertext, 0);
	fullCiphertext.set(tag, ciphertext.length);

	try {
		const decrypted = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv },
			key,
			fullCiphertext
		);

		return new Uint8Array(decrypted);
	} catch (err) {
		console.error('[Storage] Decryption failed:', err);
		throw err;
	}
}

/**
 * Compress + Encrypt (for writing to storage)
 */
export async function compressAndEncrypt(
	data: Uint8Array,
	key?: CryptoKey
): Promise<Uint8Array> {
	const { data: compressed } = await compress(data);
	
	if (!key) {
		return compressed;
	}

	return encrypt(compressed, key);
}

/**
 * Decrypt + Decompress (for reading from storage)
 */
export async function decryptAndDecompress(
	data: Uint8Array,
	key?: CryptoKey
): Promise<Uint8Array> {
	let decrypted = data;
	
	if (key) {
		decrypted = await decrypt(data, key);
	}

	const { data: decompressed } = await decompress(decrypted);
	return decompressed;
}

/**
 * Encode string to Uint8Array
 */
export function encodeString(str: string): Uint8Array {
	return new TextEncoder().encode(str);
}

/**
 * Decode Uint8Array to string
 */
export function decodeString(data: Uint8Array): string {
	return new TextDecoder().decode(data);
}

/**
 * Convert object to compressed+encrypted Uint8Array
 */
export async function serializeObject(
	obj: any,
	key?: CryptoKey
): Promise<Uint8Array> {
	const json = JSON.stringify(obj);
	const data = encodeString(json);
	return compressAndEncrypt(data, key);
}

/**
 * Parse compressed+encrypted Uint8Array to object
 */
export async function parseObject(
	data: Uint8Array,
	key?: CryptoKey
): Promise<any> {
	const decrypted = await decryptAndDecompress(data, key);
	const json = decodeString(decrypted);
	return JSON.parse(json);
}
