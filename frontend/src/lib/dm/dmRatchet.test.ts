import { describe, expect, test } from 'bun:test'
import { generateX25519KeyPair } from './dmCrypto'
import { x3dhInitiate, x3dhRespond, encryptMessage, decryptMessage } from './dmRatchet'
import type { PreKeyBundle, RatchetSession } from './dmRatchet'

function bytesEqual(a: ArrayBuffer | Uint8Array, b: ArrayBuffer | Uint8Array): boolean {
	const aa = a instanceof Uint8Array ? a : new Uint8Array(a)
	const bb = b instanceof Uint8Array ? b : new Uint8Array(b)
	if (aa.length !== bb.length) return false
	return aa.every((v, i) => v === bb[i])
}

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

async function deriveChain(privateKey: CryptoKey, publicKey: CryptoKey): Promise<ArrayBuffer> {
	return crypto.subtle.deriveBits(
		{ name: 'X25519', public: publicKey },
		privateKey,
		256
	)
}

const x25519DeriveOk = await supportsX25519DeriveBits()

describe('dmRatchet', () => {
	// Entire suite needs WebCrypto X25519 deriveBits (unsupported in current Bun)
	test.skipIf(!x25519DeriveOk)('X3DH both sides derive the same root key', async () => {
		const aliceIdentity = await generateX25519KeyPair()
		const bobIdentity = await generateX25519KeyPair()
		const bobSignedPreKey = await generateX25519KeyPair()
		const bobOneTimePreKey = await generateX25519KeyPair()

		const aliceBundle: PreKeyBundle = {
			identityKey: bobIdentity.publicKey,
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
			aliceX3DH.theirEphemeralKey
		)

		expect(aliceX3DH.rootKey.byteLength).toBe(32)
		expect(bobRootKey.byteLength).toBe(32)
		// Finding 8: must compare equality, not just non-empty
		expect(bytesEqual(aliceX3DH.rootKey, bobRootKey)).toBe(true)
	})

	test.skipIf(!x25519DeriveOk)('ratchet encrypt/decrypt round-trip', async () => {
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
		expect(message.ciphertext.byteLength).toBeGreaterThan(0)
		expect(sessionAfter.Ns).toBe(1)

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
		expect(plaintext).toBe('Hello, ratchet!')
	})

	test.skipIf(!x25519DeriveOk)('ratchet forward secrecy: old key cannot decrypt new message', async () => {
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

		await decryptMessage(bobSession, msg1, aad)
		const { plaintext: pt2 } = await decryptMessage(bobSession, msg2, aad)
		expect(pt2).toBe('message two')

		const oldBobSession: RatchetSession = {
			conversationId: 'fs-test',
			rootKey,
			DHs: bobDH.privateKey,
			DHr: aliceDH.publicKey,
			receivingChain: bobReceivingChain,
			Ns: 0, Nr: 0, PN: 0,
			deviceId: 'bob', peerDeviceId: 'alice', peerPublicKeyB64: ''
		}
		await expect(decryptMessage(oldBobSession, msg2, aad)).rejects.toBeTruthy()
	})
})
