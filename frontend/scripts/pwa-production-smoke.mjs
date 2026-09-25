#!/usr/bin/env node
// Exercise the built PWA on a secure-context test origin. Localhost deliberately
// unregisters service workers in Wabi, so it cannot validate production behavior.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const build = resolve(fileURLToPath(new URL('../build/', import.meta.url)));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://wabi.test').pathname);
  const candidate = resolve(build, `.${pathname}`);
  if (!candidate.startsWith(`${build}/`) && candidate !== build) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(candidate === build ? join(build, 'index.html') : candidate);
    const contentType = candidate === build ? 'text/html' : types[extname(candidate)] || 'application/octet-stream';
    response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' }).end(body);
  } catch {
    if (request.headers.accept?.includes('text/html')) {
      response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end(await readFile(join(build, 'index.html')));
    } else {
      response.writeHead(404).end();
    }
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://wabi.test:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    headless: false,
    executablePath: process.env.WABI_SMOKE_CHROMIUM_PATH || '/usr/bin/chromium-browser',
    args: [
      '--host-resolver-rules=MAP wabi.test 127.0.0.1',
      `--unsafely-treat-insecure-origin-as-secure=${origin}`,
      '--no-proxy-server'
    ]
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Service worker did not activate')), 60000))
    ]);
    const manifest = await fetch('/manifest.webmanifest').then(response => response.json());
    const cacheKeys = await caches.keys();
    return { activeScript: registration.active?.scriptURL, manifestName: manifest.name, display: manifest.display, cacheKeys };
  });
  assert.match(result.activeScript, /\/sw\.js\?v=/);
  assert.equal(result.manifestName, 'Wabi');
  assert.equal(result.display, 'standalone');
  assert.ok(result.cacheKeys.some(key => key.startsWith('shell-cache-')), 'PWA shell cache exists');
  const precache = await page.evaluate(async () => fetch('/precache-manifest.json').then(response => response.json()));
  assert.ok(precache.assets.length > 100, 'static build listed lazy application assets');
  // The first navigation can finish before the worker takes control. Reload
  // through the worker so the entry JS/CSS is cached, then prove it loads when
  // the test origin is unreachable.
  await page.reload({ waitUntil: 'load' });
  const { assetCount, unvisitedAsset } = await page.evaluate(async (assets) => {
    const assetCache = (await caches.keys()).find(key => key.startsWith('app-assets-'));
    const loaded = new Set(performance.getEntriesByType('resource').map(entry => new URL(entry.name).pathname));
    return {
      assetCount: assetCache ? (await (await caches.open(assetCache)).keys()).length : 0,
      unvisitedAsset: assets.find(path => path.endsWith('.js') && !loaded.has(path))
    };
  }, precache.assets);
  assert.equal(assetCount, precache.assets.length, 'all lazy application assets were cached');
  assert.ok(unvisitedAsset, 'a lazy chunk had not yet been visited');
  const offlineAssetFailures = [];
  page.on('requestfailed', request => {
    if (new URL(request.url()).pathname.startsWith('/_app/immutable/')) offlineAssetFailures.push(request.url());
  });
  await context.setOffline(true);
  const offlineResponse = await page.reload({ waitUntil: 'load' });
  assert.equal(offlineResponse?.status(), 200, 'offline navigation returns the cached app shell');
  assert.deepEqual(offlineAssetFailures, [], 'the offline shell loaded its application assets');
  const unvisitedOfflineStatus = await page.evaluate(async (path) => (await fetch(path)).status, unvisitedAsset);
  assert.equal(unvisitedOfflineStatus, 200, 'an unvisited lazy chunk loads from cache offline');
  assert.ok(await page.locator('body').innerText(), 'offline shell rendered');
  console.log('PASS: installable PWA and offline application assets', JSON.stringify({ ...result, assetCount }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
