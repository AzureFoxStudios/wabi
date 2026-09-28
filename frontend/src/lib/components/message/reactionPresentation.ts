import type { User } from '$lib/socket-types';

type ReactionUser = Pick<User, 'id' | 'dbUserId' | 'username'>;

function identityKey(id: string): string {
	return /^\d+$/.test(id) ? `user-${id}` : id;
}

function matchesUser(id: string, user: ReactionUser): boolean {
	const identity = identityKey(id);
	return (Boolean(id && user.id) && identity === identityKey(user.id)) ||
		(user.dbUserId !== undefined && identity === `user-${user.dbUserId}`);
}

/** Resolve only an attested matching identity; absence must never imply "me". */
export function reactionPresentation(
	userIds: string[],
	users: ReactionUser[],
	currentUser: ReactionUser | undefined,
	unknownLabel: string
): { userReacted: boolean; tooltip: string } {
	return {
		userReacted: currentUser !== undefined && userIds.some((id) => matchesUser(id, currentUser)),
		tooltip: userIds.map((id) => {
			const user = users.find((candidate) => matchesUser(id, candidate)) ??
				(currentUser && matchesUser(id, currentUser) ? currentUser : undefined);
			return user?.username || unknownLabel;
		}).join(', ')
	};
}
