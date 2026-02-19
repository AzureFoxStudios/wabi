#!/usr/bin/env node

const ORIGIN = (process.env.WABI_ORIGIN_URL || 'http://localhost:8080').replace(/\/+$/, '');
const TOKEN = process.env.WABI_AUTH_TOKEN || process.env.WABI_ADMIN_TOKEN || '';
const GATEWAY_KEY = process.env.WABI_MEDIA_GATEWAY_KEY || process.env.MEDIA_GATEWAY_KEY || '';
const CHANNEL_ID = process.env.WABI_TEST_CHANNEL_ID || 'voice';

function fail(message, detail = '') {
  console.error(`[srt-phase2-check] FAIL: ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

function log(message) {
  console.log(`[srt-phase2-check] ${message}`);
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${ORIGIN}${path}`, options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

if (!TOKEN) {
  fail('Missing auth token. Set WABI_AUTH_TOKEN (or WABI_ADMIN_TOKEN).');
}

log(`Origin: ${ORIGIN}`);

const runtime = await fetchJson('/api/media/runtime', {
  method: 'GET',
  headers: { 'Content-Type': 'application/json' }
});
if (!runtime.response.ok) {
  fail('Could not read /api/media/runtime', JSON.stringify(runtime.body, null, 2));
}
log(`Runtime gateway configured: ${Boolean(runtime.body?.media?.gateway?.configured)}`);
log(`Runtime gateway healthy: ${Boolean(runtime.body?.media?.gateway?.healthy)}`);

const create = await fetchJson('/api/media/gateway/session', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${TOKEN}`
  },
  body: JSON.stringify({ channelId: CHANNEL_ID, kind: 'voice' })
});
if (!create.response.ok) {
  fail('Could not create gateway session', JSON.stringify(create.body, null, 2));
}
const sessionId = create.body?.session?.sessionId;
if (!sessionId) {
  fail('Create response missing sessionId', JSON.stringify(create.body, null, 2));
}
log(`Created session: ${sessionId}`);

const list = await fetchJson('/api/media/gateway/sessions', {
  method: 'GET',
  headers: { Authorization: `Bearer ${TOKEN}` }
});
if (!list.response.ok) {
  fail('Could not list gateway sessions', JSON.stringify(list.body, null, 2));
}
const hasSession = Array.isArray(list.body?.sessions) && list.body.sessions.some((s) => s.sessionId === sessionId);
if (!hasSession) {
  fail('Created session not found in session list', JSON.stringify(list.body, null, 2));
}
log('Session list contains created session');

if (GATEWAY_KEY) {
  const control = await fetchJson('/api/media/gateway/control/sessions', {
    method: 'GET',
    headers: { 'X-Media-Gateway-Key': GATEWAY_KEY }
  });
  if (!control.response.ok) {
    fail('Gateway control session endpoint failed', JSON.stringify(control.body, null, 2));
  }
  log(`Control sessions visible: ${Array.isArray(control.body?.sessions) ? control.body.sessions.length : 0}`);
}

const close = await fetchJson(`/api/media/gateway/session/${encodeURIComponent(sessionId)}/close`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}` }
});
if (!close.response.ok) {
  fail('Could not close gateway session', JSON.stringify(close.body, null, 2));
}
log('Closed session successfully');
log('PASS');
