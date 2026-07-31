/**
 * Manual CLI entry for crypto suites.
 * Prefer `bun test src/lib/dm src/lib/docking` — this remains for ad-hoc runs.
 *
 * Usage: bun run src/lib/dm/run-crypto-tests.ts
 */
import { $ } from 'bun'

const result = await $`bun test src/lib/dm src/lib/docking/layoutSchema.test.ts`.nothrow()
process.exit(result.exitCode)
