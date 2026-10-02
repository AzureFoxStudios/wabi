// Bounded workload against an existing disposable room supplied by its owner.
// No credentials, content, or endpoint addresses are returned in the receipt.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
const { io } = require('socket.io-client');

export function validateOptions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid load configuration');
  const defaults = { clients: 6, messages: 20, payloadBytes: 512, messagesPerSecond: 2, deadlineSeconds: 90 };
  const ceilings = { clients: 32, messages: 95, payloadBytes: 4096, messagesPerSecond: 20, deadlineSeconds: 180 };
  for (const key of Object.keys(value)) if (!(key in defaults)) throw new Error(`Unknown load option: ${key}`);
  const options = { ...defaults, ...value };
  for (const [key, number] of Object.entries(options)) {
    if (!Number.isInteger(number) || number < 1 || number > ceilings[key]) throw new Error(`Invalid load option: ${key}`);
  }
  if (options.clients < 2) throw new Error('Load requires at least two clients');
  if (options.messages / options.messagesPerSecond + options.clients / 10 + 15 > options.deadlineSeconds)
    throw new Error('Load deadline cannot accommodate the configured schedule');
  return options;
}
export function percentiles(values) {
  if (!values.length) return { p50: null, p95: null, p99: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => Math.round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] * 100) / 100;
  return { p50: at(.5), p95: at(.95), p99: at(.99), max: at(1) };
}
function event(socket, name, signal, action) {
  return new Promise((resolve, reject) => {
    const finish = (error, payload) => {
      socket.off(name, ok); socket.off('connect_error', fail); socket.off('join-error', fail);
      signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve(payload);
    };
    const ok = payload => finish(null, payload);
    const fail = () => finish(new Error('Socket admission failed'));
    const abort = () => finish(new Error('Load deadline elapsed'));
    socket.once(name, ok); socket.once('connect_error', fail); socket.once('join-error', fail);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else action?.();
  });
}

export async function runRoomLoad({ sites, tokens, channelId, options: input, signal: parentSignal }) {
  const options = validateOptions(input);
  if (!Array.isArray(sites) || sites.length !== 3 || !sites.every(site => /^https?:\/\//.test(site)))
    throw new Error('Load requires three explicit disposable endpoints');
  if (!Array.isArray(tokens) || tokens.length < 2 || tokens.some(token => typeof token !== 'string' || !token))
    throw new Error('Load requires disposable account credentials');
  if (typeof channelId !== 'string' || !channelId) throw new Error('Load requires a disposable room');
  const deadline = AbortSignal.timeout(options.deadlineSeconds * 1000);
  const signal = parentSignal ? AbortSignal.any([deadline, parentSignal]) : deadline;
  const sockets = [], records = new Map(), acknowledged = new Set(), listeners = new Set();
  let duplicates = 0, inconsistentIdentities = 0, receivedPayloadBytes = 0, sentPayloadBytes = 0;
  let failed = false, errors = 0, workloadStarted, connectedClients = 0, stage = 'connect';
  const acknowledgmentLatency = [], deliveryLatency = [];
  const runId = randomUUID();
  try {
    for (let i = 0; i < options.clients; i++) {
      signal.throwIfAborted();
      const socket = io(sites[i % sites.length], {
        auth: { token: tokens[i % tokens.length] }, autoConnect: false,
        transports: ['websocket'], reconnection: false, timeout: 10_000,
      });
      sockets.push(socket);
      socket.on('message', payload => {
        const message = payload?.message;
        const record = records.get(message?.clientMessageId);
        if (!record) return;
        if (record.received.has(i)) { duplicates++; return; }
        record.received.set(i, message.id);
        receivedPayloadBytes += Buffer.byteLength(JSON.stringify(payload));
        deliveryLatency.push(performance.now() - record.started);
        if (record.messageId && record.messageId !== message.id) inconsistentIdentities++;
        record.check();
      });
      socket.on('message-accepted', payload => {
        const record = records.get(payload?.clientMessageId);
        if (!record || record.sender !== i) return;
        if (record.messageId) { duplicates++; return; }
        record.messageId = payload.messageId;
        acknowledged.add(payload.messageId);
        acknowledgmentLatency.push(performance.now() - record.started);
        for (const deliveredId of record.received.values())
          if (deliveredId !== payload.messageId) inconsistentIdentities++;
        record.check();
      });
      stage = 'connect';
      await event(socket, 'connect', signal, () => socket.connect());
      connectedClients++;
      stage = 'join';
      const joined = await event(socket, 'channel-messages', signal, () => socket.emit('join-channel', channelId));
      if (joined?.channelId !== channelId) throw new Error('Room admission mismatch');
      await delay(100, undefined, { signal });
    }
    workloadStarted = performance.now();
    for (let i = 0; i < options.messages; i++) {
      signal.throwIfAborted();
      const nonce = `${runId}:${i}`, sender = i % sockets.length;
      const text = 'x'.repeat(options.payloadBytes);
      const payload = { channelId, text, type: 'text', clientMessageId: nonce };
      const record = { sender, started: performance.now(), received: new Map(), messageId: null };
      const complete = new Promise((resolve, reject) => {
        const abort = () => reject(new Error('Load deadline elapsed'));
        const cleanup = () => { signal.removeEventListener('abort', abort); listeners.delete(cleanup); };
        listeners.add(cleanup);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        record.check = () => {
          if (record.messageId && record.received.size === sockets.length) {
            cleanup(); resolve();
          }
        };
      });
      records.set(nonce, record);
      sentPayloadBytes += Buffer.byteLength(JSON.stringify(payload));
      stage = 'message_delivery';
      sockets[sender].emit('message', payload);
      // Bounded outstanding work: delivery must settle before scheduling the
      // next message. The requested rate is a ceiling, not claimed throughput.
      await complete;
      const nextAt = workloadStarted + (i + 1) * 1000 / options.messagesPerSecond;
      if (nextAt > performance.now()) await delay(nextAt - performance.now(), undefined, { signal });
    }
    stage = 'history';
    const response = await fetch(`${sites[2]}/api/messages/${encodeURIComponent(channelId)}`, {
      headers: { authorization: `Bearer ${tokens[0]}` }, signal, redirect: 'error',
    });
    if (!response.ok) throw new Error('History verification failed');
    const history = await response.json();
    const ids = new Set(history.messages?.map(message => message.id));
    if (![...acknowledged].every(id => ids.has(id))) throw new Error('Acknowledged history missing');
  } catch {
    failed = true; errors++;
  } finally {
    for (const cleanup of [...listeners]) cleanup();
    for (const socket of sockets) { socket.disconnect(); socket.removeAllListeners(); }
  }
  const elapsedMs = workloadStarted ? performance.now() - workloadStarted : null;
  const received = [...records.values()].reduce((sum, record) => sum + record.received.size, 0);
  const expected = options.messages * options.clients;
  return {
    schemaVersion: 1, result: failed || duplicates || inconsistentIdentities || received !== expected ? 'FAIL' : 'PASS',
    workload: 'bounded single-room canary', configured: options,
    registeredAccountsMeasured: null, providedAccessCredentials: tokens.length,
    attemptedClients: sockets.length, connectedClients,
    scheduledMessages: records.size, acknowledgedMessages: acknowledged.size,
    expectedDeliveries: expected, observedDeliveries: received, missingDeliveries: Math.max(0, expected - received),
    duplicateEvents: duplicates, inconsistentIdentities, errors, failureStage: failed ? stage : null,
    elapsedMs: elapsedMs === null ? null : Math.round(elapsedMs),
    achievedMessagesPerSecond: elapsedMs ? Math.round(acknowledged.size * 1000 / elapsedMs * 100) / 100 : null,
    acknowledgmentLatencyMs: percentiles(acknowledgmentLatency), deliveryLatencyMs: percentiles(deliveryLatency),
    applicationEnvelopeBytesSent: sentPayloadBytes, applicationEnvelopeBytesReceived: receivedPayloadBytes,
    measuredNetworkBytes: null, mediaParticipantsTested: 0,
    recoveryAndReconnectTested: false, capacityCertification: false,
    cleanup: { ownedSocketCount: sockets.length, disconnectRequestedForAll: true },
  };
}
