// Final candidate: headful Chromium against the actual release binary's embedded
// static assets, with a disposable WabiDB and UI login. No Vite or live accounts.
// Run after build:static AND cargo build --release -p wabi-server --features addons.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { chromium } from 'playwright';
import { runAdminPolishChecks } from './admin-polish-checks.mjs';

const scratch = await mkdtemp('/tmp/wabi-embedded-polish-');
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(fileURLToPath(new URL('../../target/release/wabi-server', import.meta.url)),
  ['--data-dir', `${scratch}/data`, '--host', '127.0.0.1', '--port', String(port)],
  { cwd: scratch, env: { PATH: process.env.PATH, WABI_LOG_DIR: `${scratch}/logs` }, stdio: ['ignore', 'pipe', 'pipe'] });
const log = createWriteStream(`${scratch}/server.log`, { mode: 0o600 });
server.stdout.pipe(log); server.stderr.pipe(log);
let browser, page;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Isolated server exited: ${scratch}`);
    try { ready = (await fetch(`${origin}/readyz`)).ok; } catch { /* startup */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'release candidate ready');
  const credentials = { username: 'embedded_fixture', password: 'Local-fixture-only-5179!' };
  assert.equal((await fetch(`${origin}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  })).status, 200);
  browser = await chromium.launch({ headless: false });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Configure only the server destination; authentication happens through the UI.
  await page.addInitScript(origin => sessionStorage.setItem('wabi.serverUrlSession', origin), origin);
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('input[autocomplete="username"]').fill(credentials.username);
  await page.locator('input[autocomplete="current-password"]').fill(credentials.password);
  await page.locator('.auth-form button[type="submit"]').click();
  await page.locator('.workspace-trigger').waitFor({ timeout: 60000 });
  const text = page.locator('.chat-container textarea[rows="1"]');
  await text.fill('Embedded candidate draft');
  for (const label of ['Notes', 'Planner', 'Files', 'Project', 'Whiteboard', 'Calls', 'Messages']) {
    await page.locator('.workspace-trigger').click();
    await page.getByRole('dialog', { name: 'Choose workspace' }).getByRole('button', { name: label, exact: true }).click();
    await page.waitForFunction(label => document.querySelector('.workspace-current')?.textContent === label, label);
  }
  assert.equal(await text.inputValue(), 'Embedded candidate draft', 'minified bundle preserves draft');
  await runAdminPolishChecks(page, scratch);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${scratch}/embedded-mobile.png` });
  assert.deepEqual(errors, [], 'no uncaught embedded app errors');
  console.log(JSON.stringify({ status: 'passed', evidence: scratch,
    checks: ['embedded static bundle', 'real UI login', 'workspace draft roundtrip', 'admin desktop/mobile', 'reaction preferences'] }));
} catch (error) {
  await page?.screenshot({ path: `${scratch}/failure.png` }).catch(() => {});
  console.error(`Evidence: ${scratch}`);
  throw error;
} finally {
  await browser?.close();
  if (server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
  log.end();
}
