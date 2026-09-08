import { expect, test } from 'bun:test';

test('real refresh coordinator fences session ABA and shares only current work (isolated fixture)', () => {
	const fixture = new URL('../../test/api-auth-refresh.fixture.test.ts', import.meta.url);
	const result = Bun.spawnSync([process.execPath, 'test', fixture.pathname], {
		cwd: new URL('../../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe',
	});
	expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
}, 10_000);
