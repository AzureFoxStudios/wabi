import { expect, test } from 'bun:test';

test('production TURN configuration and auth-refresh wiring (isolated browser fixture)', () => {
	const result = Bun.spawnSync([process.execPath, 'test', 'test/turn-config.fixture.test.ts'], {
		cwd: new URL('../..', import.meta.url).pathname,
		stdout: 'pipe', stderr: 'pipe',
	});
	if (result.exitCode !== 0) console.error(new TextDecoder().decode(result.stdout), new TextDecoder().decode(result.stderr));
	expect(result.exitCode).toBe(0);
});
