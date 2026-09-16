#!/usr/bin/env node
/** Real-binary smoke test. It never substitutes a mock server for Wabi.
 * Usage: node scripts/desktop-host-smoke.mjs /absolute/path/to/wabi-server
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

if (!process.argv[2]) {
  console.error('A compiled wabi-server is required; this test cannot run against a fixture.');
  process.exit(2);
}
const binary = resolve(process.argv[2]);
const directory = await mkdtemp(join(tmpdir(), 'wabi-host-smoke-'));
let child;
let exit;
let lines;
try {
  child = spawn(binary, [
    '--host', '127.0.0.1', '--port', '0', '--data-dir', join(directory, 'data'),
    '--print-bound-address', '--shutdown-on-stdin-close'
  ], {
    cwd: directory,
    env: { ...process.env, WABI_SERVER_ROLE: 'authority', WABI_MESH_ENABLED: 'false', WABI_LOG_DIR: join(directory, 'logs') },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true
  });
  // Attach rejection handlers immediately, including before the first await.
  exit = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  exit.catch(() => {});
  lines = createInterface({ input: child.stdout });
  const announcement = new Promise((resolveAnnouncement, reject) => {
    lines.on('line', line => {
      let record;
      try { record = JSON.parse(line); } catch { return; }
      if (record.event === 'wabi-listener-bound') resolveAnnouncement(record);
    });
    exit.then(result => reject(new Error(`Server exited before launch completed: ${JSON.stringify(result)}`)), reject);
  });
  const record = await bounded(announcement, 60000, 'listener announcement');
  assert.equal(record.protocolVersion, 1);
  assert.equal(record.pid, child.pid);
  assert.match(record.address, /^127\.0\.0\.1:\d+$/);
  assert.notEqual(record.address, '127.0.0.1:0');
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, 'server exited while checking readiness');
    assert.equal(child.signalCode, null, 'server was terminated while checking readiness');
    try {
      const response = await fetch(`http://${record.address}/readyz`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
      const text = await response.text();
      if (response.ok) { ready = true; console.log(`Readiness: ${text}`); break; }
    } catch { /* It is not ready yet. Never turn timeout into success. */ }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  assert.ok(ready, 'application did not become ready');
  assert.equal(child.exitCode, null);
  child.stdin.end();
  const result = await bounded(exit, 30000, 'graceful shutdown after stdin EOF');
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  console.log('PASS: owned loopback listener, OS-assigned port, application readiness, stdin-EOF shutdown.');
  console.log('This does not certify desktop packaging, owner onboarding, invitations, media or backup recovery.');
} finally {
  lines?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.stdin?.destroy();
    // Test cleanup only: this exact child is ours. Never look up/kill a port.
    child.kill('SIGKILL');
    await bounded(exit.catch(() => {}), 5000, 'test cleanup').catch(() => {});
  }
  await rm(directory, { recursive: true, force: true });
}

function bounded(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
    })
  ]).finally(() => clearTimeout(timer));
}
