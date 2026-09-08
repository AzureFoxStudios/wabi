import { expect, test } from 'bun:test';
import { resolveDmOtherUser } from './dmConversations';
import type { Channel, User } from './socket-types';

const self = { id: 'session-self', dbUserId: 1, username: 'self' } as User;
const other = { id: 'user-2', dbUserId: 2, username: 'Offline member' } as User;
test('DM identity uses authoritative member summaries before the directory is loaded', () => {
  const channel = { id: 'dm-1-2', type: 'dm', members: ['user-1', 'user-2'], memberUsers: [self, other] } as Channel;
  expect(resolveDmOtherUser(channel, self)?.username).toBe('Offline member');
  expect(resolveDmOtherUser({ ...channel, members: ['session-self', '2'] }, self)?.dbUserId).toBe(2);
});
test('missing DM participants remain unresolved, never inferred from message authors', () => {
  const channel = { id: 'dm-orphan', type: 'dm', members: ['user-1'] } as Channel;
  expect(resolveDmOtherUser(channel, self)).toBeNull();
});
