// Gallery feedback regression entry: runs the GF06 session suite in its own
// `bun test` process. The suite itself is mock-free (dependency-injected
// harness against the real galleryFeedbackStore), but the subprocess
// boundary keeps it immune to any other suite's process-wide mock.module
// registry. Exit code propagates; output streams through unchanged.
//
// Usage (frontend dir, pinned toolchain):
//   npm exec --yes --package=bun@1.3.14 -- bun run scripts/gallery-feedback-regression.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const frontendDir = fileURLToPath(new URL('../', import.meta.url));
const bun = process.env.WABI_BUN ?? 'bun';
const target = process.argv[2] ?? 'src/lib/galleryFeedbackSession.test.ts';

const result = spawnSync(bun, ['test', target], {
	cwd: frontendDir,
	env: process.env,
	stdio: 'inherit'
});

if (result.error) {
	console.error(`[gallery-feedback-regression] failed to spawn ${bun}: ${result.error.message}`);
	process.exit(1);
}
process.exit(result.status ?? 1);
