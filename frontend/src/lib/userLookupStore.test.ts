import { expect, test } from 'bun:test';
import { get } from 'svelte/store';
// Import the derived store first. It must not initialize sockets, auth, calling
// or the command barrel just to read an empty user index (browser TDZ regression).
import { userLookup } from './userLookupStore';
import { users } from './presenceIdentity';

test('identity lookup binds to leaf state without the socket/command graph', () => {
  const original = get(users);
  try {
    users.set([{ id: 'user-7', dbUserId: 7, username: 'Member' } as any]);
    expect(get(userLookup).byDbId.get(7)?.username).toBe('Member');
    users.set([]);
    expect(get(userLookup).byDbId.size).toBe(0);
  } finally { users.set(original); }
});
