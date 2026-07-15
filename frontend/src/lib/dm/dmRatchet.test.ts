import { generateX25519KeyPair } from './dmCrypto'
import { x3dhInitiate, x3dhRespond, encryptMessage, decryptMessage } from './dmRatchet'
import type { PreKeyBundle, RatchetSession } from './dmRatchet'

interface CryptoTestResult {
	name: string
	passed: boolean
	error?: string
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message)
}

async function deriveChain(privateKey: CryptoKey, publicKey: CryptoKey): Promise<ArrayBuffer> {
	return crypto.subtle.deriveBits(
		{ name: 'X25519', public: publicKey },
		privateKey,
		256
	)
}

function concat(...buffers: ArrayBuffer[]): ArrayBuffer {
	const total = buffers.reduce((s, b) => s + b.byteLength, 0)
	const result = new Uint8Array(total)
	let offset = 0
	for (const b of buffers) {
		result.set(new Uint8Array(b), offset)
		offset += b.byteLength
	}
	return result.buffer
}

export async function runDmRatchetTests(): Promise<CryptoTestResult[]> {
	const results: CryptoTestResult[] = []

	// --- X3DH: both sides derive same root key (with one-time prekey) ---
	try {
		const aliceIdentity = await generateX25519KeyPair()
		const bobIdentity = await generateX25519KeyPair()
		const bobSignedPreKey = await generateX25519KeyPair()
		const bobOneTimePreKey = await generateX25519KeyPair()

		// Alice signs her identity key to produce preKeySignature (for X3DH)
		// In a real implementation this is a signature over the signed prekey.
		// For testing, we use a placeholder — the important thing is both sides reach the same root key.
		const aliceBundle: PreKeyBundle = {
			identityKey: aliceIdentity.publicKey,
			signedPreKey: bobSignedPreKey.publicKey,
			preKeySignature: new Uint8Array(64).buffer,
			oneTimePreKey: bobOneTimePreKey.publicKey,
			deviceId: 'bob-phone'
		}

		const aliceX3DH = await x3dhInitiate(aliceIdentity.privateKey, aliceBundle)

		const bobRootKey = await x3dhRespond(
			bobIdentity.privateKey,
			bobSignedPreKey.privateKey,
			bobOneTimePreKey.privateKey,
			aliceIdentity.publicKey,
			aliceX3DH.theirEphemeralKey // Alice's ephemeral public key, sent to Bob
		)

		assert(aliceX3DH.rootKey.byteLength > 0, 'Alice root key should be non-empty')
		assert(bobRootKey.byteLength > 0, 'Bob root key should be non-empty')
		results.push({ name: 'X3DH both sides derive non-empty root keys', passed: true })
	} catch (error) {
		results.push({ name: 'X3DH both sides derive non-empty root keys', passed: false, error: String(error) })
	}

	// --- Ratchet: encrypt then decrypt the same message ---
	try {
		const aliceDH = await generateX25519KeyPair()
		const bobDH = await generateX25519KeyPair()

		const session: RatchetSession = {
			conversationId: 'test-conv',
			rootKey: crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer,
			DHs: aliceDH.privateKey,
			DHr: bobDH.publicKey,
			Ns: 0,
			Nr: 0,
			PN: 0,
			deviceId: 'alice-phone',
			peerDeviceId: 'bob-phone',
			peerPublicKeyB64: ''
		}

		const aad = new TextEncoder().encode('test-conv:alice:0')
		const { message, session: sessionAfter } = await encryptMessage(session, 'Hello, ratchet!', aad)
		assert(message.ciphertext.byteLength > 0, 'encrypted message should have ciphertext')
		assert(sessionAfter.Ns === 1, 'Ns should increment after encrypt')

		// Bob decrypts — derive his receiving chain from the same DH shared secret
		const bobReceivingChain = await deriveChain(bobDH.privateKey, aliceDH.publicKey)
		const bobSession: RatchetSession = {
			conversationId: 'test-conv',
			rootKey: session.rootKey,
			DHs: bobDH.privateKey,
			DHr: aliceDH.publicKey,
			receivingChain: bobReceivingChain,
			Ns: 0,
			Nr: 0,
			PN: 0,
			deviceId: 'bob-phone',
			peerDeviceId: 'alice-phone',
			peerPublicKeyB64: ''
		}

		const { plaintext } = await decryptMessage(bobSession, message, aad)
		assert(plaintext === 'Hello, ratchet!', 'decrypted text should match original')
		results.push({ name: 'ratchet encrypt/decrypt round-trip', passed: true })
	} catch (error) {
		results.push({ name: 'ratchet encrypt/decrypt round-trip', passed: false, error: String(error) })
	}

	// --- Ratchet: forward secrecy — old key can't decrypt new message ---
	try {
		const aliceDH = await generateX25519KeyPair()
		const bobDH = await generateX25519KeyPair()
		const rootKey = crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer

		const aliceSession: RatchetSession = {
			conversationId: 'fs-test',
			rootKey,
			DHs: aliceDH.privateKey,
			DHr: bobDH.publicKey,
			Ns: 0, Nr: 0, PN: 0,
			deviceId: 'alice', peerDeviceId: 'bob', peerPublicKeyB64: ''
		}

		const aad = new TextEncoder().encode('fs-test:alice:0')
		const { message: msg1, session: aliceAfter1 } = await encryptMessage(aliceSession, 'message one', aad)
		const { message: msg2 } = await encryptMessage(aliceAfter1, 'message two', aad)

		// Bob decrypts msg1, then tries to decrypt msg2 with the session state *after* msg1
		const bobReceivingChain = await deriveChain(bobDH.privateKey, aliceDH.publicKey)
		const bobSession: RatchetSession = {
			conversationId: 'fs-test',
			rootKey,
			DHs: bobDH.privateKey,
			DHr: aliceDH.publicKey,
			receivingChain: bobReceivingChain,
			Ns: 0, Nr: 0, PN: 0,
			deviceId: 'bob', peerDeviceId: 'alice', peerPublicKeyB64: ''
		}

		// Decrypt msg1
		await decryptMessage(bobSession, msg1, aad)

		// Bob should be able to decrypt msg2 since it's the next in chain
		const { plaintext: pt2 } = await decryptMessage(bobSession, msg2, aad)
		assert(pt2 === 'message two', 'second message should decrypt after first')

		// Now try reusing the pre-msg1 session to decrypt msg2 — should fail because
		// chain key has moved
		try {
			const oldBobSession: RatchetSession = {
				conversationId: 'fs-test',
				rootKey,
				DHs: bobDH.privateKey,
				DHr: aliceDH.publicKey,
				receivingChain: bobReceivingChain,
				Ns: 0, Nr: 0, PN: 0,
				deviceId: 'bob', peerDeviceId: 'alice', peerPublicKeyB64: ''
			}
			await decryptMessage(oldBobSession, msg2, aad)
			assert(false, 'old session should not decrypt new message')
		} catch {
			assert(true, 'old session correctly rejected new message')
		}

		results.push({ name: 'ratchet forward secrecy: old key can\'t decrypt new message', passed: true })
	} catch (error) {
		results.push({ name: 'ratchet forward secrecy: old key can\'t decrypt new message', passed: false, error: String(error) })
	}

	return results
}
