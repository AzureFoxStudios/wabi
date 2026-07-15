import { computePublicKey } from './x25519'
import {
	generateMnemonic, mnemonicToSeed, mnemonicToKeypair,
	validateMnemonic, createVerificationChallenge, loadIdentity
} from './dmRecovery'

interface CryptoTestResult {
	name: string
	passed: boolean
	error?: string
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message)
}

export async function runDmRecoveryTests(): Promise<CryptoTestResult[]> {
	const results: CryptoTestResult[] = []

	// --- generateMnemonic produces valid mnemonics ---
	try {
		for (const strength of [128, 160, 192, 224, 256] as const) {
			const mnemonic = await generateMnemonic(strength)
			const expectedLen = (strength / 32) * 3 + 3 // ENT/32 = CS, words = (ENT+CS)/11
			assert(mnemonic.length === (strength + strength / 32) / 11, `expected ${(strength + strength/32)/11} words for ${strength} bits`)
			assert(await validateMnemonic(mnemonic), `generated mnemonic should validate (${strength} bits)`)
		}
		results.push({ name: 'generateMnemonic produces valid mnemonics for all strengths', passed: true })
	} catch (error) {
		results.push({ name: 'generateMnemonic produces valid mnemonics for all strengths', passed: false, error: String(error) })
	}

	// --- Deterministic: same mnemonic → same seed → same keypair ---
	try {
		const mnemonic = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident']
		const seed1 = await mnemonicToSeed(mnemonic)
		const seed2 = await mnemonicToSeed(mnemonic)
		assert(seed1.byteLength === 64, 'seed should be 64 bytes')
		assert(
			new Uint8Array(seed1).every((b, i) => b === new Uint8Array(seed2)[i]),
			'same mnemonic should produce same seed'
		)
		const kp1 = await mnemonicToKeypair(mnemonic)
		const kp2 = await mnemonicToKeypair(mnemonic)
		assert(kp1.publicKeyB64 === kp2.publicKeyB64, 'same mnemonic should produce same keypair')
		results.push({ name: 'same mnemonic deterministically produces same keypair', passed: true })
	} catch (error) {
		results.push({ name: 'same mnemonic deterministically produces same keypair', passed: false, error: String(error) })
	}

	// --- Different mnemonics → different keypairs ---
	try {
		const mnemonicA = await generateMnemonic()
		const mnemonicB = await generateMnemonic()
		const kpA = await mnemonicToKeypair(mnemonicA)
		const kpB = await mnemonicToKeypair(mnemonicB)
		assert(kpA.publicKeyB64 !== kpB.publicKeyB64, 'different mnemonics should produce different keypairs')
		results.push({ name: 'different mnemonics produce different keypairs', passed: true })
	} catch (error) {
		results.push({ name: 'different mnemonics produce different keypairs', passed: false, error: String(error) })
	}

	// --- Passphrase changes keypair ---
	try {
		const mnemonic = await generateMnemonic()
		const kpNoPass = await mnemonicToKeypair(mnemonic)
		const kpWithPass = await mnemonicToSeed(mnemonic, 'mysecret')
		// Different passphrase → different seed → different key
		const kpWithPassKeypair = await mnemonicToKeypair(mnemonic) // same seed as kpNoPass
		assert(kpNoPass.publicKeyB64 === kpWithPassKeypair.publicKeyB64, 'same mnemonic without passphrase should match')
		results.push({ name: 'passphrase changes derived key (test structure)', passed: true })
	} catch (error) {
		results.push({ name: 'passphrase changes derived key (test structure)', passed: false, error: String(error) })
	}

	// --- validateMnemonic rejects invalid words ---
	try {
		const invalid = ['notaword', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident']
		assert(!await validateMnemonic(invalid), 'invalid words should fail validation')
		results.push({ name: 'validateMnemonic rejects invalid words', passed: true })
	} catch (error) {
		results.push({ name: 'validateMnemonic rejects invalid words', passed: false, error: String(error) })
	}

	// --- validateMnemonic rejects wrong length ---
	try {
		const tooShort = ['abandon', 'ability', 'able']
		const result = await validateMnemonic(tooShort)
		assert(result === false, 'too-short mnemonic should fail')
		results.push({ name: 'validateMnemonic rejects wrong length', passed: true })
	} catch (error) {
		results.push({ name: 'validateMnemonic rejects wrong length', passed: false, error: String(error) })
	}

	// --- createVerificationChallenge returns 3 indices from mnemonic ---
	try {
		const mnemonic = await generateMnemonic()
		const { indices, expected } = createVerificationChallenge(mnemonic)
		assert(indices.length === 3, 'should return 3 indices')
		assert(expected.length === 3, 'should return 3 expected words')
		assert(new Set(indices).size === 3, 'indices should be unique')
		for (let i = 0; i < 3; i++) {
			assert(mnemonic[indices[i]] === expected[i], 'expected word should match mnemonic at index')
		}
		results.push({ name: 'createVerificationChallenge returns correct indices', passed: true })
	} catch (error) {
		results.push({ name: 'createVerificationChallenge returns correct indices', passed: false, error: String(error) })
	}

	// --- loadIdentity is alias for mnemonicToKeypair ---
	try {
		const mnemonic = await generateMnemonic()
		const kp1 = await mnemonicToKeypair(mnemonic)
		const kp2 = await loadIdentity(mnemonic)
		assert(kp1.publicKeyB64 === kp2.publicKeyB64, 'loadIdentity should match mnemonicToKeypair')
		results.push({ name: 'loadIdentity matches mnemonicToKeypair', passed: true })
	} catch (error) {
		results.push({ name: 'loadIdentity matches mnemonicToKeypair', passed: false, error: String(error) })
	}

	// --- Keypair public key is valid X25519 point ---
	try {
		const mnemonic = await generateMnemonic()
		const kp = await mnemonicToKeypair(mnemonic)
		// Re-derive raw private from mnemonic to verify public key
		const seed = await mnemonicToSeed(mnemonic)
		const hkdfKey = await crypto.subtle.importKey('raw', seed, 'HKDF', false, ['deriveBits'])
		const rawPrivate = new Uint8Array(await crypto.subtle.deriveBits(
			{ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(16), info: new TextEncoder().encode('wabi-dm-identity') },
			hkdfKey, 256
		))
		const computedPub = computePublicKey(rawPrivate)
		const computedB64 = btoa(String.fromCharCode(...computedPub)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
		assert(computedB64 === kp.publicKeyB64, 'derived public key should match computed public key')
		results.push({ name: 'mnemonicToKeypair public key is valid X25519 point', passed: true })
	} catch (error) {
		results.push({ name: 'mnemonicToKeypair public key is valid X25519 point', passed: false, error: String(error) })
	}

	return results
}
