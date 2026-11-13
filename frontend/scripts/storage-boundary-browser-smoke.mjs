// Isolated headful UI + real IndexedDB, under the actual desktop CSP.
// No live accounts, real native commands, or user databases are touched.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const csp = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8')).app.security.csp;
const server = await createServer({
  root, configFile: false, resolve: { alias: { $lib: root + 'src/lib' } },
  server: { host: '127.0.0.1', port: 0, open: false, fs: { allow: [root] } },
  plugins: [svelte({ configFile: false }), {
    name: 'storage-boundary-browser', enforce: 'pre',
    resolveId(id) { if (id === '$app/environment') return '\0storage-environment'; },
    load(id) { if (id === '\0storage-environment') return 'export const browser=true; export const dev=true; export const building=false;'; },
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/__storage_boundary') return next();
        res.setHeader('Content-Type', 'text/html'); res.setHeader('Content-Security-Policy', csp);
        res.end('<!doctype html><title>Wabi storage boundary</title><div id="harness"></div><script type="module" src="/test/storage-boundary-browser-harness.ts"></script>');
      });
    }
  }]
});
let browser;
try {
  await server.listen(); browser = await chromium.launch({ headless: false });
  for (const native of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    await page.route('**/api/**', route => new URL(route.request().url()).pathname.startsWith('/api/')
      ? route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }) : route.continue());
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__storage_boundary${native ? '?tauri' : ''}`);
    await page.waitForFunction(() => window.__storageBoundary || window.__storageError);
    assert.equal(await page.evaluate(() => window.__storageError), undefined);
    // Before-fix proof: the real Settings export still returns a removed group's
    // unowned archive. This assertion fails on the original implementation.
    const legacyExport = page.locator('.archives-section .section-header button');
    // 361437d4 replaced the "Local chat archives are unavailable" notice with the server-history
    // explanation, and wave 1c (b119b9a9) restyled the section. The boundary is the same: no
    // archive rows, no export control, and the explanation that no local copy is loaded.
    const historyExplanation = page.getByText('This version does not keep a separate offline copy on your device.', { exact: false });
    await page.waitForFunction(() => document.body.textContent.includes('does not keep a separate offline copy') || document.querySelector('.archive-item'));
    let exported = [];
    if (await legacyExport.count()) {
      await legacyExport.click();
      await page.waitForFunction(() => window.__storageBoundary.exports().length > 0);
      exported = await page.evaluate(() => window.__storageBoundary.exports());
    }
    assert.ok(!exported.some(value => value.includes('UNOWNED-PRIVATE-ARCHIVE')), 'removed group content must not be exported from an unowned legacy archive');
    await historyExplanation.waitFor();
    assert.equal(await page.locator('.archive-item').count(), 0, 'no local archive rows are listed');
    assert.equal(await legacyExport.count(), 0);
    assert.equal(await page.getByRole('checkbox').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__storageBoundary.settingsCanary()), { existing: [5, 15], saved: [30] });
    assert.deepEqual(await page.evaluate(() => window.__storageBoundary.settingsAbort()), { rejected: true, persisted: undefined });
    await page.evaluate(() => window.__storageBoundary.prepareQueue());
    // Wave 1c (b119b9a9): "Refresh queue" is now "Check again" and the "pending: n / failed: n"
    // counters became one status sentence that names failures first.
    const queueStatus = page.locator('#storage-offline-title ~ .w-srows [role="status"]');
    await page.getByRole('button', { name: 'Check again', exact: true }).click();
    await queueStatus.filter({ hasText: "2 actions didn't reach the server." }).waitFor();
    await page.getByRole('button', { name: 'Retry failed actions', exact: true }).click();
    await queueStatus.filter({ hasText: 'marked for retry' }).waitFor();
    // Only the retryable action left the failed state; the uncertain one stays failed.
    await queueStatus.filter({ hasText: "1 action didn't reach the server." }).waitFor();
    const queue = await page.evaluate(() => window.__storageBoundary.queueState());
    assert.equal(queue.find(action => action.id === 'retryable').status, 'pending');
    assert.equal(queue.find(action => action.id === 'uncertain').status, 'failed');
    await page.evaluate(() => window.__storageBoundary.failQueueRead(true));
    await page.getByRole('button', { name: 'Check again', exact: true }).click();
    // b119b9a9 shows a fixed sentence and only logs the raw cause ("the raw cause is only logged").
    await page.getByRole('alert').filter({ hasText: 'Nothing waiting on this device was lost.' }).waitFor();
    await page.evaluate(() => window.__storageBoundary.failQueueRead(false));
    await page.getByRole('button', { name: 'Check again', exact: true }).click();
    await page.getByRole('alert').waitFor({ state: 'hidden' });
    await page.evaluate(() => window.__storageBoundary.switchAccount());
    await historyExplanation.waitFor();
    assert.equal(await page.locator('.archive-item').count(), 0, 'no local archive rows after an account switch');
    assert.equal(await page.evaluate(() => window.__storageBoundary.messageStoreAccess()), 0);
    assert.deepEqual(await page.evaluate(() => window.__storageBoundary.nativeCommands()), []);
    if (!native) await page.screenshot({ path: '/tmp/wabi-group-storage-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390));
    if (!native) await page.screenshot({ path: '/tmp/wabi-group-storage-mobile.png', fullPage: true });
    const { before, after } = await page.evaluate(() => window.__storageBoundary.close());
    assert.deepEqual(after, before, 'unowned archives must remain recoverable, not silently migrated or deleted');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ mode: native ? 'Tauri signals (not native WebView)' : 'browser', status: 'passed',
      results: ['unowned/revoked archives never read or exported across account changes', 'existing server-scoped Planner settings still round-trip',
        'legacy archive records preserved unchanged', 'post-request transaction abort rejects settings save',
        'real queue retry preserves non-retryable failures; read error and recovery shown',
        'no unregistered sidecar calls; 390px viewport fits'] }, null, 2));
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
