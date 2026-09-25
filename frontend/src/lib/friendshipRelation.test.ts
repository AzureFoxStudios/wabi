import { describe, expect, test } from 'bun:test';
import type { FriendsSnapshot } from './api/friends';
import { canFriendUser, friendshipRelation } from './friendshipRelation';

const person = (user_id: number) => ({
	user_id,
	username: `User ${user_id}`,
	handle: null,
	profile_picture: null,
	color: '#6366f1',
	status: 'offline'
});

describe('friendship relation', () => {
	const snapshot: FriendsSnapshot = {
		friends: [person(1)],
		incoming: [{ ...person(2), id: 'friend-2-9', created_at: 1 }],
		outgoing: [{ ...person(3), id: 'friend-3-9', created_at: 2 }]
	};

	test('maps each server state to its available action', () => {
		expect(friendshipRelation(snapshot, 1).kind).toBe('friend');
		expect(friendshipRelation(snapshot, 2)).toMatchObject({ kind: 'incoming', request: { id: 'friend-2-9' } });
		expect(friendshipRelation(snapshot, 3)).toMatchObject({ kind: 'outgoing', request: { id: 'friend-3-9' } });
		expect(friendshipRelation(snapshot, 4).kind).toBe('none');
	});

	test('does not treat missing or invalid account ids as friends', () => {
		expect(friendshipRelation(snapshot, undefined).kind).toBe('none');
		expect(friendshipRelation(snapshot, 0).kind).toBe('none');
		expect(friendshipRelation(snapshot, 1.5).kind).toBe('none');
	});

	test('offers friend actions only for registered people, never guests or bots', () => {
		expect(canFriendUser({ dbUserId: 9, isRegistered: true, isBot: false })).toBe(true);
		expect(canFriendUser({ dbUserId: 9, isBot: true })).toBe(false);
		expect(canFriendUser({ dbUserId: 9, isRegistered: false })).toBe(false);
		expect(canFriendUser({ dbUserId: 0 })).toBe(false);
		expect(canFriendUser(null)).toBe(false);
	});
});
