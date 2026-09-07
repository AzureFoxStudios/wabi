// Headful Chromium with the real browser/Tauri client module graph and CSP.
// All server responses are controlled fixtures; never touches live accounts.
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
    name: 'group-membership-browser', enforce: 'pre',
    resolveId(id) { if (id === '$app/environment') return '\0group-environment'; },
    load(id) { if (id === '\0group-environment') return 'export const browser=true; export const dev=true; export const building=false;'; },
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (req.url !== '/__group_membership') return next();
        res.setHeader('Content-Type', 'text/html'); res.setHeader('Content-Security-Policy', csp);
        res.end('<!doctype html><title>Wabi group membership verification</title><div id="harness"></div><script type="module" src="/test/group-membership-browser-harness.ts"></script>');
      });
    }
  }]
});
let browser;
const results = [];
try {
  await server.listen(); browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    const body = path.endsWith('/join') ? { joined: true, channelId: path.split('/').at(-2) } : {};
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__group_membership`);
  await page.waitForFunction(() => !!window.__group);
  const receive = (event, payload) => page.evaluate(([event, payload]) => window.__group.receive(event, payload), [event, payload]);
  const sent = event => page.evaluate(event => window.__group.sent().filter(([name]) => name === event).at(-1)?.[1], event);
  const acknowledge = async (event, operation, channel) => {
    const request = await sent(event);
    await receive('group-membership-updated', { channelId: channel.id, channel });
    await receive('group-operation-result', { ...request, operation, ok: true, channelId: channel.id, membershipRevision: channel.membershipRevision, channel });
  };

  await page.getByRole('button', { name: 'Add', exact: true }).click(); // owner is members[1]
  await page.getByRole('button', { name: /Third offline/ }).click();
  await page.getByRole('status').filter({ hasText: 'Waiting for server confirmation' }).waitFor();
  assert.equal((await sent('add-group-member')).expectedRevision, '1');
  await page.getByText('2 members', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Leave Group' }).isDisabled(), true);
  await receive('group-operation-result', { ...await sent('add-group-member'), operation: 'add', ok: false, code: 'CONFLICT', error: 'Membership changed; review and retry.' });
  await page.getByRole('alert').filter({ hasText: 'Membership changed' }).waitFor();
  await page.getByRole('button', { name: /Third offline/ }).click();
  const added = await page.evaluate(() => window.__group.group('2', ['user-2', 'user-1', 'user-3']));
  await acknowledge('add-group-member', 'add', added);
  await page.getByText('3 members', { exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  results.push('explicit owner, offline directory, pending/denied/retry and committed add are distinct UI states');

  await page.getByRole('button', { name: 'Remove Second from group', exact: true }).focus();
  await page.keyboard.press('Enter');
  const kicked = { ...added, members: ['user-1', 'user-3'], membershipRevision: '3' };
  await acknowledge('kick-group-member', 'kick', kicked);
  await page.getByText('2 members', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Remove Second from group', exact: true }).count(), 0);
  await page.evaluate(() => window.__group.seedViews());
  await page.getByRole('button', { name: 'Leave Group' }).click();
  const leave = await sent('leave-group');
  await page.getByText('Launch team', { exact: true }).waitFor();
  await receive('group-removed', { channelId: 'group-test', membershipRevision: '4', reason: 'leave' });
  await receive('group-operation-result', { ...leave, operation: 'leave', ok: true, membershipRevision: '4', channel: { ...kicked, ownerId: 'user-3', members: ['user-3'], membershipRevision: '4' } });
  await page.getByText('Group unavailable', { exact: true }).waitFor();
  await receive('channel-messages', { channelId: 'group-test', messages: [{ id: 'stale-private', type: 'text', text: 'stale', timestamp: 1 }] });
  await receive('group-channel-added', { channel: added }); // delayed old grant
  const state = await page.evaluate(() => window.__group.state());
  assert.equal(state.selected, null); assert.equal(state.center, 'unrelated-dm'); assert.equal(state.current, 'general');
  assert.equal(state.messages['group-test'], undefined); assert.equal(state.messages.general[0].id, 'public-canary');
  assert.equal(state.unread, 2); assert.equal(state.counts['group-test'], undefined);
  assert.equal(state.voice['group-test'], undefined); assert.equal(state.voice.voice[0].id, 'voice-canary');
  assert.equal(state.typing['group-test'], undefined); assert.equal(state.older['group-test'], undefined);
  results.push('keyboard kick, confirmed leave, targeted cleanup, unrelated-surface canaries and stale-event fencing');

  await page.locator('#create-group').click();
  await page.getByRole('textbox', { name: 'Group name', exact: true }).fill('Release room');
  await page.getByRole('button', { name: /Third offline/ }).click();
  await page.getByRole('button', { name: 'Create Group (2 members)', exact: true }).click();
  const firstCreate = await sent('create-group');
  await page.evaluate(() => window.__group.disconnect());
  await page.getByRole('alert').filter({ hasText: 'No server confirmation' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Group name', exact: true }).inputValue(), 'Release room');
  await page.evaluate(() => { window.__group.install(); window.__group.init(window.__group.group('5')); });
  await page.getByRole('button', { name: 'Create Group (2 members)', exact: true }).click();
  const retry = await sent('create-group'); assert.equal(retry.requestId, firstCreate.requestId);
  const created = { ...added, id: `group-${retry.requestId}`, name: 'Release room', membershipRevision: '6', members: ['user-1', 'user-3'] };
  await receive('group-channel-added', { channel: created });
  await acknowledge('create-group', 'create', created);
  await page.getByRole('dialog', { name: 'Create group' }).waitFor({ state: 'hidden' });
  results.push('lost create confirmation preserves the form and explicit retry reuses the same creation ID');

  await page.evaluate(async () => {
    await window.__group.legacyQueue('leave-group', 'legacy-leave');
    await window.__group.legacyQueue('voice-channel-leave', 'legacy-voice-leave');
    await window.__group.legacyQueue('send-message', 'legacy-message');
    await window.__group.queue('send-message', 'fresh-draft');
    window.__group.beginInit(); window.__group.clearSent(); await window.__group.drain();
  });
  assert.equal(await sent('message'), undefined);
  await page.evaluate(async () => { window.__group.init(window.__group.group('5')); await window.__group.drain(); });
  const message = await sent('message'); assert.equal(message.clientMessageId, 'fresh-draft');
  let queue = await page.evaluate(() => window.__group.queueState());
  assert.notEqual(queue.find(action => action.payload.clientMessageId === 'fresh-draft').status, 'synced');
  await page.evaluate(() => window.__group.drain());
  assert.equal(await page.evaluate(() => window.__group.sent().filter(([event]) => event === 'message').length), 1);
  assert.equal(queue.find(action => action.id === 'legacy-leave').retryable, false);
  assert.equal(queue.find(action => action.id === 'legacy-voice-leave').retryable, false);
  assert.match(queue.find(action => action.id === 'legacy-voice-leave').error, /old voice action/);
  assert.equal((await page.evaluate(() => window.__group.sent())).some(([event]) => event === 'voice-channel-leave'), false);
  assert.equal(queue.find(action => action.id === 'legacy-message').retryable, false);
  await receive('message-accepted', { channelId: 'group-test', clientMessageId: 'fresh-draft', messageId: 'authoritative' });
  // Poll the resolved IndexedDB value, never the truthiness of a Promise.
  await page.evaluate(async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const queue = await window.__group.queueState();
      if (queue.find(action => action.payload.clientMessageId === 'fresh-draft')?.status === 'synced') return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Message acceptance did not commit the synced queue state');
  });
  await page.evaluate(() => window.__group.queue('send-message', 'revoked-draft'));
  await receive('group-removed', { channelId: 'group-test', membershipRevision: '7' });
  await receive('group-channel-added', { channel: { ...added, membershipRevision: '8' } });
  await page.evaluate(async () => { window.__group.clearSent(); await window.__group.drain(); await window.__group.retryQueue(); await window.__group.drain(); });
  assert.equal(await sent('message'), undefined);
  queue = await page.evaluate(() => window.__group.queueState());
  assert.equal(queue.find(action => action.payload.clientMessageId === 'revoked-draft').retryable, false);
  assert.equal(await sent('leave-group'), undefined);
  results.push('real IndexedDB queues wait for init and message acceptance; legacy/revoked intent cannot be retried');

  const claimId = await page.evaluate(() => window.__group.queue('send-message', 'claim-race'));
  const claims = await page.evaluate(id => window.__group.raceClaim(id), claimId);
  assert.equal(claims.filter(Boolean).length, 1);
  await page.evaluate(async () => { window.__group.clearSent(); await window.__group.drain(); await window.__group.retryQueue(); await window.__group.drain(); });
  assert.equal(await sent('message'), undefined);
  results.push('concurrent IndexedDB owners claim once; a durable uncertain attempt is never automatically sent again');

  // Suspend an actual channelStore HTTP join, remove/re-add during the await,
  // then let the old successful response through. It must not emit a join.
  let releaseJoin;
  await page.route('**/api/channels/group-test/join', route => new Promise(resolve => {
    releaseJoin = () => resolve(route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ joined: true, channelId: 'group-test' }) }));
  }));
  await page.evaluate(() => window.__group.joinChannel('group-test'));
  for (let n = 0; !releaseJoin && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(releaseJoin);
  await receive('group-removed', { channelId: 'group-test', membershipRevision: '9' });
  await receive('group-channel-added', { channel: { ...added, membershipRevision: '10' } });
  await page.evaluate(() => window.__group.clearSent());
  await releaseJoin();
  await page.unroute('**/api/channels/group-test/join');
  await page.waitForTimeout(100);
  assert.equal(await sent('join-channel'), undefined);
  await page.evaluate(() => {
    window.__oldPacket = window.__group.retainPacket('group-removed', { channelId: 'group-test', membershipRevision: '999' });
    window.__group.install(); window.__group.init(window.__group.group('10')); window.__oldPacket();
  });
  assert.ok((await page.evaluate(() => window.__group.state())).channels.some(channel => channel.id === 'group-test'));
  await receive('init', { channels: [{ id: 'general', name: 'General', type: 'text', createdAt: 0 }] });
  assert.ok(!(await page.evaluate(() => window.__group.state())).channels.some(channel => channel.id === 'group-test'));
  results.push('delayed HTTP join cannot cross removal/re-add; old socket callbacks cannot revoke new state; missing init removes stale groups');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#create-group').click();
  await page.getByRole('dialog', { name: 'Create group' }).waitFor();
  const box = await page.getByRole('dialog', { name: 'Create group' }).boundingBox();
  assert.ok(box.width <= 390 && box.x >= 0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await receive('group-channel-added', { channel: { ...added, membershipRevision: '11' } });
  await page.evaluate(() => { window.__group.seedViews(); window.__group.logout(); });
  const loggedOut = await page.evaluate(() => window.__group.state());
  assert.equal(loggedOut.messages['group-test'], undefined); assert.equal(loggedOut.selected, null);
  assert.equal(loggedOut.center, 'unrelated-dm');
  results.push('logout-to-guest clears previous group surfaces without borrowing another account\'s authority');
  await page.evaluate(() => window.__group.close());
  const lifecycle = await page.evaluate(() => window.__group.callLifecycle());
  assert.ok(lifecycle.some(entry => entry.event === 'retired'));
  assert.ok(lifecycle.some(entry => entry.event === 'initialized'));
  assert.ok(lifecycle.filter(entry => entry.event === 'retired').every(entry => entry.listeners > 0));
  assert.ok(lifecycle.filter(entry => entry.event === 'initialized').every(entry => entry.ready));
  results.push('real SocketManager retires call owners before listeners and readmits only after authoritative init');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', results, mobile: '390px viewport only; no physical Android/native WebView verification' }, null, 2));
} finally { await browser?.close(); await server.close(); }
