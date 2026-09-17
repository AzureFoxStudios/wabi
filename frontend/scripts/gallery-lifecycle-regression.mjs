// Gallery lifecycle regression entry: runs the mock-heavy GF02-GF05 suite in
// its own `bun test` process. Bun's mock.module registry is process-wide, so
// this file must never be merged into a multi-file in-process run — the
// subprocess boundary is the isolation. The test file itself self-isolates
// the same way; this script is the canonical CI/dev entry with exit
// propagation.
//
// Usage (frontend dir, pinned toolchain):
//   npm exec --yes --package=bun@1.3.14 -- bun run scripts/gallery-lifecycle-regression.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const frontendDir = fileURLToPath(new URL('../', import.meta.url));
const bun = process.env.WABI_BUN ?? 'bun';
const target = process.argv[2] ?? 'src/lib/galleryLifecycle.test.ts';

const result = spawnSync(bun, ['test', target], {
	cwd: frontendDir,
	env: process.env,
	stdio: 'inherit'
});

if (result.error) {
	console.error(`[gallery-lifecycle-regression] failed to spawn ${bun}: ${result.error.message}`);
	process.exit(1);
}
process.exit(result.status ?? 1);
