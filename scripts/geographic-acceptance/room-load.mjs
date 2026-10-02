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
  for (const key of Object.keys(value)) if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown load option: ${key}`);
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
export function nextSendDelay(previousStart, now, messagesPerSecond) {
  return Math.max(0, previousStart + 1000 / messagesPerSecond - now);
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

function validateAccess(sites, tokens, channelId) {
  if (!Array.isArray(sites) || sites.length !== 3 ||
    !Array.from(sites).every(site => typeof site === 'string' && /^https?:\/\//.test(site)))
    throw new Error('Load requires three explicit disposable endpoints');
  if (!Array.isArray(tokens) || tokens.length < 2 || tokens.length > 32 ||
    Array.from(tokens).some(token => typeof token !== 'string' || !token))
    throw new Error('Load requires disposable account credentials');
  if (typeof channelId !== 'string' || !channelId) throw new Error('Load requires a disposable room');
}

export async function runRoomLoad({ sites, tokens, channelId, options: input, signal: parentSignal },
  { socketFactory = io, historyFetch = fetch, wait = delay } = {}, control = {}) {
  const options = validateOptions(input);
  validateAccess(sites, tokens, channelId);
  const deadline = AbortSignal.timeout(options.deadlineSeconds * 1000);
  const signal = parentSignal ? AbortSignal.any([deadline, parentSignal]) : deadline;
  const sockets = [], records = new Map(), acknowledged = new Set(), listeners = new Set();
  const canonicalIds = control.canonicalIds ?? new Map();
  const correlations = control.correlations ?? new Map();
  let duplicates = 0, inconsistentIdentities = 0, receivedPayloadBytes = 0, sentPayloadBytes = 0;
  let unexpectedRoomEvents = 0, invalidEventPayloads = 0;
  let failed = false, errors = 0, workloadStarted, connectedClients = 0, stage = 'connect';
  const acknowledgmentLatency = [], deliveryLatency = [];
  const runId = randomUUID();
  try {
    for (let i = 0; i < options.clients; i++) {
      signal.throwIfAborted();
      const socket = socketFactory(sites[i % sites.length], {
        auth: { token: tokens[i % tokens.length] }, autoConnect: false,
        transports: ['websocket'], reconnection: false, timeout: 10_000,
      });
      sockets.push(socket);
      const wrongRoom = (payload, nonce) => {
        const correlation = correlations.get(nonce);
        if (!correlation || (payload.channelId === correlation.channelId && channelId === correlation.channelId))
          return false;
        unexpectedRoomEvents++;
        correlation.refuse();
        control.refuse?.();
        return true;
      };
      socket.on('message', payload => {
        const message = payload?.message;
        if (wrongRoom(payload, message?.clientMessageId)) return;
        const record = records.get(message?.clientMessageId);
        if (!record) return;
        if (payload.channelId !== channelId) {
          unexpectedRoomEvents++; record.refuse(); return;
        }
        if (typeof message.id !== 'string' || !message.id ||
          message.text !== record.text || message.type !== 'text') {
          invalidEventPayloads++; record.refuse(); control.refuse?.(); return;
        }
        const prior = canonicalIds.get(message.id);
        if ((prior && prior !== message.clientMessageId) ||
          (record.messageId && record.messageId !== message.id) ||
          (record.received.has(i) && record.received.get(i) !== message.id)) {
          inconsistentIdentities++; record.refuse(); control.refuse?.(); return;
        }
        canonicalIds.set(message.id, message.clientMessageId);
        if (record.received.has(i)) { duplicates++; return; }
        record.received.set(i, message.id);
        receivedPayloadBytes += Buffer.byteLength(JSON.stringify(payload));
        deliveryLatency.push(performance.now() - record.started);
        if (record.messageId && record.messageId !== message.id) inconsistentIdentities++;
        record.check();
      });
      socket.on('message-accepted', payload => {
        if (wrongRoom(payload, payload?.clientMessageId)) return;
        const record = records.get(payload?.clientMessageId);
        if (!record || record.sender !== i) return;
        if (payload.channelId !== channelId) {
          unexpectedRoomEvents++; record.refuse(); return;
        }
        if (typeof payload.messageId !== 'string' || !payload.messageId) {
          invalidEventPayloads++; record.refuse(); control.refuse?.(); return;
        }
        const prior = canonicalIds.get(payload.messageId);
        if ((prior && prior !== payload.clientMessageId) ||
          (record.messageId && record.messageId !== payload.messageId) ||
          [...record.received.values()].some(id => id !== payload.messageId)) {
          inconsistentIdentities++; record.refuse(); control.refuse?.(); return;
        }
        canonicalIds.set(payload.messageId, payload.clientMessageId);
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
      await wait(100, undefined, { signal });
    }
    workloadStarted = performance.now();
    for (let i = 0; i < options.messages; i++) {
      signal.throwIfAborted();
      const nonce = `${runId}:${i}`, sender = i % sockets.length;
      const text = 'x'.repeat(options.payloadBytes);
      const payload = { channelId, text, type: 'text', clientMessageId: nonce };
      const record = { sender, text, started: performance.now(), received: new Map(), messageId: null };
      const complete = new Promise((resolve, reject) => {
        const abort = () => reject(new Error('Load deadline elapsed'));
        const cleanup = () => { signal.removeEventListener('abort', abort); listeners.delete(cleanup); };
        record.refuse = () => { cleanup(); reject(new Error('Correlated event failed validation')); };
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
      correlations.set(nonce, { channelId, refuse: record.refuse });
      sentPayloadBytes += Buffer.byteLength(JSON.stringify(payload));
      stage = 'message_delivery';
      sockets[sender].emit('message', payload);
      // Bounded outstanding work: delivery must settle before scheduling the
      // next message. The requested rate is a ceiling, not claimed throughput.
      await complete;
      // A stalled earlier send cannot accumulate credit for a catch-up burst.
      const waitMs = nextSendDelay(record.started, performance.now(), options.messagesPerSecond);
      if (waitMs > 0) await wait(waitMs, undefined, { signal });
    }
    stage = 'history';
    const response = await historyFetch(`${sites[2]}/api/messages/${encodeURIComponent(channelId)}`, {
      headers: { authorization: `Bearer ${tokens[0]}` }, signal, redirect: 'error',
    });
    if (!response.ok) throw new Error('History verification failed');
    const history = await response.json();
    if (!Array.isArray(history.messages)) throw new Error('Invalid history response');
    const ids = new Set(history.messages?.map(message => message.id));
    if (![...acknowledged].every(id => ids.has(id))) throw new Error('Acknowledged history missing');
    for (const message of history.messages) {
      const nonce = canonicalIds.get(message.id);
      const correlation = correlations.get(nonce);
      if (correlation && correlation.channelId !== channelId) {
        unexpectedRoomEvents++; control.refuse?.();
        throw new Error('Correlated history crossed rooms');
      }
      const record = records.get(nonce);
      if (record && (message.text !== record.text || message.type !== 'text'))
        throw new Error('Acknowledged history content differs');
    }
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
    schemaVersion: 1, result: failed || duplicates || inconsistentIdentities || unexpectedRoomEvents ||
      invalidEventPayloads || acknowledged.size !== options.messages || received !== expected ? 'FAIL' : 'PASS',
    workload: 'bounded single-room canary', configured: options,
    executionMode: socketFactory === io && historyFetch === fetch && wait === delay ? 'network' : 'injected_runtime',
    registeredAccountsMeasured: null, providedAccessCredentials: tokens.length,
    attemptedClients: sockets.length, connectedClients,
    scheduledMessages: records.size, acknowledgedMessages: acknowledged.size,
    expectedDeliveries: expected, observedDeliveries: received, missingDeliveries: Math.max(0, expected - received),
    duplicateEvents: duplicates, inconsistentIdentities, unexpectedRoomEvents, invalidEventPayloads,
    errors, failureStage: failed ? stage : null,
    elapsedMs: elapsedMs === null ? null : Math.round(elapsedMs),
    achievedMessagesPerSecond: elapsedMs ? Math.round(acknowledged.size * 1000 / elapsedMs * 100) / 100 : null,
    acknowledgmentLatencyMs: percentiles(acknowledgmentLatency), deliveryLatencyMs: percentiles(deliveryLatency),
    applicationEnvelopeBytesSent: sentPayloadBytes, applicationEnvelopeBytesReceived: receivedPayloadBytes,
    measuredNetworkBytes: null, mediaParticipantsTested: 0,
    recoveryAndReconnectTested: false, capacityCertification: false,
    cleanup: { ownedSocketCount: sockets.length, disconnectRequestedForAll: true },
  };
}

// A bounded concurrent canary, not a throughput/500k-member certification.
// Validate the entire dataset before creating any socket. Credentials are
// distinct supplied values; this cannot establish distinct account identities.
export async function runRoomsLoad({ sites, rooms, options: input, signal: parentSignal }, runtime) {
  const options = validateOptions(input);
  if (!Array.isArray(rooms) || rooms.length < 2 || rooms.length > 4)
    throw new Error('Load requires two to four disposable rooms');
  if (options.clients * rooms.length > 32 || options.messages * rooms.length > 95 ||
    options.messagesPerSecond * rooms.length > 20)
    throw new Error('Aggregate room load exceeds the canary budget');
  const channels = new Set(), credentials = new Set();
  for (const room of rooms) {
    if (!room || typeof room !== 'object' || Array.isArray(room) ||
      Object.keys(room).some(key => !['channelId', 'tokens'].includes(key)))
      throw new Error('Invalid disposable room configuration');
    validateAccess(sites, room.tokens, room.channelId);
    if (room.channelId.length > 128 || channels.has(room.channelId))
      throw new Error('Disposable rooms must have distinct bounded IDs');
    channels.add(room.channelId);
    for (const token of room.tokens) {
      if (credentials.has(token)) throw new Error('Supply distinct credentials for each room');
      credentials.add(token);
    }
  }
  const stop = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, stop.signal]) : stop.signal;
  const control = { correlations: new Map(), canonicalIds: new Map(), refuse: () => stop.abort() };
  const started = performance.now();
  let results;
  try {
    results = await Promise.allSettled(rooms.map(async room => {
      const receipt = await runRoomLoad({ sites, ...room, options, signal }, runtime, control);
      if (receipt.result !== 'PASS') stop.abort();
      return receipt;
    }));
  } finally {
    stop.abort();
    control.correlations.clear(); control.canonicalIds.clear();
  }
  const receipts = results.map((result, roomIndex) => result.status === 'fulfilled'
    ? { roomIndex, ...result.value }
    : { roomIndex, result: 'FAIL', failureStage: 'harness', errors: 1 });
  const sum = key => receipts.reduce((total, receipt) => total + (receipt[key] ?? 0), 0);
  const elapsedMs = Math.round(performance.now() - started);
  const expectedDeliveries = options.messages * options.clients * rooms.length;
  const observedDeliveries = sum('observedDeliveries');
  return {
    schemaVersion: 1, result: receipts.every(receipt => receipt.result === 'PASS') ? 'PASS' : 'FAIL',
    workload: 'bounded many-room canary', roomCount: rooms.length,
    configured: { perRoom: options, aggregateClients: options.clients * rooms.length,
      aggregateMessages: options.messages * rooms.length,
      aggregateMessagesPerSecondCeiling: options.messagesPerSecond * rooms.length },
    executionMode: receipts.some(receipt => receipt.executionMode === 'injected_runtime') ? 'injected_runtime' :
      receipts.every(receipt => receipt.executionMode === 'network') ? 'network' : 'unknown',
    providedAccessCredentials: credentials.size, registeredAccountsMeasured: null,
    connectedClients: sum('connectedClients'), scheduledMessages: sum('scheduledMessages'),
    acknowledgedMessages: sum('acknowledgedMessages'), expectedDeliveries,
    observedDeliveries, missingDeliveries: Math.max(0, expectedDeliveries - observedDeliveries),
    duplicateEvents: sum('duplicateEvents'), inconsistentIdentities: sum('inconsistentIdentities'),
    unexpectedRoomEvents: sum('unexpectedRoomEvents'), invalidEventPayloads: sum('invalidEventPayloads'),
    applicationEnvelopeBytesSent: sum('applicationEnvelopeBytesSent'),
    applicationEnvelopeBytesReceived: sum('applicationEnvelopeBytesReceived'), elapsedMs,
    measuredNetworkBytes: null, mediaParticipantsTested: 0,
    recoveryAndReconnectTested: false, regionalLocalityTested: false, capacityCertification: false,
    rooms: receipts,
    cleanup: { allRoomsSettled: true,
      disconnectRequestedForAll: receipts.every(receipt => receipt.cleanup?.disconnectRequestedForAll === true) },
  };
}
