import { describe, test, expect } from 'bun:test';
import { MessageDeliveryTracker, parseMessageAcceptance, parseMessageFailure, UNCONFIRMED_MESSAGE, isOwnMessage, isSameMessageIdentity } from './messageDelivery';

const key = { channelId: 'channel', clientMessageId: 'intent' };
const receipt = { ...key, messageId: 'msg_123', timestamp: 123 };
function fixture() {
  let next = 0;
  const timers = new Map<number, () => void>();
  const tracker = new MessageDeliveryTracker(10, ((fn: () => void) => { timers.set(++next, fn); return next; }) as any,
    ((id: number) => { timers.delete(id); }) as any);
  return { tracker, timers, expire: () => [...timers.values()].forEach(fn => fn()) };
}
describe('message delivery receipts', () => {
	 test('another sender cannot replace local intent by reusing its client ID', () => {
		 const local = { id: 'optimistic:a', clientMessageId: 'a', userId: 'user-1' };
		 expect(isSameMessageIdentity(local, { ...local, id: 'msg_other', userId: 'user-2' })).toBe(false);
		 expect(isSameMessageIdentity(local, { ...local, id: 'msg_own' })).toBe(true);
		 expect(isSameMessageIdentity({ clientMessageId: 'a' }, { clientMessageId: 'a' })).toBe(false);
		 expect(isOwnMessage(local, { id: 'socket', dbUserId: 1 })).toBe(true);
		 expect(isOwnMessage({ ...local, senderStableId: 'user-2' }, { id: 'user-1' })).toBe(false);
	 });
  test('only complete correlated authoritative receipts can confirm delivery', () => {
    expect(parseMessageAcceptance(receipt)).toEqual(receipt);
    for (const invalid of [null, {}, { ...receipt, messageId: '' }, { ...receipt, messageId: 'optimistic:fake' },
      { ...receipt, timestamp: Infinity }, { ...receipt, timestamp: undefined }, { ...receipt, clientMessageId: ' ' }]) {
      expect(parseMessageAcceptance(invalid)).toBeNull();
    }
  });
  test('unclassified/uncertain failures never promise a safe retry', () => {
    expect(parseMessageFailure({ ...key, error: 'raw storage internals' })?.error).toBe(UNCONFIRMED_MESSAGE);
    expect(parseMessageFailure({ ...key, outcome: 'unknown', error: 'secret' })?.error).toBe(UNCONFIRMED_MESSAGE);
    expect(parseMessageFailure({ ...key, outcome: 'rejected', error: 'Access denied' })?.error).toBe('Not sent: Access denied');
    expect(parseMessageFailure({ channelId: 'channel' })).toBeNull();
  });
  test('acceptance/error settlement cancels the deadline and cleans up once', () => {
    const { tracker, expire, timers } = fixture(); const socket = {}; let unknown = 0, clean = 0;
    tracker.start(socket, key, () => unknown++, () => clean++);
    tracker.settle(socket, { ...key, channelId: 'other' });
    expect(tracker.has(socket, key)).toBe(true);
    tracker.settle(socket, key); tracker.settle(socket, key); expire();
    expect([unknown, clean, timers.size]).toEqual([0, 1, 0]);
  });
  test('timeouts and disconnects resolve once, never wait indefinitely', () => {
    const { tracker, expire } = fixture(); const socket = {}; let unknown = 0;
    tracker.start(socket, key, () => unknown++); expire(); tracker.unconfirm(socket); expire();
    expect(unknown).toBe(1); expect(tracker.has(socket, key)).toBe(false);
    tracker.start(socket, { ...key, clientMessageId: 'next' }, () => unknown++);
    tracker.unconfirm(socket); expire(); expect(unknown).toBe(2);
  });
  test('old socket receipts cannot settle a replacement socket attempt', () => {
    const { tracker, expire } = fixture(); const old = {}, next = {}; let unknown = 0;
    tracker.start(next, key, () => unknown++); tracker.settle(old, key); expect(tracker.has(next, key)).toBe(true);
    expire(); expect(unknown).toBe(1);
  });
  test('explicit session retirement cancels without updating a later account', () => {
    const { tracker, expire } = fixture(); let unknown = 0, clean = 0;
    const cancel = tracker.start({}, key, () => unknown++, () => clean++);
    cancel(); expire(); cancel(); expect([unknown, clean]).toEqual([0,1]);
  });
  test('duplicate tracker registration cannot overwrite pending ownership', () => {
    const { tracker, expire } = fixture(); const socket = {}; let unknown = 0;
    tracker.start(socket, key, () => unknown++);
    expect(() => tracker.start(socket, key, () => unknown += 10)).toThrow();
    expire(); expect(unknown).toBe(1);
  });
});
