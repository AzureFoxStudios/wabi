import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runRoomsLoad } from './room-load.mjs';

const sites = ['http://fixture-a.invalid', 'http://fixture-b.invalid', 'http://fixture-c.invalid'];
const options = { clients: 2, messages: 1, payloadBytes: 8, deadlineSeconds: 30 };
const rooms = () => ['owned-room-a', 'owned-room-b'].map((channelId, i) => ({
  channelId, tokens: [`private-${i}-one`, `private-${i}-two`],
}));

function runtime(fault = 'none', callbacks = {}) {
  const sockets = [], history = [];
  class Socket extends EventEmitter {
    connect() { queueMicrotask(() => super.emit('connect')); }
    emit(name, payload) {
      if (name === 'join-channel') {
        this.room = payload;
        queueMicrotask(() => super.emit('channel-messages', { channelId: payload, messages: [] }));
      } else if (name === 'message') {
        callbacks.onMessage?.(payload.channelId);
        if (fault === 'stall-first-room' && payload.channelId === 'owned-room-a') return true;
        const id = fault === 'shared-canonical-id' ? 'same-canonical' : `canonical-${history.length}`;
        const message = { ...payload, id };
        history.push(message);
        queueMicrotask(() => {
          const accepted = { channelId: payload.channelId, clientMessageId: payload.clientMessageId, messageId: id };
          for (const peer of sockets) {
            if (peer.room === payload.channelId || fault === 'cross-room-delivery') {
              EventEmitter.prototype.emit.call(peer, 'message', { channelId: payload.channelId, message });
            }
            if (fault === 'cross-room-ack') EventEmitter.prototype.emit.call(peer, 'message-accepted', accepted);
          }
          super.emit('message-accepted', accepted);
        });
      }
      return true;
    }
    disconnect() { this.disconnected = true; }
  }
  return {
    sockets,
    dependencies: {
      socketFactory() { const socket = new Socket(); sockets.push(socket); return socket; },
      historyFetch: async url => {
        const room = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
        return { ok: true, json: async () => {
          callbacks.onHistory?.(room);
          return { messages: fault === 'cross-room-history'
            ? history : history.filter(message => message.channelId === room) };
        } };
      },
      wait: async () => {},
    },
  };
}

async function fixture(fault = 'none', signal) {
  const fake = runtime(fault);
  const receipt = await runRoomsLoad({ sites, rooms: rooms(), options, signal }, fake.dependencies);
  assert.ok(fake.sockets.every(socket => socket.disconnected && socket.eventNames().length === 0));
  assert.ok(receipt.cleanup.allRoomsSettled && receipt.cleanup.disconnectRequestedForAll);
  const encoded = JSON.stringify(receipt);
  for (const hidden of ['private-', 'owned-room-a', 'owned-room-b', 'fixture-a.invalid'])
    assert.ok(!encoded.includes(hidden));
  assert.equal(receipt.executionMode, 'injected_runtime');
  assert.equal(receipt.capacityCertification, false);
  assert.equal(receipt.regionalLocalityTested, false);
  assert.equal(receipt.registeredAccountsMeasured, null);
  assert.equal(receipt.measuredNetworkBytes, null);
  return { receipt, sockets: fake.sockets };
}

test('two concurrent rooms retain separate delivery/history and bounded aggregate metrics', async () => {
  const { receipt } = await fixture();
  assert.equal(receipt.result, 'PASS');
  assert.equal(receipt.roomCount, 2);
  assert.equal(receipt.connectedClients, 4);
  assert.equal(receipt.acknowledgedMessages, 2);
  assert.equal(receipt.expectedDeliveries, 4);
  assert.equal(receipt.observedDeliveries, 4);
  assert.equal(receipt.missingDeliveries, 0);
  assert.deepEqual(receipt.rooms.map(room => room.roomIndex), [0, 1]);
  assert.ok(receipt.rooms.every(room => room.acknowledgedMessages === 1));
});

test('four-room ceiling supports all owned clients without mixing histories', async () => {
  const fake = runtime();
  const dataset = Array.from({ length: 4 }, (_, i) => ({ channelId: `room-${i}`, tokens: [`a-${i}`, `b-${i}`] }));
  const receipt = await runRoomsLoad({ sites, rooms: dataset, options }, fake.dependencies);
  assert.equal(receipt.result, 'PASS');
  assert.equal(receipt.connectedClients, 8);
  assert.equal(receipt.acknowledgedMessages, 4);
  assert.equal(receipt.observedDeliveries, 8);
  assert.ok(fake.sockets.every(socket => socket.disconnected && socket.eventNames().length === 0));
});

test('one stalled room cannot prevent another room from finishing its workload', async () => {
  const stop = new AbortController();
  let stalled = false, completed = false;
  const fake = runtime('stall-first-room', {
    onMessage(room) { if (room === 'owned-room-a') stalled = true; },
    onHistory(room) {
      assert.equal(room, 'owned-room-b');
      assert.ok(stalled);
      completed = true;
      setImmediate(() => stop.abort());
    },
  });
  const fallback = setTimeout(() => stop.abort(), 200);
  let receipt;
  try {
    receipt = await runRoomsLoad({ sites, rooms: rooms(), options, signal: stop.signal }, fake.dependencies);
  } finally {
    clearTimeout(fallback);
  }
  assert.ok(completed);
  assert.equal(receipt.result, 'FAIL');
  assert.equal(receipt.rooms[0].result, 'FAIL');
  assert.equal(receipt.rooms[1].result, 'PASS');
  assert.equal(receipt.acknowledgedMessages, 1);
  assert.ok(fake.sockets.every(socket => socket.disconnected && socket.eventNames().length === 0));
  assert.ok(receipt.cleanup.allRoomsSettled && receipt.cleanup.disconnectRequestedForAll);
});

for (const fault of ['cross-room-delivery', 'cross-room-ack', 'cross-room-history', 'shared-canonical-id']) {
  test(`${fault} cannot pass even when each individual room has valid own messages`, async () => {
    const { receipt } = await fixture(fault);
    assert.equal(receipt.result, 'FAIL');
    if (fault.startsWith('cross-')) assert.ok(receipt.unexpectedRoomEvents > 0);
    else assert.ok(receipt.inconsistentIdentities > 0);
  });
}

test('parent cancellation creates no sockets and settles every room as failed', async () => {
  const stop = new AbortController(); stop.abort();
  const { receipt, sockets } = await fixture('none', stop.signal);
  assert.equal(receipt.result, 'FAIL');
  assert.equal(sockets.length, 0);
  assert.equal(receipt.missingDeliveries, 4);
});

test('cancellation after joining closes already opened sockets and listeners', async () => {
  const fake = runtime(), stop = new AbortController();
  let waits = 0;
  fake.dependencies.wait = async () => { if (++waits === 2) stop.abort(); };
  const receipt = await runRoomsLoad({ sites, rooms: rooms(), options, signal: stop.signal }, fake.dependencies);
  assert.equal(receipt.result, 'FAIL');
  assert.ok(fake.sockets.length > 0);
  assert.ok(fake.sockets.every(socket => socket.disconnected && socket.eventNames().length === 0));
  assert.ok(receipt.cleanup.allRoomsSettled && receipt.cleanup.disconnectRequestedForAll);
});

test('socket factory failures settle all rooms without exposing exception details', async () => {
  const fake = runtime();
  fake.dependencies.socketFactory = () => { throw new Error('private-credential-detail'); };
  const receipt = await runRoomsLoad({ sites, rooms: rooms(), options }, fake.dependencies);
  assert.equal(receipt.result, 'FAIL');
  assert.equal(receipt.expectedDeliveries, 4);
  assert.equal(receipt.missingDeliveries, 4);
  assert.ok(receipt.cleanup.allRoomsSettled && receipt.cleanup.disconnectRequestedForAll);
  assert.ok(!JSON.stringify(receipt).includes('private-credential-detail'));
});

const invalidCases = [
  ['one room', () => ({ rooms: rooms().slice(0, 1) })],
  ['five rooms', () => ({ rooms: Array.from({ length: 5 }, (_, i) => ({ channelId: `room-${i}`, tokens: [`a-${i}`, `b-${i}`] })) })],
  ['duplicate room', () => ({ rooms: [rooms()[0], rooms()[0]] })],
  ['credential reuse', () => ({ rooms: rooms().map(room => ({ ...room, tokens: ['same-a', 'same-b'] })) })],
  ['unknown room field', () => ({ rooms: rooms().map(room => ({ ...room, unexpected: true })) })],
  ['oversized room ID', () => ({ rooms: [{ ...rooms()[0], channelId: 'x'.repeat(129) }, rooms()[1]] })],
  ['aggregate clients', () => ({ options: { ...options, clients: 17 } })],
  ['aggregate messages', () => ({ options: { ...options, messages: 48, deadlineSeconds: 90 } })],
  ['aggregate rate', () => ({ options: { ...options, messagesPerSecond: 11 } })],
  ['sparse endpoints', () => ({ sites: new Array(3) })],
  ['nonstring endpoint', () => ({ sites: [sites[0], [sites[1]], sites[2]] })],
  ['sparse credentials', () => ({ rooms: [{ ...rooms()[0], tokens: new Array(2) }, rooms()[1]] })],
  ['oversized credential list', () => ({ rooms: [{ ...rooms()[0], tokens: Array.from({ length: 33 }, (_, i) => `secret-${i}`) }, rooms()[1]] })],
  ['sparse rooms', () => ({ rooms: new Array(2) })],
];
for (const [name, change] of invalidCases) {
  test(`${name} refuses the entire dataset before creating a socket`, async () => {
    const fake = runtime();
    await assert.rejects(runRoomsLoad({ sites, rooms: rooms(), options, ...change() }, fake.dependencies));
    assert.equal(fake.sockets.length, 0);
  });
}
