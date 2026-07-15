import { runDmCryptoTests } from './dmCrypto.test'
import { runDmRecoveryTests } from './dmRecovery.test'
import { runDmRatchetTests } from './dmRatchet.test'

interface CryptoTestResult {
	name: string
	passed: boolean
	error?: string
}

async function main() {
	const suites: { name: string; run: () => Promise<CryptoTestResult[]> }[] = [
		{ name: 'dmCrypto.ts', run: runDmCryptoTests },
		{ name: 'dmRecovery.ts', run: runDmRecoveryTests },
		{ name: 'dmRatchet.ts', run: runDmRatchetTests },
	]

	let totalPassed = 0
	let totalFailed = 0

	for (const suite of suites) {
		console.log(`\n=== ${suite.name} ===`)
		const results = await suite.run()
		for (const r of results) {
			const status = r.passed ? 'PASS' : 'FAIL'
			console.log(`  ${status}: ${r.name}`)
			if (r.passed) totalPassed++
			else {
				totalFailed++
				console.log(`        ${r.error}`)
			}
		}
	}

	console.log(`\n=== Results: ${totalPassed} passed, ${totalFailed} failed ===`)
	process.exit(totalFailed > 0 ? 1 : 0)
}

main()
