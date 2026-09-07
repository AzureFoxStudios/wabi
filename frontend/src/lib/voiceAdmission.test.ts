import { describe, expect, test } from 'bun:test';
import { requestVoiceAdmission, requestGroupCallAnswer, requestGroupCallStart, requestGroupCallReadmission } from './voiceAdmission';

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
const tick = () => Promise.resolve();

describe('voice admission', () => {
  test('readmission pins original membership and waits without ringing new members', async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    const pending = requestGroupCallReadmission(socket as any, 'group', '18446744073709551615', async () => {}, controller.signal);
    const result = pending.catch(error => error);
    await tick();
    const [event, payload] = socket.sent[0];
    expect(event).toBe('call-initiate');
    expect(payload.rejoin).toBe(true);
    expect(payload.membershipRevision).toBe('18446744073709551615');
    controller.abort();
    socket.receive('group-call-started', { ...payload, established: true });
    expect((await result).name).toBe('AbortError');
    expect(socket.listenerCount).toBe(0);
  });
  test('group start waits for its own ACK and surfaces the server reason', async () => {
    const socket = new FakeSocket();
    let done = false;
    const result = requestGroupCallStart(socket as any, 'group', false, async () => {})
      .then(() => { done = true; return null; }, error => error);
    await tick();
    const [event, data] = socket.sent[0];
    expect(event).toBe('call-initiate');
    socket.receive('group-call-started', undefined);
    socket.receive('group-call-started', { ...data, requestId: 'old' });
    socket.receive('group-call-participant-joined', data);
    await tick(); expect(done).toBe(false);
    socket.receive('call-error', { ...data, message: 'No group members are currently connected' });
    expect((await result).message).toBe('No group members are currently connected');
    expect(socket.listenerCount).toBe(0);
  });
  test('synchronous transport failure cleans every admission listener', async () => {
    const socket = new FakeSocket();
    socket.emit = () => { throw new Error('Transport unavailable'); };
    await expect(requestGroupCallStart(socket as any, 'group', false, async () => {})).rejects.toThrow('Transport unavailable');
    expect(socket.listenerCount).toBe(0);
  });
  test('group answer commits consent before the caller can start media', async () => {
    const socket = new FakeSocket(); let ready = false;
    const pending = requestGroupCallAnswer(socket as any, 'group', 'user-2', false, async () => {}).then(() => { ready = true; });
    await tick();
    const [event, payload] = socket.sent[0];
    expect(event).toBe('call-answer'); expect(payload.callerId).toBe('user-2');
    socket.receive('group-call-participant-joined', payload);
    await tick(); expect(ready).toBe(false);
    socket.receive('group-call-admitted', payload);
    await pending;
    expect(ready).toBe(true); expect(socket.listenerCount).toBe(0);
  });
  test('waits for membership then correlated server admission, not a roster echo', async () => {
    const socket = new FakeSocket();
    let membership!: () => void;
    let done = false;
    const pending = requestVoiceAdmission(socket as any, 'voice', false, () => new Promise<void>(r => membership = r)).then(() => { done = true; });
    expect(socket.sent).toHaveLength(0);
    membership(); await tick();
    const [event, payload] = socket.sent[0];
    expect(event).toBe('voice-channel-join');
    socket.receive('voice-channel-state', { channelId: 'voice' });
    socket.receive('voice-channel-admitted', { ...payload, requestId: 'stale' });
    await tick(); expect(done).toBe(false);
    socket.receive('voice-channel-admitted', payload);
    await pending;
    expect(done).toBe(true); expect(socket.listenerCount).toBe(0);
  });
  test('membership denial never emits a voice request', async () => {
    const socket = new FakeSocket();
    await expect(requestVoiceAdmission(socket as any, 'private', false, async () => { throw new Error('Forbidden'); })).rejects.toThrow('Forbidden');
    expect(socket.sent).toHaveLength(0);
  });
  test('socket replacement during membership lookup cannot join a new connection', async () => {
    const socket = new FakeSocket();
    await expect(requestVoiceAdmission(socket as any, 'voice', false, async () => { socket.id = 'replacement'; })).rejects.toThrow('Connection changed');
    expect(socket.sent).toHaveLength(0);
  });
  test('denial, disconnect, cancellation and timeout reject and clean waiters', async () => {
    for (const outcome of ['denial', 'disconnect', 'cancel', 'timeout']) {
      const socket = new FakeSocket(); const controller = new AbortController();
      const result = requestVoiceAdmission(socket as any, 'voice', true, async () => {}, controller.signal, 5);
      const failure = result.catch(error => error);
      await tick();
      expect(socket.sent[0][0]).toBe('voice-channel-subscribe');
      if (outcome === 'denial') socket.receive('voice-channel-error', { ...socket.sent[0][1], error: 'Forbidden' });
      if (outcome === 'disconnect') socket.receive('disconnect');
      if (outcome === 'cancel') controller.abort();
      expect(await failure).toBeInstanceOf(Error);
      expect(socket.listenerCount).toBe(0);
    }
  });
});
