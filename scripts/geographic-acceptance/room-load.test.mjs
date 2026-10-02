import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runRoomLoad, validateOptions, percentiles, nextSendDelay } from './room-load.mjs';

test('resource and schedule limits refuse invalid workload before network access', () => {
  for (const value of [null, [], { unknown: 1 }, { clients: 33 }, { clients: 1 },
    { messages: 96 }, { payloadBytes: 4097 }, { messagesPerSecond: 21 },
    { deadlineSeconds: 181 }, { messages: 90, messagesPerSecond: 1, deadlineSeconds: 20 },
    { clients: 2.5 }, { messages: 0 }, { constructor: 1 }, { toString: 1 },
    JSON.parse('{"__proto__":1}')]) assert.throws(() => validateOptions(value));
});
test('latency report retains absent measurements and nearest-rank tail latency', () => {
  assert.deepEqual(percentiles([]), { p50: null, p95: null, p99: null, max: null });
  const values = [100, ...Array.from({ length: 99 }, (_, i) => i + 1)];
  assert.deepEqual(percentiles(values), { p50: 50, p95: 95, p99: 99, max: 100 });
  assert.equal(values[0], 100);
});
test('pacing after a stalled send does not accumulate credit for a catch-up burst', () => {
  assert.equal(nextSendDelay(0, 10_000, 20), 0);
  assert.equal(nextSendDelay(10_000, 10_001, 20), 49);
  assert.equal(nextSendDelay(10_050, 10_090, 20), 10);
  assert.equal(nextSendDelay(10_100, 10_151, 20), 0);
});
test('already aborted run reports failure without opening sockets or exposing credentials', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runRoomLoad({
    sites: ['http://127.0.0.1:1', 'http://127.0.0.1:2', 'http://127.0.0.1:3'],
    tokens: ['fixture-secret-one', 'fixture-secret-two'], channelId: 'fixture-room',
    options: { clients: 2, messages: 1, deadlineSeconds: 30 }, signal: controller.signal,
  });
  assert.equal(result.result, 'FAIL');
  assert.equal(result.connectedClients, 0);
  assert.equal(result.cleanup.ownedSocketCount, 0);
  assert.equal(result.capacityCertification, false);
  assert.equal(result.registeredAccountsMeasured, null);
  assert.equal(result.measuredNetworkBytes, null);
  assert.ok(!JSON.stringify(result).includes('fixture-secret'));
});

// Exercise the real canary callbacks with bounded, synchronous fake transports.
// These are harness regressions, not Wabi/network/capacity acceptance.
async function fixture(fault = 'none') {
  const sockets = [], history = [];
  class Socket extends EventEmitter {
    connect() { queueMicrotask(() => super.emit('connect')); }
    emit(name, payload) {
      if (name === 'join-channel') {
        queueMicrotask(() => super.emit('channel-messages', { channelId: payload, messages: [] }));
      } else if (name === 'message') {
        const id = fault === 'repeated-id' ? 'canonical-one' :
          fault === 'nonstring-id' ? history.length + 1 :
          fault === 'empty-id' ? '' : `canonical-${history.length}`;
        const message = { ...payload, id };
        history.push(message);
        queueMicrotask(() => {
          const accepted = () => super.emit('message-accepted', {
            channelId: fault === 'wrong-ack-room' ? 'foreign-room' : payload.channelId,
            clientMessageId: payload.clientMessageId, messageId: id,
          });
          if (fault === 'ack-first') accepted();
          for (const peer of sockets) {
            const delivery = {
              channelId: fault === 'wrong-delivery-room' ? 'foreign-room' : payload.channelId,
              message: fault === 'changed-text' ? { ...message, text: 'changed' } :
                fault === 'wrong-type' ? { ...message, type: 'image' } :
                fault === 'delivery-id-mismatch' ? { ...message, id: `other-${id}` } : message,
            };
            EventEmitter.prototype.emit.call(peer, 'message', delivery);
            if (fault === 'duplicate-delivery') EventEmitter.prototype.emit.call(peer, 'message', delivery);
          }
          if (fault !== 'ack-first') accepted();
          if (fault === 'duplicate-ack') accepted();
        });
      }
      return true;
    }
    disconnect() { this.disconnected = true; }
  }
  const receipt = await runRoomLoad({
    sites: ['http://fixture-a.invalid', 'http://fixture-b.invalid', 'http://fixture-c.invalid'],
    tokens: ['private-fixture-one', 'private-fixture-two'], channelId: 'owned-room',
    options: { clients: 2, messages: 2, payloadBytes: 8, deadlineSeconds: 30 },
  }, {
    socketFactory() { const socket = new Socket(); sockets.push(socket); return socket; },
    historyFetch: async () => ({ ok: true, json: async () => ({
      messages: fault === 'missing-history' ? history.slice(0, -1) :
        fault === 'changed-history' ? history.map(message => ({ ...message, text: 'changed' })) : history,
    }) }),
    wait: async () => {},
  });
  assert.ok(sockets.every(socket => socket.disconnected && socket.eventNames().length === 0));
  assert.ok(!JSON.stringify(receipt).includes('private-fixture'));
  assert.ok(!JSON.stringify(receipt).includes('foreign-room'));
  assert.equal(receipt.capacityCertification, false);
  assert.equal(receipt.executionMode, 'injected_runtime');
  return receipt;
}

test('valid distinct canonical IDs and exact room/content pass the harness fixture', async () => {
  const receipt = await fixture();
  assert.equal(receipt.result, 'PASS');
  assert.equal(receipt.acknowledgedMessages, 2);
  assert.equal(receipt.observedDeliveries, 4);
});

test('acceptance arriving before delivery retains the same valid identity', async () => {
  assert.equal((await fixture('ack-first')).result, 'PASS');
});

for (const fault of ['wrong-delivery-room', 'wrong-ack-room', 'repeated-id', 'changed-text',
  'nonstring-id', 'empty-id', 'wrong-type', 'delivery-id-mismatch', 'duplicate-delivery',
  'duplicate-ack', 'missing-history', 'changed-history']) {
  test(`correlated ${fault} cannot produce a passing load receipt`, async () => {
    const receipt = await fixture(fault);
    assert.equal(receipt.result, 'FAIL');
    if (fault.startsWith('wrong-') && fault.endsWith('-room')) assert.ok(receipt.unexpectedRoomEvents > 0);
    if (['empty-id', 'nonstring-id', 'changed-text', 'wrong-type'].includes(fault))
      assert.ok(receipt.invalidEventPayloads > 0);
    if (['repeated-id', 'delivery-id-mismatch'].includes(fault)) assert.ok(receipt.inconsistentIdentities > 0);
    if (fault.startsWith('duplicate-')) assert.ok(receipt.duplicateEvents > 0);
    if (fault.endsWith('-history')) assert.equal(receipt.failureStage, 'history');
  });
}
