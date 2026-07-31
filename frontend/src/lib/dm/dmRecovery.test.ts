import { describe, expect, test } from 'bun:test'
import { computePublicKey } from './x25519'
import {
	generateMnemonic, mnemonicToSeed, mnemonicToKeypair,
	validateMnemonic, createVerificationChallenge, loadIdentity
} from './dmRecovery'

function bytesEqual(a: ArrayBuffer | Uint8Array, b: ArrayBuffer | Uint8Array): boolean {
	const aa = a instanceof Uint8Array ? a : new Uint8Array(a)
	const bb = b instanceof Uint8Array ? b : new Uint8Array(b)
	if (aa.length !== bb.length) return false
	return aa.every((v, i) => v === bb[i])
}

describe('dmRecovery', () => {
	test('generateMnemonic produces valid mnemonics for all strengths', async () => {
		for (const strength of [128, 160, 192, 224, 256] as const) {
			const mnemonic = await generateMnemonic(strength)
			const expectedWords = (strength + strength / 32) / 11
			expect(mnemonic.length).toBe(expectedWords)
			expect(await validateMnemonic(mnemonic)).toBe(true)
		}
	})

	test('same mnemonic deterministically produces same keypair', async () => {
		const mnemonic = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident']
		const seed1 = await mnemonicToSeed(mnemonic)
		const seed2 = await mnemonicToSeed(mnemonic)
		expect(seed1.byteLength).toBe(64)
		expect(bytesEqual(seed1, seed2)).toBe(true)
		const kp1 = await mnemonicToKeypair(mnemonic)
		const kp2 = await mnemonicToKeypair(mnemonic)
		expect(kp1.publicKeyB64).toBe(kp2.publicKeyB64)
	})

	test('different mnemonics produce different keypairs', async () => {
		const mnemonicA = await generateMnemonic()
		const mnemonicB = await generateMnemonic()
		const kpA = await mnemonicToKeypair(mnemonicA)
		const kpB = await mnemonicToKeypair(mnemonicB)
		expect(kpA.publicKeyB64).not.toBe(kpB.publicKeyB64)
	})

	test('passphrase changes derived seed', async () => {
		// mnemonicToKeypair always uses empty passphrase; compare seeds directly.
		const mnemonic = await generateMnemonic()
		const seedNoPass = await mnemonicToSeed(mnemonic)
		const seedWithPass = await mnemonicToSeed(mnemonic, 'mysecret')
		const seedWithOther = await mnemonicToSeed(mnemonic, 'other-secret')
		expect(seedNoPass.byteLength).toBe(64)
		expect(seedWithPass.byteLength).toBe(64)
		expect(bytesEqual(seedNoPass, seedWithPass)).toBe(false)
		expect(bytesEqual(seedWithPass, seedWithOther)).toBe(false)
		// Same passphrase is stable
		const seedWithPass2 = await mnemonicToSeed(mnemonic, 'mysecret')
		expect(bytesEqual(seedWithPass, seedWithPass2)).toBe(true)
	})

	test('validateMnemonic rejects invalid words', async () => {
		const invalid = ['notaword', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident']
		expect(await validateMnemonic(invalid)).toBe(false)
	})

	test('validateMnemonic rejects wrong length', async () => {
		const tooShort = ['abandon', 'ability', 'able']
		expect(await validateMnemonic(tooShort)).toBe(false)
	})

	test('createVerificationChallenge returns correct indices', async () => {
		const mnemonic = await generateMnemonic()
		const { indices, expected } = createVerificationChallenge(mnemonic)
		expect(indices.length).toBe(3)
		expect(expected.length).toBe(3)
		expect(new Set(indices).size).toBe(3)
		for (let i = 0; i < 3; i++) {
			expect(mnemonic[indices[i]]).toBe(expected[i])
		}
	})

	test('loadIdentity matches mnemonicToKeypair', async () => {
		const mnemonic = await generateMnemonic()
		const kp1 = await mnemonicToKeypair(mnemonic)
		const kp2 = await loadIdentity(mnemonic)
		expect(kp1.publicKeyB64).toBe(kp2.publicKeyB64)
	})

	test('mnemonicToKeypair public key is valid X25519 point', async () => {
		const mnemonic = await generateMnemonic()
		const kp = await mnemonicToKeypair(mnemonic)
		const seed = await mnemonicToSeed(mnemonic)
		const hkdfKey = await crypto.subtle.importKey('raw', seed, 'HKDF', false, ['deriveBits'])
		const rawPrivate = new Uint8Array(await crypto.subtle.deriveBits(
			{ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(16), info: new TextEncoder().encode('wabi-dm-identity') },
			hkdfKey, 256
		))
		const computedPub = computePublicKey(rawPrivate)
		const computedB64 = btoa(String.fromCharCode(...computedPub)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
		expect(computedB64).toBe(kp.publicKeyB64)
	})
})
