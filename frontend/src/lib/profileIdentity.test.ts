import { expect, test } from 'bun:test';
import { isCurrentUserProfile } from './profileIdentity';

test('profile updates match the stable account across different transport IDs', () => {
	expect(isCurrentUserProfile({ id: 'user-1', dbUserId: 1 }, { id: 'old-socket', dbUserId: 1 }, 'new-socket')).toBe(true);
	expect(isCurrentUserProfile({ id: 'user-1' }, { id: 'user-1', dbUserId: 1 }, 'socket')).toBe(true);
});

test('another account or conflicting identity cannot overwrite the current profile', () => {
	expect(isCurrentUserProfile({ id: 'user-2', dbUserId: 2 }, { id: 'user-1', dbUserId: 1 }, 'socket')).toBe(false);
	expect(isCurrentUserProfile({ id: 'user-1', dbUserId: 2 }, { id: 'user-1', dbUserId: 1 }, 'socket')).toBe(false);
	expect(isCurrentUserProfile({ id: 'socket', dbUserId: 2 }, { id: 'socket', dbUserId: 1 }, 'socket')).toBe(false);
	expect(isCurrentUserProfile({ id: 'same-name' }, { id: 'same-name' }, 'socket')).toBe(false);
	expect(isCurrentUserProfile({ id: 'user-1', dbUserId: 1 }, null, 'socket')).toBe(false);
});

test('provisional self profiles require the exact current socket identity', () => {
	expect(isCurrentUserProfile({ id: 'self-socket' }, { id: 'self-socket' }, 'self-socket')).toBe(true);
	expect(isCurrentUserProfile({ id: 'old-socket' }, { id: 'old-socket' }, 'new-socket')).toBe(false);
	expect(isCurrentUserProfile({ id: 'other-socket' }, { id: 'self-socket' }, 'self-socket')).toBe(false);
});
