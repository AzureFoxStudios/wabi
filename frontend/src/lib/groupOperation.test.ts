import { describe, expect, test } from 'bun:test';
import { requestGroupOperation } from './groupOperation';

class FakeSocket {
  id = 'socket-one'; connected = true;
  listeners = new Map<string, Set<(...args: any[]) => void>>();
  sent: [string, any][] = [];
  on(event: string, fn: (...args: any[]) => void) { const set = this.listeners.get(event) ?? new Set(); set.add(fn); this.listeners.set(event, set); return this; }
  off(event: string, fn: (...args: any[]) => void) { this.listeners.get(event)?.delete(fn); return this; }
  emit(event: string, data: any) { this.sent.push([event, data]); return this; }
  receive(event: string, data?: any) { for (const fn of [...this.listeners.get(event) ?? []]) fn(data); }
  get listenerCount() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
}
const data = { requestId: 'request-one', channelId: 'group-test', expectedRevision: '1', userId: 'user-2' };
const reply = { ...data, ok: true, operation: 'add', membershipRevision: '2', channel: {
  id: 'group-test', type: 'group', name: 'Project', ownerId: 'user-1', membershipRevision: '2', members: ['user-1', 'user-2']
} };

describe('confirmed group commands', () => {
  test('emit, roster broadcast and unrelated receipts are not success', async () => {
    const socket = new FakeSocket(); let done = false;
    const pending = requestGroupOperation(socket as any, 'add', data, () => true).then(result => { done = true; return result; });
    expect(socket.sent).toEqual([['add-group-member', data]]);
    socket.receive('group-membership-updated', reply);
    socket.receive('group-operation-result', { ...reply, requestId: 'other' });
    socket.receive('group-operation-result', { ...reply, operation: 'kick' });
    socket.receive('group-operation-result', { ...reply, channelId: 'other' });
    await Promise.resolve(); expect(done).toBe(false);
    socket.receive('group-operation-result', reply);
    expect((await pending).membershipRevision).toBe(reply.membershipRevision); expect(socket.listenerCount).toBe(0);
  });
  test('conflict and persistence errors preserve the server explanation', async () => {
    for (const code of ['CONFLICT', 'PERSISTENCE_FAILED', 'FORBIDDEN']) {
      const socket = new FakeSocket();
      const result = requestGroupOperation(socket as any, 'add', data, () => true).catch(error => error);
      socket.receive('group-operation-result', { ...reply, ok: false, code, error: 'Refresh before retrying' });
      expect(await result).toMatchObject({ code, message: 'Refresh before retrying' }); expect(socket.listenerCount).toBe(0);
    }
  });
  test('timeout, disconnect, abort, session change and malformed success are honestly uncertain', async () => {
    for (const outcome of ['timeout', 'disconnect', 'abort', 'session', 'socket-id', 'malformed']) {
      const socket = new FakeSocket(), controller = new AbortController(); let current = true;
      const result = requestGroupOperation(socket as any, 'add', data, () => current, controller.signal, 5).catch(error => error);
      if (outcome === 'disconnect') socket.receive('disconnect');
      if (outcome === 'abort') controller.abort();
      if (outcome === 'session') { current = false; socket.receive('group-operation-result', reply); }
      if (outcome === 'socket-id') { socket.id = 'replacement'; socket.receive('group-operation-result', reply); }
      if (outcome === 'malformed') socket.receive('group-operation-result', { ...reply, membershipRevision: 2 });
      expect(await result).toMatchObject({ code: 'OUTCOME_UNKNOWN' });
      socket.receive('group-operation-result', reply); // late success cannot settle a new intent
      expect(socket.listenerCount).toBe(0);
    }
  });
  test('offline and already-cancelled intent never enter Socket.IO buffering', async () => {
    const socket = new FakeSocket(); socket.connected = false;
    await expect(requestGroupOperation(socket as any, 'add', data, () => true)).rejects.toMatchObject({ code: 'OFFLINE' });
    socket.connected = true;
    const controller = new AbortController(); controller.abort();
    await expect(requestGroupOperation(socket as any, 'add', data, () => true, controller.signal)).rejects.toThrow();
    expect(socket.sent).toEqual([]); expect(socket.listenerCount).toBe(0);
  });
  test('own removal before a leave receipt is valid, including retirement', async () => {
    const socket = new FakeSocket();
    const pending = requestGroupOperation(socket as any, 'leave', data, () => true);
    socket.receive('group-removed', { channelId: data.channelId, membershipRevision: '2' });
    socket.receive('group-operation-result', { ...reply, operation: 'leave', channel: null });
    expect((await pending).channel).toBeNull(); expect(socket.listenerCount).toBe(0);
  });
});
