import type { FriendRequest, FriendsSnapshot } from './api/friends';

export type FriendshipRelation =
	| { kind: 'friend' }
	| { kind: 'incoming'; request: FriendRequest }
	| { kind: 'outgoing'; request: FriendRequest }
	| { kind: 'none' };

export function canFriendUser(user: { dbUserId?: number; isRegistered?: boolean; isBot?: boolean } | null | undefined): boolean {
	return typeof user?.dbUserId === 'number' && Number.isSafeInteger(user.dbUserId) && user.dbUserId > 0 &&
		user.isRegistered !== false && user.isBot !== true;
}

export function friendshipRelation(snapshot: FriendsSnapshot, userId: number | null | undefined): FriendshipRelation {
	if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) return { kind: 'none' };
	if (snapshot.friends.some((person) => person.user_id === userId)) return { kind: 'friend' };
	const incoming = snapshot.incoming.find((request) => request.user_id === userId);
	if (incoming) return { kind: 'incoming', request: incoming };
	const outgoing = snapshot.outgoing.find((request) => request.user_id === userId);
	if (outgoing) return { kind: 'outgoing', request: outgoing };
	return { kind: 'none' };
}
