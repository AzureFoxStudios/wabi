type ProfileIdentity = { id?: string; dbUserId?: number | null };

function accountIdentity(user: ProfileIdentity): { account: string | null; valid: boolean } {
	const fromId = typeof user.id === 'string' && /^user-[1-9][0-9]*$/.test(user.id) ? user.id : null;
	const fromField = Number.isSafeInteger(user.dbUserId) && (user.dbUserId as number) > 0 ? `user-${user.dbUserId}` : null;
	return { account: fromField ?? fromId, valid: !(fromField && fromId && fromField !== fromId) };
}

/** Display names are not identity. Conflicting account IDs cannot fall back to a socket match. */
export function isCurrentUserProfile(
	incoming: ProfileIdentity,
	current: ProfileIdentity | null,
	socketId?: string
): boolean {
	if (!current || !incoming?.id) return false;
	const source = accountIdentity(incoming);
	const self = accountIdentity(current);
	if (!source.valid || !self.valid) return false;
	if (source.account && self.account) return source.account === self.account;
	// A provisional/legacy self view can be socket-owned before a stable account
	// row arrives. Never use matching usernames or an unrelated socket ID here.
	return !!socketId && current.id === socketId && incoming.id === socketId;
}
