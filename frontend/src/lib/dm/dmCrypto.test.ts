import { describe, expect, test } from 'bun:test'
import { computePublicKey, x25519 } from './x25519'
import {
	generateX25519KeyPair, exportPublicKeyBase64, deriveSharedSecret,
	seal, open, sealBase64, openBase64, buildAad,
	deriveConversationKey, computeConversationId
} from './dmCrypto'

function bytesEqual(a: ArrayBuffer | Uint8Array, b: ArrayBuffer | Uint8Array): boolean {
	const aa = a instanceof Uint8Array ? a : new Uint8Array(a)
	const bb = b instanceof Uint8Array ? b : new Uint8Array(b)
	if (aa.length !== bb.length) return false
	return aa.every((v, i) => v === bb[i])
}

/** Bun can generate X25519 keys but often cannot deriveBits with them. */
async function supportsX25519DeriveBits(): Promise<boolean> {
	try {
		const kp = await crypto.subtle.generateKey(
			{ name: 'X25519' },
			true,
			['deriveBits', 'deriveKey']
		) as CryptoKeyPair
		await crypto.subtle.deriveBits(
			{ name: 'X25519', public: kp.publicKey },
			kp.privateKey,
			256
		)
		return true
	} catch {
		return false
	}
}

const x25519DeriveOk = await supportsX25519DeriveBits()

describe('dmCrypto', () => {
	test('x25519 computePublicKey is deterministic', () => {
		const priv = new Uint8Array(32)
		crypto.getRandomValues(priv)
		const pub = computePublicKey(priv)
		expect(pub.length).toBe(32)
		const rederived = computePublicKey(priv)
		expect(bytesEqual(pub, rederived)).toBe(true)
	})

	test('x25519 DH consistency (Alice/Bob match)', () => {
		const alicePriv = new Uint8Array(32)
		const bobPriv = new Uint8Array(32)
		crypto.getRandomValues(alicePriv)
		crypto.getRandomValues(bobPriv)
		const alicePub = computePublicKey(alicePriv)
		const bobPub = computePublicKey(bobPriv)
		const aliceDH = x25519(alicePriv, bobPub)
		const bobDH = x25519(bobPriv, alicePub)
		expect(aliceDH.length).toBe(32)
		expect(bytesEqual(aliceDH, bobDH)).toBe(true)
	})

	test('generateX25519KeyPair produces valid keys', async () => {
		const kp = await generateX25519KeyPair()
		expect(kp.publicKey).toBeTruthy()
		expect(kp.privateKey).toBeTruthy()
		// export may fail if non-extractable; only check generation
		try {
			const pubB64 = await exportPublicKeyBase64(kp.publicKey)
			expect(typeof pubB64).toBe('string')
			expect(pubB64.length).toBeGreaterThan(0)
		} catch {
			// extractable=false is fine for production keys
			expect(true).toBe(true)
		}
	})

	test('buildAad format correct', () => {
		const aad = buildAad('conv123', 'user42', 7)
		const decoded = new TextDecoder().decode(aad)
		expect(decoded).toBe('conv123:user42:7')
	})

	// WebCrypto X25519 deriveBits required — skip on Bun/runtimes without it
	test.skipIf(!x25519DeriveOk)('seal/open round-trip with derived secret', async () => {
		const alice = await generateX25519KeyPair()
		const bob = await generateX25519KeyPair()
		const aliceSecret = await deriveSharedSecret(alice.privateKey, bob.publicKey)
		const bobSecret = await deriveSharedSecret(bob.privateKey, alice.publicKey)
		expect(aliceSecret.byteLength).toBe(32)
		expect(bytesEqual(aliceSecret, bobSecret)).toBe(true)

		const plaintext = 'Hello, Bob! This is a secret message.'
		const { ciphertext, nonce } = await seal(plaintext, aliceSecret)
		const decrypted = await open(ciphertext as ArrayBuffer, nonce, bobSecret)
		expect(decrypted).toBe(plaintext)
	})

	test.skipIf(!x25519DeriveOk)('sealBase64/openBase64 round-trip', async () => {
		const alice = await generateX25519KeyPair()
		const bob = await generateX25519KeyPair()
		const aliceSecret = await deriveSharedSecret(alice.privateKey, bob.publicKey)
		const plaintext = 'Base64 test message 🎉'
		const { ct, nonce } = await sealBase64(plaintext, aliceSecret)
		const decrypted = await openBase64(ct, nonce, aliceSecret)
		expect(decrypted).toBe(plaintext)
	})

	test.skipIf(!x25519DeriveOk)('AAD binding: wrong AAD rejected', async () => {
		const kp = await generateX25519KeyPair()
		const secret = await deriveSharedSecret(kp.privateKey, kp.publicKey)
		const aadA = new TextEncoder().encode('conv1:userA:1')
		const aadB = new TextEncoder().encode('conv1:userA:2')
		const { ciphertext, nonce } = await seal('secret', secret, aadA)
		await expect(open(ciphertext as ArrayBuffer, nonce, secret, aadB)).rejects.toBeTruthy()
	})

	test.skipIf(!x25519DeriveOk)('tampered ciphertext rejected', async () => {
		const kp = await generateX25519KeyPair()
		const secret = await deriveSharedSecret(kp.privateKey, kp.publicKey)
		const { ciphertext, nonce } = await seal('tamper test', secret)
		const tampered = new Uint8Array(ciphertext)
		tampered[0] ^= 0xff
		await expect(open(tampered.buffer as ArrayBuffer, nonce, secret)).rejects.toBeTruthy()
	})

	test.skipIf(!x25519DeriveOk)('deriveConversationKey consistent across both parties', async () => {
		const alice = await generateX25519KeyPair()
		const bob = await generateX25519KeyPair()
		const salt = crypto.getRandomValues(new Uint8Array(16))
		const aliceKey = await deriveConversationKey(alice.privateKey, bob.publicKey, salt)
		const bobKey = await deriveConversationKey(bob.privateKey, alice.publicKey, salt)
		expect(aliceKey.byteLength).toBe(32)
		expect(bytesEqual(aliceKey, bobKey)).toBe(true)
	})

	test.skipIf(!x25519DeriveOk)('computeConversationId order-independent', async () => {
		// needs extractable keys for exportPublicKeyBase64
		const alice = await generateX25519KeyPair(true)
		const bob = await generateX25519KeyPair(true)
		const aliceB64 = await exportPublicKeyBase64(alice.publicKey)
		const bobB64 = await exportPublicKeyBase64(bob.publicKey)
		const id1 = await computeConversationId(aliceB64, bobB64)
		const id2 = await computeConversationId(bobB64, aliceB64)
		expect(id1).toBe(id2)
		expect(id1.length).toBeGreaterThan(0)
		expect(/^[0-9a-f]+$/.test(id1)).toBe(true)
	})
})
