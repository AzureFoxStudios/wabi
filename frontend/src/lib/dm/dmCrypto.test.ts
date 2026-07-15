import { computePublicKey, x25519 } from './x25519'
import {
	generateX25519KeyPair, exportPublicKeyBase64, deriveSharedSecret,
	seal, open, sealBase64, openBase64, buildAad,
	deriveConversationKey, computeConversationId
} from './dmCrypto'

interface CryptoTestResult {
	name: string
	passed: boolean
	error?: string
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message)
}

export async function runDmCryptoTests(): Promise<CryptoTestResult[]> {
	const results: CryptoTestResult[] = []

	// --- x25519.ts: computePublicKey round-trip ---
	try {
		const priv = new Uint8Array(32)
		crypto.getRandomValues(priv)
		const pub = computePublicKey(priv)
		assert(pub.length === 32, 'public key should be 32 bytes')
		const rederived = computePublicKey(priv)
		assert(pub.every((b, i) => b === rederived[i]), 'public key should be deterministic')
		results.push({ name: 'x25519 computePublicKey deterministic', passed: true })
	} catch (error) {
		results.push({ name: 'x25519 computePublicKey deterministic', passed: false, error: String(error) })
	}

	// --- x25519.ts: DH consistency ---
	try {
		const alicePriv = new Uint8Array(32)
		const bobPriv = new Uint8Array(32)
		crypto.getRandomValues(alicePriv)
		crypto.getRandomValues(bobPriv)
		const alicePub = computePublicKey(alicePriv)
		const bobPub = computePublicKey(bobPriv)
		const aliceDH = x25519(alicePriv, bobPub)
		const bobDH = x25519(bobPriv, alicePub)
		assert(aliceDH.length === 32, 'DH result should be 32 bytes')
		assert(aliceDH.every((b, i) => b === bobDH[i]), 'DH shared secret should match')
		results.push({ name: 'x25519 DH consistency (Alice/Bob match)', passed: true })
	} catch (error) {
		results.push({ name: 'x25519 DH consistency (Alice/Bob match)', passed: false, error: String(error) })
	}

	// --- dmCrypto.ts: key generation ---
	try {
		const kp = await generateX25519KeyPair()
		assert(!!kp.publicKey, 'publicKey should be non-null')
		assert(!!kp.privateKey, 'privateKey should be non-null')
		const pubB64 = await exportPublicKeyBase64(kp.publicKey)
		assert(typeof pubB64 === 'string' && pubB64.length > 0, 'exported key should be base64')
		results.push({ name: 'generateX25519KeyPair produces valid keys', passed: true })
	} catch (error) {
		results.push({ name: 'generateX25519KeyPair produces valid keys', passed: false, error: String(error) })
	}

	// --- dmCrypto.ts: round-trip encrypt/decrypt ---
	try {
		const alice = await generateX25519KeyPair()
		const bob = await generateX25519KeyPair()
		const aliceSecret = await deriveSharedSecret(alice.privateKey, bob.publicKey)
		const bobSecret = await deriveSharedSecret(bob.privateKey, alice.publicKey)
		assert(aliceSecret.byteLength === 32, 'shared secret should be 32 bytes')

		const plaintext = 'Hello, Bob! This is a secret message.'
		const { ciphertext, nonce } = await seal(plaintext, aliceSecret)
		const decrypted = await open(ciphertext as any as any, nonce, bobSecret)
		assert(decrypted === plaintext, 'decrypted text should match original')
		results.push({ name: 'seal/open round-trip with derived secret', passed: true })
	} catch (error) {
		results.push({ name: 'seal/open round-trip with derived secret', passed: false, error: String(error) })
	}

	// --- dmCrypto.ts: base64 round-trip ---
	try {
		const alice = await generateX25519KeyPair()
		const bob = await generateX25519KeyPair()
		const aliceSecret = await deriveSharedSecret(alice.privateKey, bob.publicKey)
		const plaintext = 'Base64 test message 🎉'
		const { ct, nonce } = await sealBase64(plaintext, aliceSecret)
		const decrypted = await openBase64(ct, nonce, aliceSecret)
		assert(decrypted === plaintext, 'base64 round-trip should preserve text')
		results.push({ name: 'sealBase64/openBase64 round-trip', passed: true })
	} catch (error) {
		results.push({ name: 'sealBase64/openBase64 round-trip', passed: false, error: String(error) })
	}

	// --- dmCrypto.ts: AAD binding ---
	try {
		const kp = await generateX25519KeyPair()
		const secret = await deriveSharedSecret(kp.privateKey, kp.publicKey)
		const aadA = new TextEncoder().encode('conv1:userA:1')
		const aadB = new TextEncoder().encode('conv1:userA:2')
		const { ciphertext, nonce } = await seal('secret', secret, aadA)
		try {
			await open(ciphertext as any as any, nonce, secret, aadB)
			assert(false, 'should have thrown on wrong AAD')
		} catch {
			assert(true, 'wrong AAD correctly rejected')
		}
		results.push({ name: 'AAD binding: wrong AAD rejected', passed: true })
	} catch (error) {
		results.push({ name: 'AAD binding: wrong AAD rejected', passed: false, error: String(error) })
	}

	// --- dmCrypto.ts: tampered ciphertext rejected ---
	try {
		const kp = await generateX25519KeyPair()
		const secret = await deriveSharedSecret(kp.privateKey, kp.publicKey)
		const { ciphertext, nonce } = await seal('tamper test', secret)
		const tampered = new Uint8Array(ciphertext)
		tampered[0] ^= 0xff
		try {
			await open(tampered.buffer as any as any, nonce, secret)
			assert(false, 'should have thrown on tampered ciphertext')
		} catch {
			assert(true, 'tampered ciphertext correctly rejected')
		}
		results.push({ name: 'tampered ciphertext rejected', passed: true })
	} catch (error) {
		results.push({ name: 'tampered ciphertext rejected', passed: false, error: String(error) })
	}

	// --- dmCrypto.ts: buildAad format ---
	try {
		const aad = buildAad('conv123', 'user42', 7)
		const decoded = new TextDecoder().decode(aad)
		assert(decoded === 'conv123:user42:7', 'AAD format should match spec')
		results.push({ name: 'buildAad format correct', passed: true })
	} catch (error) {
		results.push({ name: 'buildAad format correct', passed: false, error: String(error) })
	}

	// --- dmCrypto.ts: deriveConversationKey with salt ---
	try {
		const alice = await generateX25519KeyPair()
		const bob = await generateX25519KeyPair()
		const salt = crypto.getRandomValues(new Uint8Array(16))
		const aliceKey = await deriveConversationKey(alice.privateKey, bob.publicKey, salt)
		const bobKey = await deriveConversationKey(bob.privateKey, alice.publicKey, salt)
		assert(aliceKey.byteLength === 32, 'derived key should be 32 bytes')
		assert(
			new Uint8Array(aliceKey).every((b, i) => b === new Uint8Array(bobKey)[i]),
			'both sides should derive same conversation key'
		)
		results.push({ name: 'deriveConversationKey consistent across both parties', passed: true })
	} catch (error) {
		results.push({ name: 'deriveConversationKey consistent across both parties', passed: false, error: String(error) })
	}

	// --- dmCrypto.ts: computeConversationId deterministic ---
	try {
		const alice = await generateX25519KeyPair()
		const bob = await generateX25519KeyPair()
		const aliceB64 = await exportPublicKeyBase64(alice.publicKey)
		const bobB64 = await exportPublicKeyBase64(bob.publicKey)
		const id1 = await computeConversationId(aliceB64, bobB64)
		const id2 = await computeConversationId(bobB64, aliceB64)
		assert(id1 === id2, 'conversation ID should be order-independent')
		assert(id1.length > 0, 'conversation ID should be non-empty')
		assert(/^[0-9a-f]+$/.test(id1), 'conversation ID should be hex')
		results.push({ name: 'computeConversationId order-independent', passed: true })
	} catch (error) {
		results.push({ name: 'computeConversationId order-independent', passed: false, error: String(error) })
	}

	return results
}
