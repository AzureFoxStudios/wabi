import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

test('message E2EE boundary preserves channel routing (isolated fixture)', () => {
	// Bun's mock.module cache is process-wide. Keep the production-store mocks
	// in a separate process so delivery and session tests use the real modules.
	const fixture = new URL('../../test/message-store-e2ee-boundary.fixture.test.ts', import.meta.url);
	const result = Bun.spawnSync([process.execPath, 'test', fileURLToPath(fixture)], {
		cwd: fileURLToPath(new URL('../../', import.meta.url)),
		stdout: 'pipe', stderr: 'pipe'
	});
	expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
}, 10_000);
