import { expect, test } from 'bun:test';

test('payment access store honors server decisions and session ownership (isolated fixture)', () => {
  // Bun's mock.module cache is process-wide. The production-store fixture
  // controls auth/API timing without poisoning real modules in other suites.
  const fixture = new URL('../../../test/payment-access-store.fixture.test.ts', import.meta.url);
  const result = Bun.spawnSync([process.execPath, 'test', fixture.pathname], {
    cwd: new URL('../../../', import.meta.url).pathname,
    stdout: 'pipe', stderr: 'pipe'
  });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
}, 10_000);
