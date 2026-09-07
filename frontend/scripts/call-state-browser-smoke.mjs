// Real browser storage/fetch/WebSocket and production call client + refresh
// modules under desktop CSP. The network peer is an explicit protocol fixture;
// Rust integration tests separately exercise real Axum + temporary WabiDB.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
const csp = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8')).app.security.csp;
const server = await createServer({ root, configFile: false,
  resolve: { alias: { $lib: root + 'src/lib' } },
  server: { host: '127.0.0.1', port: 0, open: false, fs: { allow: [root] } },
  plugins: [{ name: 'call-state-boundaries', enforce: 'pre',
    resolveId(id, importer) {
      const resolved = id.startsWith('.') && importer ? fileURLToPath(new URL(id, `file://${importer}`)) : id;
      if (resolved.replace(/\.ts$/, '') === root + 'src/lib/serverUrl') return '\0call-server-selection';
    },
    load(id) {
      if (id === '\0call-server-selection') return 'export const getServerUrl=()=>window.__selectedServer||location.origin; export const resolveServerUrl=()=>({url:getServerUrl()}); export const normalizeServerUrl=s=>s?new URL(s).origin:null;';
    },
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (req.url !== '/__call_state') return next();
        res.setHeader('Content-Type', 'text/html'); res.setHeader('Content-Security-Policy', csp);
        res.end('<!doctype html><title>Wabi call-state verification</title><p>Isolated credential and subscription harness</p><script type="module" src="/test/call-state-browser-harness.ts"></script>');
      });
    }
  }]
});
const token = (user, version) => `header.${Buffer.from(JSON.stringify({ sub: String(user), version })).toString('base64url')}.signature`;
async function waitUntil(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Protocol fixture did not reach its expected barrier');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
let browser;
try {
  await server.listen(); browser = await chromium.launch({ headless: false });
  const page = await browser.newPage(); const errors = [], refreshes = [], handshakes = [];
  page.on('pageerror', e => errors.push(e.message));
  let mode = 'success', release;
  await page.route('**/api/auth/refresh', async route => {
    const request = route.request(); const body = request.postDataJSON();
    refreshes.push({ url: request.url(), token: body.refreshToken });
    if (mode === 'held') await new Promise(r => { release = r; });
    const status = mode === 'transient' ? 503 : mode === 'denied' ? 401 : 200;
    const version = body.refreshToken.endsWith('two') ? 20 : 2;
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ accessToken: token(1, version), refreshToken: `rotated-${version}` }) });
  });
  let wire, firstAck;
  await page.routeWebSocket('**/ws', socket => {
    wire = socket;
    socket.onMessage(text => {
      const message = JSON.parse(text); handshakes.push(message);
      if (message.type !== 'authenticate') throw new Error('Unexpected client frame');
      const version = JSON.parse(Buffer.from(message.token.split('.')[1], 'base64url')).version;
      const ack = () => socket.send(JSON.stringify({ type: 'authenticated', user_id: 1, expires_at: Math.floor(Date.now() / 1000) + (version === 1 ? 31 : 3600) }));
      if (version === 1) firstAck = ack; else ack();
    });
  });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  await page.goto(`${origin}/__call_state`); await page.waitForFunction(() => !!window.__callState);
  const one = origin, two = 'http://second-server.test';
  await page.evaluate(({ one, two, access }) => {
    sessionStorage.clear(); localStorage.clear(); window.__selectedServer = one;
    const api = window.__callState; api.setAuthToken(access, one); api.setAuthToken(access, two);
    // Legacy unscoped refresh must never be transmitted to a guessed server.
    sessionStorage.setItem('wabi_refresh_token:default', 'unknown-issuer');
  }, { one, two, access: token(1, 1) });
  assert.equal(await page.evaluate(() => window.__callState.tryRefresh()), false);
  assert.equal(refreshes.length, 0);
  await page.evaluate(({ one, two }) => {
    window.__callState.setRefreshToken('refresh-one', one);
    window.__callState.setRefreshToken('refresh-two', two);
  }, { one, two });
  // Both servers refresh independently; same-server callers coalesce.
  const result = await page.evaluate(async ({ one, two }) => Promise.all([
    window.__callState.tryRefresh(one), window.__callState.tryRefresh(one), window.__callState.tryRefresh(two)
  ]), { one, two });
  assert.deepEqual(result, [true, true, true]); assert.equal(refreshes.length, 2);
  assert.deepEqual(refreshes.map(r => r.token).sort(), ['refresh-one', 'refresh-two']);
  assert(refreshes.some(r => r.url.startsWith(two) && r.token === 'refresh-two'));
  // Late success after logout must not restore either access or refresh tokens.
  mode = 'held';
  const pending = page.evaluate(one => window.__callState.tryRefresh(one), one);
  await waitUntil(() => typeof release === 'function');
  assert.equal(typeof release, 'function');
  await page.evaluate(one => { window.__callState.clearAuthToken(one); window.__callState.clearRefreshToken(one); }, one);
  release(); assert.equal(await pending, false);
  assert.equal(await page.evaluate(one => window.__callState.getAuthToken(one), one), null);
  // A transient server failure preserves credentials; definitive denial clears
  // even a remembered access token rather than promoting it back on next read.
  await page.evaluate(({ one, access }) => { window.__callState.setAuthToken(access, one); window.__callState.setPersistentAuthToken(access, one); window.__callState.setRefreshToken('retry-one', one); }, { one, access: token(1, 1) });
  mode = 'transient'; assert.equal(await page.evaluate(one => window.__callState.tryRefresh(one), one), false);
  assert.equal(await page.evaluate(one => window.__callState.getRefreshToken(one), one), 'retry-one');
  mode = 'denied'; assert.equal(await page.evaluate(one => window.__callState.tryRefresh(one), one), false);
  assert.equal(await page.evaluate(one => window.__callState.getAuthToken(one), one), null);
  mode = 'success';
  await page.evaluate(({ one, access }) => { window.__callState.setAuthToken(access, one); window.__callState.setRefreshToken('refresh-one', one); }, { one, access: token(1, 1) });
  const connection = page.evaluate(one => window.__callState.connect(one), one);
  await waitUntil(() => typeof firstAck === 'function');
  assert.equal(await page.evaluate(() => window.__callState.ready()), false);
  mode = 'transient';
  const beforeRenewal = refreshes.length;
  firstAck(); assert.equal(await connection, true);
  // The short first expiry triggers proactive refresh and reauth on the SAME
  // socket. No fake ready state before ACK and no media-disconnect callback.
  await page.waitForFunction(() => window.__callState.getAuthToken().includes('header.') && window.__callState.ready());
  for (let i = 0; i < 40 && refreshes.length === beforeRenewal; i++) await page.waitForTimeout(100);
  assert.equal(refreshes.length, beforeRenewal + 1);
  assert.equal(await page.evaluate(() => window.__callState.ready()), true);
  mode = 'success';
  for (let i = 0; i < 80 && handshakes.length < 2; i++) await page.waitForTimeout(100);
  assert.equal(handshakes.length, 2); assert.equal(handshakes[1].token, token(1, 2));
  assert.deepEqual(await page.evaluate(() => window.__callState.events), ['connected']);
  wire.close({ code: 1006, reason: 'fixture transient flap' });
  for (let i = 0; i < 40 && handshakes.length < 3; i++) await page.waitForTimeout(100);
  assert.equal(handshakes.length, 3);
  await page.waitForFunction(() => window.__callState.ready());
  await page.evaluate(() => window.__callState.disconnect());
  assert.deepEqual(errors, []);
  console.log('PASS: headful desktop-CSP call handshake, same-socket renewal, reconnect, per-server refresh coalescing, legacy-token rejection, logout races, transient failures and remembered-token revocation. Network peer is a protocol fixture; actual server contracts are tested separately.');
} finally { await browser?.close(); await server.close(); }
