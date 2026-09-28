// Render the real Messages hub with fixture transport; no live account writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const csp = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8')).app.security.csp;
const server = await createServer({
  root, configFile: false, cacheDir: '/tmp/wabi-group-hub-vite-cache',
  resolve: { alias: { $lib: root + 'src/lib' } },
  server: { host: '127.0.0.1', port: 0, open: false, fs: { allow: [root] } },
  plugins: [svelte({ configFile: false }), {
    name: 'group-hub-browser', enforce: 'pre',
    resolveId(id) { if (id === '$app/environment') return '\0group-environment'; },
    load(id) { if (id === '\0group-environment') return 'export const browser=true; export const dev=true; export const building=false;'; },
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (req.url !== '/__group_hub') return next();
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Content-Security-Policy', csp);
        res.end('<!doctype html><title>Wabi group hub verification</title><div id="harness"></div><script type="module" src="/test/group-membership-browser-harness.ts"></script>');
      });
    }
  }]
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: false,
    executablePath: process.env.WABI_SMOKE_CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error('[pageerror]', error.message); });
  page.on('console', message => { if (message.type() === 'error') console.error('[console]', message.text()); });
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    const body = path.endsWith('/join') ? { joined: true, channelId: path.split('/').at(-2) } : {};
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const fixtureUrl = `http://127.0.0.1:${server.httpServer.address().port}/__group_hub`;
  // Vite may finish its initial dependency prebundle after the first page load.
  // The resulting 504 means the fixture must reload against the fresh bundle.
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(fixtureUrl);
    try {
      await page.waitForFunction(() => !!window.__group, null, { timeout: 20_000 });
      break;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  await page.locator('#show-message-hub').click();
  const hub = page.getByRole('complementary', { name: 'Messages hub' });
  await hub.getByRole('button', { name: 'Create group', exact: true }).click();
  await page.getByRole('dialog', { name: 'Create group' }).waitFor();
  await page.getByRole('textbox', { name: 'Group name', exact: true }).fill('Main view group');
  await page.getByRole('button', { name: /Third offline/ }).click();
  await page.evaluate(() => window.__group.clearSent());
  await page.getByRole('button', { name: 'Create Group (2 members)', exact: true }).click();
  const request = await page.evaluate(() => window.__group.sent().find(([event]) => event === 'create-group')?.[1]);
  assert.ok(request?.requestId);
  const channel = { ...await page.evaluate(() => window.__group.group('2', ['user-1', 'user-3'])),
    id: `group-${request.requestId}`, name: 'Main view group' };
  await page.evaluate(channel => window.__group.receive('group-channel-added', { channel }), channel);
  await page.evaluate(({ request, channel }) => window.__group.receive('group-operation-result', {
    ...request, operation: 'create', ok: true, channelId: channel.id,
    membershipRevision: channel.membershipRevision, channel
  }), { request, channel });
  await page.getByRole('dialog', { name: 'Create group' }).waitFor({ state: 'hidden' });
  assert.equal((await page.evaluate(() => window.__group.state())).center, channel.id);
  assert.equal(await hub.getByRole('button', { name: 'Main view group' }).count(), 1);

  const conversation = page.getByRole('complementary', { name: 'Center group conversation' });
  await conversation.getByRole('button', { name: 'Group settings' }).waitFor();
  await page.waitForFunction(id => window.__group.sent().some(([event, request]) =>
    event === 'load-history' && request.channelId === id && request.limit === 50), channel.id);
  const firstPageRequest = await page.evaluate(id => window.__group.sent().find(([event, request]) =>
    event === 'load-history' && request.channelId === id && request.limit === 50)?.[1], channel.id);
  const pageRows = Array.from({ length: 50 }, (_, index) => ({
    id: `msg_${(index + 75).toString(16)}`, userId: 'user-1', user: 'Owner',
    text: `group-page-${index + 75}`, type: 'text', timestamp: 1_790_000_000_000 + index
  }));
  await page.evaluate(({ channelId, requestId, rows }) => window.__group.receive('history-loaded', {
    channelId, requestId, messages: rows, hasMore: true
  }), { channelId: channel.id, requestId: firstPageRequest.requestId, rows: pageRows });
  await conversation.getByRole('button', { name: 'Load earlier messages' }).click();
  const olderRequest = await page.evaluate(id => window.__group.sent().filter(([event, request]) =>
    event === 'load-history' && request.channelId === id && request.beforeMessageId).at(-1)?.[1], channel.id);
  assert.equal(olderRequest?.beforeMessageId, pageRows[0].id);
  const olderRows = Array.from({ length: 25 }, (_, index) => ({
    id: `msg_${index.toString(16)}`, userId: 'user-1', user: 'Owner',
    text: `group-page-${index}`, type: 'text', timestamp: 1_790_000_000_000 - 100 + index
  }));
  await page.evaluate(({ channelId, requestId, rows }) => window.__group.receive('history-loaded', {
    channelId, requestId, messages: rows, hasMore: false
  }), { channelId: channel.id, requestId: olderRequest.requestId, rows: olderRows });
  await page.waitForFunction(id => window.__group.state().messages[id]?.length === 75, channel.id);

  await conversation.getByRole('button', { name: 'Group settings' }).click();
  await conversation.getByRole('button', { name: 'Add', exact: true }).click();
  await conversation.locator('.add-user-item, .no-users').first().waitFor();
  const addableNames = await conversation.locator('.add-user-item').allTextContents();
  assert.ok(addableNames.some(name => name.includes('Second')), `Second member was absent from center Add list: ${JSON.stringify(addableNames)}`);
  await conversation.locator('.add-user-item').filter({ hasText: 'Second' }).click();
  const addRequest = await page.evaluate(id => window.__group.sent().filter(([event, request]) =>
    event === 'add-group-member' && request.channelId === id).at(-1)?.[1], channel.id);
  assert.equal(addRequest?.userId, 'user-2');
  const withSecond = { ...channel, members: ['user-1', 'user-3', 'user-2'], membershipRevision: '3' };
  await page.evaluate(updated => window.__group.receive('group-membership-updated', { channelId: updated.id, channel: updated }), withSecond);
  await page.evaluate(({ request, updated }) => window.__group.receive('group-operation-result', {
    ...request, operation: 'add', ok: true, channelId: updated.id,
    membershipRevision: updated.membershipRevision, channel: updated
  }), { request: addRequest, updated: withSecond });
  await conversation.getByRole('button', { name: 'Remove Second from group' }).waitFor();
  await conversation.getByRole('button', { name: 'Remove Second from group' }).click();
  const removeRequest = await page.evaluate(id => window.__group.sent().filter(([event, request]) =>
    event === 'kick-group-member' && request.channelId === id).at(-1)?.[1], channel.id);
  assert.equal(removeRequest?.targetUserId, 'user-2');
  const withoutSecond = { ...withSecond, members: ['user-1', 'user-3'], membershipRevision: '4' };
  await page.evaluate(updated => window.__group.receive('group-membership-updated', { channelId: updated.id, channel: updated }), withoutSecond);
  await page.evaluate(({ request, updated }) => window.__group.receive('group-operation-result', {
    ...request, operation: 'kick', ok: true, channelId: updated.id,
    membershipRevision: updated.membershipRevision, channel: updated
  }), { request: removeRequest, updated: withoutSecond });
  await conversation.getByRole('button', { name: 'Remove Second from group' }).waitFor({ state: 'hidden' });

  await page.screenshot({ path: '/tmp/wabi-group-hub-desktop.png', fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  const box = await hub.getByRole('button', { name: 'Create group', exact: true }).boundingBox();
  assert.ok(box && box.width >= 40 && box.x >= 0 && box.x + box.width <= 390);
  await page.screenshot({ path: '/tmp/wabi-group-hub-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', group: channel.id,
    checks: ['center Create group action', 'server-confirmed modal', 'center selection',
      'older group history cursor', 'center Add/Remove member actions', '390px group action'] }));
} finally {
  await browser?.close();
  await server.close();
}
