export interface DmKeyPair {
	publicKey: CryptoKey
	privateKey: CryptoKey
}

export interface SealedBox {
	ciphertext: ArrayBuffer
	nonce: Uint8Array
}

const NONCE_LENGTH = 12
const ENCRYPTION_ALGORITHM = 'AES-GCM' as const
const KEY_LENGTH = 256

// TS 5.7+ made Uint8Array generic (Uint8Array<ArrayBufferLike>); lib.dom crypto APIs
// require ArrayBuffer-backed views. Coerce soundly — real WebCrypto always returns
// ArrayBuffer-backed buffers at runtime.
function toAB(input: Uint8Array | ArrayBuffer): ArrayBuffer {
	if (input instanceof ArrayBuffer) return input;
	const u8 = input as Uint8Array;
	const copy = new Uint8Array(u8.byteLength);
	copy.set(u8);
	return copy.buffer as ArrayBuffer;
}

function ab2b64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf)
	let binary = ''
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i])
	}
	return btoa(binary)
}

function b642ab(b64: string): ArrayBuffer {
	const binary = atob(b64)
	const buf = new ArrayBuffer(binary.length)
	const bytes = new Uint8Array(buf)
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}
	return buf
}

function concat(a: ArrayBuffer, b: ArrayBuffer): ArrayBuffer {
	const result = new Uint8Array(a.byteLength + b.byteLength)
	result.set(new Uint8Array(a), 0)
	result.set(new Uint8Array(b), a.byteLength)
	return result.buffer
}

export async function generateX25519KeyPair(extractable: boolean = false): Promise<DmKeyPair> {
	const keyPair = await crypto.subtle.generateKey(
		{ name: 'X25519' },
		extractable,
		['deriveBits', 'deriveKey']
	) as CryptoKeyPair
	return { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey }
}

export async function exportPublicKeyBase64(key: CryptoKey): Promise<string> {
	const raw = await crypto.subtle.exportKey('raw', key)
	return ab2b64(raw)
}

export async function importPublicKeyFromBase64(b64: string): Promise<CryptoKey> {
	const raw = b642ab(b64)
	return crypto.subtle.importKey(
		'raw',
		raw,
		{ name: 'X25519' },
		false,
		[]
	)
}

export async function deriveSharedSecret(
	privateKey: CryptoKey,
	publicKey: CryptoKey
): Promise<ArrayBuffer> {
	return crypto.subtle.deriveBits(
		{ name: 'X25519', public: publicKey },
		privateKey,
		KEY_LENGTH
	)
}

async function sharedSecretToAesKey(sharedSecret: ArrayBuffer): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		sharedSecret,
		{ name: ENCRYPTION_ALGORITHM, length: KEY_LENGTH },
		false,
		['encrypt', 'decrypt']
	)
}

export async function seal(
	plaintext: string,
	sharedSecret: ArrayBuffer | Uint8Array,
	aad?: ArrayBuffer | Uint8Array
): Promise<SealedBox> {
	const key = await sharedSecretToAesKey(toAB(sharedSecret))
	const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH))
	const encoder = new TextEncoder()
	const data = encoder.encode(plaintext)
	const ciphertext = await crypto.subtle.encrypt(
		{ name: ENCRYPTION_ALGORITHM, iv: toAB(nonce), additionalData: aad ? toAB(aad) : undefined },
		key,
		toAB(data)
	)
	return { ciphertext: ciphertext as ArrayBuffer, nonce }
}

export async function open(
	ciphertext: ArrayBuffer | Uint8Array,
	nonce: Uint8Array | ArrayBuffer,
	sharedSecret: ArrayBuffer | Uint8Array,
	aad?: ArrayBuffer | Uint8Array
): Promise<string> {
	const ct = toAB(ciphertext)
	const n = toAB(nonce)
	const ss = toAB(sharedSecret)
	const aa = aad ? toAB(aad) : undefined
	const key = await sharedSecretToAesKey(ss)
	const decrypted = await crypto.subtle.decrypt(
		{ name: ENCRYPTION_ALGORITHM, iv: n, additionalData: aa },
		key,
		ct
	)
	return new TextDecoder().decode(decrypted)
}

export async function sealBase64(
	plaintext: string,
	sharedSecret: ArrayBuffer | Uint8Array,
	aad?: ArrayBuffer | Uint8Array
): Promise<{ ct: string; nonce: string }> {
	const box = await seal(plaintext, sharedSecret, aad)
	return { ct: ab2b64(box.ciphertext), nonce: ab2b64(toAB(box.nonce)) }
}

export async function openBase64(
	ctB64: string,
	nonceB64: string,
	sharedSecret: ArrayBuffer | Uint8Array,
	aad?: ArrayBuffer | Uint8Array
): Promise<string> {
	const ct = b642ab(ctB64)
	const nonce = new Uint8Array(b642ab(nonceB64))
	return open(ct, nonce, sharedSecret, aad)
}

export function buildAad(convId: string, senderId: string, messageNumber: number): ArrayBuffer {
	const encoder = new TextEncoder()
	return toAB(encoder.encode(`${convId}:${senderId}:${messageNumber}`))
}

export async function deriveConversationKey(
	myPrivateKey: CryptoKey,
	theirPublicKey: CryptoKey,
	salt?: Uint8Array
): Promise<ArrayBuffer> {
	const sharedSecret = await deriveSharedSecret(myPrivateKey, theirPublicKey)
	if (!salt) return sharedSecret
	const hkdfKey = await crypto.subtle.importKey(
		'raw',
		sharedSecret,
		'HKDF',
		false,
		['deriveBits']
	)
	return crypto.subtle.deriveBits(
		{ name: 'HKDF', salt: toAB(salt), hash: 'SHA-256', info: new TextEncoder().encode('wabi-dm-v1') },
		hkdfKey,
		KEY_LENGTH
	)
}

export async function computeConversationId(
	myPubKeyB64: string,
	theirPubKeyB64: string
): Promise<string> {
	const encoder = new TextEncoder()
	const sorted = [myPubKeyB64, theirPubKeyB64].sort()
	const combined = encoder.encode(sorted[0] + sorted[1])
	const hash = await crypto.subtle.digest('SHA-256', combined)
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
}

export function generateNonce(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(NONCE_LENGTH))
}

export function verifyNonceUniqueness(nonces: Set<string>, nonce: Uint8Array): boolean {
	const key = ab2b64(toAB(nonce))
	if (nonces.has(key)) return false
	nonces.add(key)
	return true
}
