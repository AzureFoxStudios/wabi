import { expect, test } from 'bun:test';

test('Admin policy deadlines cover response bodies (isolated fixture)', () => {
	const fixture = new URL('../../test/admin-policy-deadline.fixture.test.ts', import.meta.url);
	const result = Bun.spawnSync([process.execPath, 'test', fixture.pathname], {
		cwd: new URL('../../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe'
	});
	expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
}, 5000);
