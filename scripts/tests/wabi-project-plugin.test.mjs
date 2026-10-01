import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createProjectPlugin, startControl } from '../wabi-project-plugin.mjs';
import { packagePlugin } from '../package-wabi-project-plugin.mjs';

const connection = { version: 1, serverUrl: 'https://wabi.example', channelId: 'project_one', botToken: 'private-bot-secret' };
const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
const issuer = 'https://plugin.example';
const resource = `${issuer}/mcp`;
const verifier = 'v'.repeat(43);
const hash = value => createHash('sha256').update(value).digest('base64url');
const accept = { Accept: 'application/json, text/event-stream' };
async function fixture(t, fetcher = async () => new Response(JSON.stringify({ tasks: [], pages: [] })), extra = {}) {
  let clock = Date.now();
  const plugin = createProjectPlugin({ connection, publicUrl: issuer, callbackUrls: [callback], connectionName: 'Dot · disposable Project', fetcher, now: () => clock, ...extra });
  plugin.server.listen(0, '127.0.0.1'); await once(plugin.server, 'listening');
  t.after(() => { plugin.server.close(); plugin.server.closeAllConnections(); });
  const base = `http://127.0.0.1:${plugin.server.address().port}`;
  const request = (path, options = {}) => fetch(`${base}${extra.authPath && ['/register', '/authorize', '/token', '/revoke'].includes(path.split('?')[0]) ? extra.authPath : ''}${path}`, { redirect: 'manual', ...options });
  const post = (path, params, form = false, headers = {}) => request(path, { method: 'POST', headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: form ? new URLSearchParams(params).toString() : JSON.stringify(params) });
  async function register() {
    const response = await post('/register', { redirect_uris: [callback], token_endpoint_auth_method: 'none' }); assert.equal(response.status, 201); return (await response.json()).client_id;
  }
  async function start(clientId, changes = {}) {
    return request(`/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: callback, resource, scope: 'project:read project:write', response_type: 'code', state: 'opaque-state', code_challenge_method: 'S256', code_challenge: hash(verifier), ...changes })}`);
  }
  async function approve(response, linkCode = plugin.rotateLink(), changes = {}) {
    const html = await response.text(), transaction = /name="transaction" value="([^"]+)"/.exec(html)?.[1];
    const cookie = response.headers.get('set-cookie').split(';')[0];
    return post('/authorize', { transaction, linkCode, consent: 'yes', ...changes }, true, { Cookie: cookie, Origin: issuer });
  }
  async function exchange(clientId, code, changes = {}) {
    return post('/token', { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: callback, resource, ...changes }, true);
  }
  async function link() {
    const clientId = await register(), approved = await approve(await start(clientId)); assert.equal(approved.status, 303);
    const target = new URL(approved.headers.get('location')); assert.equal(target.searchParams.get('iss'), issuer); assert.equal(target.searchParams.get('state'), 'opaque-state');
    const tokens = await exchange(clientId, target.searchParams.get('code')); assert.equal(tokens.status, 200);
    return { clientId, ...await tokens.json() };
  }
  async function rpc(token, method, params = {}, id = 1, extraHeaders = {}) {
    return post('/mcp', { jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }, false, { ...accept, Authorization: `Bearer ${token}`, ...extraHeaders });
  }
  return { plugin, request, post, register, start, approve, exchange, link, rpc, advance: ms => clock += ms };
}

test('discovery and transport require auth, correct origin, versions and bounded input', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/health')).status, 200);
  const rebindingStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(f.plugin.server.address() ? `http://127.0.0.1:${f.plugin.server.address().port}/health` : '', { headers: { Host: 'rebind.attacker.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(rebindingStatus, 403);
  const noauth = await f.post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize' }); assert.equal(noauth.status, 401); assert(noauth.headers.get('www-authenticate').includes('resource_metadata'));
  assert.equal((await f.request('/.well-known/oauth-protected-resource')).status, 200);
  const discovery = await (await f.request('/.well-known/oauth-authorization-server')).json(); assert.deepEqual(discovery.code_challenge_methods_supported, ['S256']);
  const tokens = await f.link();
  const initialized = await (await f.rpc(tokens.access_token, 'initialize', { protocolVersion: '2025-06-18' })).json(); assert.equal(initialized.result.protocolVersion, '2025-06-18'); assert(initialized.result.instructions.includes('Done only'));
  assert.equal((await f.rpc(tokens.access_token, 'ping', {}, 2, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.rpc(tokens.access_token, 'ping', {}, 2, { 'MCP-Protocol-Version': 'wrong' })).status, 400);
  assert.equal((await f.rpc(tokens.access_token, 'ping', {}, 2, { Accept: 'text/event-stream' })).status, 406);
  assert.equal((await f.request('/mcp', { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 405);
  assert.equal((await f.post('/mcp', { jsonrpc: '2.0', id: 3, method: 'ping', params: 'invalid' }, false, { ...accept, Authorization: `Bearer ${tokens.access_token}` })).status, 400);
  assert.equal((await f.post('/mcp', { content: 'x'.repeat(140000) }, false, { ...accept, Authorization: `Bearer ${tokens.access_token}` })).status, 413);
});
test('a request body held across revocation cannot start a Project operation', async t => {
  let reads = 0; const f = await fixture(t, async () => { reads++; return new Response(JSON.stringify({ tasks: [], pages: [] })); });
  const tokens = await f.link(), incoming = once(f.plugin.server, 'request');
  let request;
  const response = new Promise((resolve, reject) => {
    request = httpRequest(`http://127.0.0.1:${f.plugin.server.address().port}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${tokens.access_token}` } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  request.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"project_brief"}');
  await incoming; f.plugin.revoke(); request.end('}');
  assert.equal(await response, 401); assert.equal(reads, 0);
});
test('callbacks, resource, consent and cookie bind private single-use linking', async t => {
  const f = await fixture(t), client = await f.register(), code = f.plugin.rotateLink();
  assert.equal((await f.post('/register', { redirect_uris: ['https://evil.example/callback'] })).status, 400);
  assert.equal((await f.start(client, { redirect_uri: 'https://evil.example/callback' })).status, 400);
  assert.equal((await f.start(client, { resource: 'https://other.example/mcp' })).status, 400);
  assert.equal((await f.approve(await f.start(client), code, { consent: 'no' })).status, 403);
  assert.equal(f.plugin.consentStatus().lastConsentFailure.reason, 'consent_missing');
  assert.equal((await f.approve(await f.start(client), 'wrong')).status, 403);
  assert.equal(f.plugin.consentStatus().lastConsentFailure.reason, 'code_mismatch');
  const started = await f.start(client), html = await started.text(), transaction = /name="transaction" value="([^"]+)"/.exec(html)[1];
  assert.equal((await f.post('/authorize', { transaction, linkCode: code, consent: 'yes' }, true, { Origin: issuer })).status, 403);
  assert.equal(f.plugin.consentStatus().lastConsentFailure.reason, 'cookie_missing');
  assert.deepEqual(Object.keys(f.plugin.consentStatus().lastConsentFailure), ['reason', 'at']);
  assert(!JSON.stringify(f.plugin.consentStatus()).includes(code));
  const approved = await f.approve(await f.start(client), code); assert.equal(approved.status, 303);
  assert.equal(f.plugin.consentStatus().lastConsentFailure, null);
  assert.equal((await f.approve(await f.start(client), code)).status, 403);
});
test('PKCE, code replay, client and resource binding reject bad token exchanges', async t => {
  const f = await fixture(t), client = await f.register(), other = await f.register();
  const approved = await f.approve(await f.start(client)); const code = new URL(approved.headers.get('location')).searchParams.get('code');
  assert.equal((await f.exchange(other, code)).status, 400);
  assert.equal((await f.exchange(client, code, { code_verifier: 'z'.repeat(43) })).status, 400);
  assert.equal((await f.exchange(client, code, { resource: 'https://other.example' })).status, 400);
  assert.equal((await f.exchange(client, code)).status, 200);
  assert.equal((await f.exchange(client, code)).status, 400);
});
test('consent pages preserve browser form origin while refusing opaque or foreign submissions', async t => {
  const f = await fixture(t), client = await f.register(), linkCode = f.plugin.rotateLink();
  const started = await f.start(client);
  assert.equal(started.headers.get('referrer-policy'), 'same-origin');
  assert(started.headers.get('content-security-policy').includes("form-action 'self' https://chatgpt.com;"));
  assert(!started.headers.get('content-security-policy').includes('evil.example'));
  const html = await started.text(), transaction = /name="transaction" value="([^"]+)"/.exec(html)[1];
  const cookie = started.headers.get('set-cookie').split(';')[0];
  const params = { transaction, linkCode, consent: 'yes' };
  for (const badOrigin of ['null', 'https://evil.example', undefined]) {
    const response = await f.post('/authorize', params, true, { Cookie: cookie, ...(badOrigin ? { Origin: badOrigin } : {}) });
    assert.equal(response.status, 403);
  }
  // Rejected submissions must not consume the legitimate one-use consent.
  const approved = await f.post('/authorize', params, true, { Cookie: cookie, Origin: issuer });
  assert.equal(approved.status, 303);
  assert.equal(approved.headers.get('referrer-policy'), 'no-referrer');
  const code = new URL(approved.headers.get('location')).searchParams.get('code');
  assert.equal((await f.exchange(client, code)).status, 200);
});
test('operator-preserved public client registration still requires fresh private consent and PKCE', async t => {
  const client = 'p'.repeat(43), expires = Date.now() + 86400000;
  const registeredClients = { version: 1, issuer, clients: [{ clientId: client, redirectUris: [callback], expires }] };
  const f = await fixture(t, undefined, { registeredClients });
  assert.equal((await f.start(client)).status, 200);
  assert.equal((await f.post('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, false, { ...accept, Authorization: `Bearer ${client}` })).status, 401);
  assert.equal((await f.approve(await f.start(client), 'wrong')).status, 403);
  const approved = await f.approve(await f.start(client)); assert.equal(approved.status, 303);
  const code = new URL(approved.headers.get('location')).searchParams.get('code');
  assert.equal((await f.exchange(client, code, { code_verifier: 'z'.repeat(43) })).status, 400);
  assert.equal((await f.exchange(client, code)).status, 200);
  f.advance(86400001); assert.equal((await f.start(client)).status, 400);
  const valid = { connection, publicUrl: issuer, callbackUrls: [callback], connectionName: 'Dot' };
  for (const registration of [
    { ...registeredClients, issuer: 'https://elsewhere.example' },
    { ...registeredClients, clients: [registeredClients.clients[0], registeredClients.clients[0]] },
    { ...registeredClients, clients: [{ clientId: 'bad', redirectUris: [callback], expires }] },
    { ...registeredClients, clients: [{ clientId: client, redirectUris: ['https://evil.example/callback'], expires }] },
    { ...registeredClients, clients: [{ clientId: client, redirectUris: [callback], expires: Date.now() + 31 * 86400000 }] }
  ]) assert.throws(() => createProjectPlugin({ ...valid, registeredClients: registration }));
  const expired = await fixture(t, undefined, { registeredClients: { ...registeredClients, clients: [{ ...registeredClients.clients[0], expires: Date.now() - 1 }] } });
  assert.equal((await expired.start(client)).status, 400);
});
test('expiry, rotating renewal, wrong client and revocation invalidate credentials', async t => {
  const f = await fixture(t), tokens = await f.link(), other = await f.register();
  const renewal = (token, clientId = tokens.clientId) => f.post('/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: token, resource }, true);
  assert.equal((await renewal(tokens.refresh_token, other)).status, 400);
  f.advance(3600001); assert.equal((await f.rpc(tokens.access_token, 'ping')).status, 401);
  const renewed = await renewal(tokens.refresh_token); assert.equal(renewed.status, 200); const current = await renewed.json();
  assert.equal((await renewal(tokens.refresh_token)).status, 400);
  assert.equal((await f.post('/revoke', { client_id: tokens.clientId, token: current.refresh_token }, true)).status, 200);
  assert.equal((await f.rpc(current.access_token, 'ping')).status, 401);
  assert.equal((await renewal(current.refresh_token)).status, 400);
  const newLink = await f.link(); f.plugin.revoke(); assert.equal((await f.rpc(newLink.access_token, 'ping')).status, 401);
});
test('expired pairing and authorization code cannot complete linking', async t => {
  const f = await fixture(t), client = await f.register(), linkCode = f.plugin.rotateLink(); f.advance(600001);
  assert.equal((await f.approve(await f.start(client), linkCode)).status, 403);
  const approved = await f.approve(await f.start(client)); f.advance(60001);
  assert.equal((await f.exchange(client, new URL(approved.headers.get('location')).searchParams.get('code'))).status, 400);
});
test('tools use one configured Project, identify tools-only access and redact secrets', async t => {
  let refused = false, reads = 0;
  const f = await fixture(t, async (url, options) => {
    assert(url.startsWith('https://wabi.example/api/projects/project_one/') || url.startsWith('https://wabi.example/api/wiki/project_one/'));
    assert.equal(options.headers.Authorization, `Bot ${connection.botToken}`); reads++;
    return new Response(JSON.stringify(refused ? { error: connection.botToken } : { tasks: [], pages: [] }), { status: refused ? 403 : 200 });
  });
  const tokens = await f.link();
  const tools = await (await f.rpc(tokens.access_token, 'tools/list')).json(); assert.equal(tools.result.tools.length, 11); assert(tools.result.tools.every(x => !x.annotations.openWorldHint));
  assert.equal(tools.result.tools[0]._meta['openai/profile'], true);
  const profile = await (await f.rpc(tokens.access_token, 'tools/call', { name: 'connection_profile' })).json();
  const data = JSON.parse(profile.result.content[0].text); assert.equal(data.harness, 'none'); assert.equal(data.connectionMode, 'project_tools'); assert.equal(data.channelId, connection.channelId);
  assert(!JSON.stringify(profile).includes(connection.botToken)); assert(profile.result._meta['wabi/bookkeeping']);
  const count = reads;
  const cross = await (await f.rpc(tokens.access_token, 'tools/call', { name: 'read_card', arguments: { taskId: '../other', channelId: 'other' } })).json(); assert.equal(cross.result.isError, true); assert.equal(reads, count);
  refused = true;
  const denied = await (await f.rpc(tokens.access_token, 'tools/call', { name: 'connection_profile' })).json(); assert.equal(denied.result.isError, true); assert(!JSON.stringify(denied).includes(connection.botToken));
});
test('direct HTTP client creates, claims, adds evidence and finishes exactly one card; stale save fails', async t => {
  let card, writes = 0;
  const f = await fixture(t, async (url, options) => {
    const patch = options.body && JSON.parse(options.body);
    if (options.method === 'POST' && url.endsWith('/tasks')) { card = { ...patch, taskId: 'task_direct', revision: 1 }; writes++; }
    else if (options.method === 'POST' && url.endsWith('/claim')) { assert.equal(patch.expectedRevision, card.revision); card = { ...card, status: 'in_progress', assigneeUserId: 123, revision: card.revision + 1 }; writes++; }
    else if (options.method === 'PUT') { assert.equal(patch.expectedRevision, card.revision); card = { ...card, ...patch, revision: card.revision + 1 }; writes++; }
    return new Response(JSON.stringify(card ?? { tasks: [], pages: [] }));
  });
  const tokens = await f.link();
  const tool = async (name, args) => (await (await f.rpc(tokens.access_token, 'tools/call', { name, arguments: args })).json()).result;
  let result = await tool('create_card', { operationId: randomUUID(), title: 'Direct plugin smoke', description: 'One disposable card' }); card = JSON.parse(result.content[0].text);
  assert(result.content[1].text.includes('Done requires'));
  result = await tool('claim_card', { taskId: card.taskId, expectedRevision: card.revision }); card = JSON.parse(result.content[0].text);
  result = await tool('update_card', { taskId: card.taskId, expectedRevision: card.revision, notes: 'Direct-client acceptance passed', status: 'done' }); assert(!result.isError);
  const stale = await tool('update_card', { taskId: card.taskId, expectedRevision: 1, notes: 'Overwrite' }); assert.equal(stale.isError, true); assert.equal(writes, 3);
  const saved = JSON.parse((await tool('read_card', { taskId: card.taskId })).content[0].text); assert.equal(saved.status, 'done'); assert.equal(saved.notes, 'Direct-client acceptance passed');
});
test('package carries a real configurable endpoint, no secret and refuses overwrite', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'wabi-plugin-package-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const destination = join(temp, 'plugin');
  await packagePlugin('https://my-community.example/mcp', destination);
  const manifest = JSON.parse(await readFile(join(destination, 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(await readFile(join(destination, 'mcp.json'), 'utf8'));
  assert.equal(manifest.name, 'wabi-project'); assert.equal(mcp.mcpServers.wabi.type, 'streamable-http'); assert.equal(mcp.mcpServers.wabi.url, 'https://my-community.example/mcp');
  assert(!(await readFile(join(destination, 'skills/wabi-project/SKILL.md'), 'utf8')).includes(connection.botToken));
  await writeFile(join(destination, 'keep.txt'), 'User work');
  await assert.rejects(packagePlugin('https://my-community.example/mcp', destination));
  assert.equal(await readFile(join(destination, 'keep.txt'), 'utf8'), 'User work');
  for (const endpoint of ['http://remote.example/mcp', 'https://user:pass@example.org/mcp', 'https://example.org/mcp?token=secret']) await assert.rejects(packagePlugin(endpoint, join(temp, 'bad')));
});
test('invalid public origins, labels and callback config fail closed', () => {
  const valid = { connection, publicUrl: issuer, callbackUrls: [callback], connectionName: 'Dot' };
  for (const publicUrl of ['http://remote.example', 'https://user:pass@example.org', 'https://example.org/path', 'https://example.org?token=x']) assert.throws(() => createProjectPlugin({ ...valid, publicUrl }));
  for (const callbackUrls of [[], ['https://evil.example/cb#fragment'], ['http://evil.example/cb']]) assert.throws(() => createProjectPlugin({ ...valid, callbackUrls }));
  assert.throws(() => createProjectPlugin({ ...valid, connectionName: 'bad\nlabel' }));
});
test('namespaced authorization works through discovery and private control socket', async t => {
  const f = await fixture(t, undefined, { authPath: '/project-plugin' });
  const metadata = await (await f.request('/.well-known/oauth-authorization-server')).json(); assert.equal(metadata.authorization_endpoint, issuer + '/project-plugin/authorize');
  const tokens = await f.link(); assert.equal((await f.rpc(tokens.access_token, 'ping')).status, 200);
  const directory = await mkdtemp(join(tmpdir(), 'wabi-control-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, 'control.sock'), control = await startControl(f.plugin, socketPath); t.after(() => control.close());
  const command = line => new Promise((resolve, reject) => {
    const socket = connect(socketPath); let text = ''; socket.on('error', reject); socket.on('data', data => text += data.toString()); socket.on('end', () => resolve(JSON.parse(text))); socket.on('connect', () => socket.end(line + '\n'));
  });
  const linked = await command('link'); assert.equal(linked.linkCode.length, 43);
  assert.deepEqual(await command('status'), { lastConsentFailure: null });
  assert.equal((await f.approve(await f.start(tokens.clientId), 'wrong')).status, 403);
  const diagnostic = await command('status');
  assert.equal(diagnostic.lastConsentFailure.reason, 'code_mismatch');
  assert.deepEqual(Object.keys(diagnostic.lastConsentFailure), ['reason', 'at']);
  assert(!JSON.stringify(diagnostic).includes(linked.linkCode));
  await assert.rejects(startControl(f.plugin, socketPath));
  assert.equal((await command('revoke')).revoked, true); assert.equal((await f.rpc(tokens.access_token, 'ping')).status, 401);
  assert.deepEqual(await command('status'), { lastConsentFailure: null });
  await chmod(directory, 0o755); await assert.rejects(startControl(f.plugin, join(directory, 'unsafe.sock')));
});
