import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRoomLoad, validateOptions, percentiles } from './room-load.mjs';

test('resource and schedule limits refuse invalid workload before network access', () => {
  for (const value of [null, [], { unknown: 1 }, { clients: 33 }, { clients: 1 },
    { messages: 96 }, { payloadBytes: 4097 }, { messagesPerSecond: 21 },
    { deadlineSeconds: 181 }, { messages: 90, messagesPerSecond: 1, deadlineSeconds: 20 },
    { clients: 2.5 }, { messages: 0 }]) assert.throws(() => validateOptions(value));
});
test('latency report retains absent measurements and nearest-rank tail latency', () => {
  assert.deepEqual(percentiles([]), { p50: null, p95: null, p99: null, max: null });
  const values = [100, ...Array.from({ length: 99 }, (_, i) => i + 1)];
  assert.deepEqual(percentiles(values), { p50: 50, p95: 95, p99: 99, max: 100 });
  assert.equal(values[0], 100);
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
