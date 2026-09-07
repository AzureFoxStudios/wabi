import { expect, test } from 'bun:test';
import { requestScreenShareAdmission } from './screenShareAdmission';

class SocketFixture {
  id = 'connection'; connected = true;
  listeners = new Map<string, Set<(data: any) => void>>();
  sent: any[] = [];
  on(event: string, fn: (data: any) => void) { const set = this.listeners.get(event) ?? new Set(); set.add(fn); this.listeners.set(event, set); return this; }
  off(event: string, fn: (data: any) => void) { this.listeners.get(event)?.delete(fn); return this; }
  emit(event: string, data: any) { this.sent.push([event, data]); return this; }
  receive(event: string, data?: any) { for (const fn of [...this.listeners.get(event) ?? []]) fn(data); }
  count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}
test('screen admission requires the correlated audience and cleans up its waiter', async () => {
  const socket = new SocketFixture();
  const controller = new AbortController();
  let done = false;
  const pending = requestScreenShareAdmission(socket as any, { requestId: 'current', channelId: 'group' }, controller.signal).then(() => { done = true; });
  socket.receive('screen-share-targets', { requestId: 'old', channelId: 'group', targets: [] });
  await Promise.resolve(); expect(done).toBe(false);
  socket.receive('screen-share-targets', { requestId: 'current', channelId: 'group', targets: [] });
  await pending; expect(done).toBe(true); expect(socket.count()).toBe(0);
});
test('denial, disconnect, timeout, cancellation and malformed replies are never success', async () => {
  for (const mode of ['denied', 'disconnect', 'timeout', 'abort', 'malformed']) {
    const socket = new SocketFixture(); const controller = new AbortController();
    const pending = requestScreenShareAdmission(socket as any, { requestId: mode }, controller.signal, 5).catch(error => error);
    if (mode === 'denied') socket.receive('screen-share-error', { requestId: mode, error: 'Not allowed' });
    if (mode === 'disconnect') socket.receive('disconnect');
    if (mode === 'abort') controller.abort();
    if (mode === 'malformed') socket.receive('screen-share-targets', { requestId: mode });
    expect(await pending).toBeInstanceOf(Error); expect(socket.count()).toBe(0);
  }
});
