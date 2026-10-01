#!/usr/bin/env node
// Explicit disposable live smoke. Never invoke automatically during install.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createProjectPlugin } from './wabi-project-plugin.mjs';

export async function smoke({ connection, evidencePath, port = 47344, revokeProject }) {
  const issuer = `http://127.0.0.1:${port}`, resource = `${issuer}/mcp`, callback = `${issuer}/callback`;
  const plugin = createProjectPlugin({ connection, publicUrl: issuer, callbackUrls: [callback], connectionName: 'Disposable Dot plugin test' });
  const evidence = { date: new Date().toISOString(), serverUrl: connection.serverUrl, channelId: connection.channelId, operationId: randomUUID(), checks: [], client: 'direct_http_smoke_not_dot', publiclyHosted: false };
  // Persist the operation before any write. Existing evidence is never replaced.
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const save = () => writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  const request = async (path, value, headers = {}, form = false) => {
    const response = await fetch(issuer + path, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: form ? new URLSearchParams(value).toString() : JSON.stringify(value), signal: AbortSignal.timeout(45000) });
    return response;
  };
  try {
    plugin.server.listen(port, '127.0.0.1'); await once(plugin.server, 'listening');
    const client = await (await request('/register', { redirect_uris: [callback] })).json(); assert(client.client_id);
    const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorization = await fetch(`${issuer}/authorize?${new URLSearchParams({ client_id: client.client_id, redirect_uri: callback, resource, scope: 'project:read project:write', response_type: 'code', state: 'disposable-smoke', code_challenge_method: 'S256', code_challenge: challenge })}`);
    assert.equal(authorization.status, 200);
    const transaction = /name="transaction" value="([^"]+)"/.exec(await authorization.text())[1];
    const approved = await request('/authorize', { transaction, linkCode: plugin.rotateLink(), consent: 'yes' }, { Origin: issuer, Cookie: authorization.headers.get('set-cookie').split(';')[0] }, true); assert.equal(approved.status, 303);
    const code = new URL(approved.headers.get('location')).searchParams.get('code');
    const exchanged = await request('/token', { client_id: client.client_id, code, code_verifier: verifier, redirect_uri: callback, resource, grant_type: 'authorization_code' }, {}, true); assert.equal(exchanged.status, 200);
    const tokens = await exchanged.json();
    const rpc = async (name, args = {}, allowError = false) => {
      const response = await request('/mcp', { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }, { Accept: 'application/json, text/event-stream', Authorization: `Bearer ${tokens.access_token}` });
      assert.equal(response.status, 200); const message = await response.json();
      if (allowError) return message.result;
      assert(!message.result.isError, message.result.content[0].text); return JSON.parse(message.result.content[0].text);
    };
    await rpc('connection_profile'); await rpc('project_brief'); evidence.checks.push('profile_and_project_access'); await save();
    const card = await rpc('create_card', { operationId: evidence.operationId, title: 'Direct plugin · disposable proof', description: 'Acceptance: hosted MCP transport directly creates, claims, updates and reads back this toy card and a toy wiki page. No model call or repository change.' });
    evidence.taskId = card.taskId; evidence.botUserId = card.createdByUserId; await save();
    const owned = await rpc('claim_card', { taskId: card.taskId, expectedRevision: card.revision }); assert.equal(owned.status, 'in_progress');
    const page = await rpc('create_wiki', { title: `Plugin proof ${evidence.operationId.slice(0, 8)}`, body: 'Disposable connector proof. No private files, model calls or credentials.' }); evidence.pageId = page.pageId; await save();
    const wiki = await rpc('read_wiki', { pageId: page.pageId });
    await rpc('update_wiki', { pageId: page.pageId, expectedUpdatedAtMicros: wiki.updatedAtMicros, body: 'Disposable connector proof: direct authenticated MCP card/wiki path verified. No model call.' });
    const staleWiki = await rpc('update_wiki', { pageId: page.pageId, expectedUpdatedAtMicros: wiki.updatedAtMicros, body: 'This stale edit must not save.' }, true); assert(staleWiki.isError);
    const completed = await rpc('update_card', { taskId: card.taskId, expectedRevision: owned.revision, notes: `Direct authenticated HTTP MCP test: created, claimed and read this toy card; created, read and updated wiki ${page.pageId}. Stale wiki/card edits and cross-Project arguments are refused. This is a transport test, not a Dot-installed proof.`, status: 'done' }); assert.equal(completed.status, 'done');
    const stale = await rpc('update_card', { taskId: card.taskId, expectedRevision: owned.revision, notes: 'This stale edit must not save.' }, true); assert(stale.isError);
    const crossing = await rpc('read_card', { taskId: card.taskId, channelId: 'another_project' }, true); assert(crossing.isError);
    const saved = await rpc('read_card', { taskId: card.taskId }); assert.equal(saved.status, 'done'); assert(saved.notes.includes('Direct authenticated HTTP MCP test'));
    const savedWiki = await rpc('read_wiki', { pageId: page.pageId }); assert(savedWiki.body.includes('path verified'));
    evidence.checks.push('card_create_claim_evidence_done_readback', 'wiki_create_read_update_readback', 'stale_card_refused', 'stale_wiki_refused', 'cross_project_argument_refused'); await save();
    if (revokeProject) { await revokeProject(); const denied = await rpc('read_card', { taskId: card.taskId }, true); assert(denied.isError); evidence.checks.push('real_project_revocation_refused'); await save(); }
    plugin.revoke();
    const revoked = await request('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, { Accept: 'application/json, text/event-stream', Authorization: `Bearer ${tokens.access_token}` }); assert.equal(revoked.status, 401);
    evidence.checks.push('oauth_revocation_refused'); evidence.passed = true; await save(); return evidence;
  } finally { plugin.revoke(); plugin.server.close(); plugin.server.closeAllConnections(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw Error();
    const connection = JSON.parse(await readFile(process.argv[2], 'utf8'));
    process.stdout.write(JSON.stringify(await smoke({ connection, evidencePath: process.argv[3] })) + '\n');
  } catch { process.stderr.write('Disposable smoke failed. Inspect its saved evidence and read back the card/wiki before retrying. Use CONNECTION_FILE NEW_EVIDENCE_FILE.\n'); process.exitCode = 1; }
}
