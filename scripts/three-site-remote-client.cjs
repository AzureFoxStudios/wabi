#!/usr/bin/env node
// Disposable field client using Wabi's existing Socket.IO bundle and native
// WebSocket. Credentials arrive on stdin; no remote package install is needed.
// This is protocol evidence, not desktop, browser, media or reconnect acceptance.
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');

async function run(q) {
  const { io } = require(q.clientBundle);
  assert.equal(typeof WebSocket, 'function', 'Remote Node needs native WebSocket');
  const origin = new URL(q.origin);
  assert.ok(['http:', 'https:'].includes(origin.protocol));
  assert.ok(!origin.username && !origin.password && !origin.search && !origin.hash);
  assert.ok(origin.pathname === '/');
  const request = async (path, { method = 'GET', body, token } = {}) => {
    const response = await fetch(q.origin + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.ok(response.ok, `Remote request ${method} ${path}: HTTP ${response.status}`);
    return response;
  };
  const started = performance.now();
  const login = await (await request('/api/auth/login', { method: 'POST', body: q.credentials })).json();
  const token = login.accessToken;
  const historyPath = '/api/messages/' + q.channelId;
  const history = await (await request(historyPath, { token })).json();
  assert.ok(history.messages.some(item => item.id === q.expectedMessageId));
  const asset = Buffer.from(await (await request(q.assetPath)).arrayBuffer());
  const sent = await (await request('/api/messages', { method: 'POST', token,
    body: { channel_id: q.channelId, content: 'Remote-site disposable canary', message_type: 'text' },
  })).json();
  const socket = io(q.origin, { auth: { token }, transports: ['websocket'],
    reconnection: false, autoConnect: false, timeout: 15_000 });
  const pending = new Set();
  const wait = (event, predicate = () => true) => new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(event, receive);
      socket.off('connect_error', failed);
      socket.off('auth-failed', authFailed);
      socket.off('auth-required', authFailed);
      socket.off('join-error', authFailed);
      socket.off('message-error', messageFailed);
      pending.delete(cleanup);
    };
    const receive = payload => {
      if (predicate(payload)) { cleanup(); resolve(payload); }
    };
    const failed = () => { cleanup(); reject(new Error(`Remote ${event}: connection refused`)); };
    const authFailed = () => { cleanup(); reject(new Error(`Remote ${event}: admission refused`)); };
    const messageFailed = payload => {
      if (event === 'message' || event === 'message-accepted') {
        cleanup(); reject(new Error(`Remote ${event}: message refused (${payload?.code ?? 'unknown'})`));
      }
    };
    pending.add(cleanup);
    socket.on(event, receive);
    socket.on('connect_error', failed);
    socket.on('auth-failed', authFailed);
    socket.on('auth-required', authFailed);
    socket.on('join-error', authFailed);
    socket.on('message-error', messageFailed);
    timer = setTimeout(() => { cleanup(); reject(new Error(`Remote ${event} timed out`)); }, 15_000);
  });
  try {
    const connected = wait('connect');
    socket.connect();
    await connected;
    const initialized = wait('init');
    socket.emit('join', q.credentials.username);
    await initialized;
    const joined = wait('channel-messages', payload => payload?.channelId === q.channelId);
    socket.emit('join-channel', q.channelId);
    assert.ok((await joined).messages.some(item => item.id === q.expectedMessageId));
    const clientMessageId = 'remote-field-' + randomUUID();
    const accepted = wait('message-accepted', payload => payload?.clientMessageId === clientMessageId);
    const delivered = wait('message', payload => payload?.message?.clientMessageId === clientMessageId);
    socket.emit('message', { channelId: q.channelId, text: 'Remote WebSocket disposable canary',
      type: 'text', clientMessageId });
    const [ack, delivery] = await Promise.all([accepted, delivered]);
    assert.equal(ack.messageId, delivery.message.id);
    const durable = await (await request(historyPath, { token })).json();
    assert.ok(durable.messages.some(item => item.id === ack.messageId));
    return {
      messageId: sent.id, websocketMessageId: ack.messageId,
      websocketAuthenticated: true, websocketHistoryMatched: true,
      websocketAcceptanceMatchedDelivery: true,
      assetSha256: createHash('sha256').update(asset).digest('hex'), assetBytes: asset.length,
      elapsedMs: Math.round(performance.now() - started),
    };
  } finally {
    for (const cleanup of [...pending]) cleanup();
    socket.disconnect();
  }
}

(async () => {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    assert.ok(input.length <= 65_536, 'Bounded field input');
  }
  console.log(JSON.stringify(await run(JSON.parse(input))));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
