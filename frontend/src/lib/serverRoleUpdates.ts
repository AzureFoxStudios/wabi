export type ServerRole = 'owner' | 'admin' | 'mod' | 'member' | 'guest';
type RoleUser = { id: string; dbUserId?: number | null; highestRole?: string; roles?: string[] };
export type ServerRoleUpdate = { dbUserId: number; highestRole: ServerRole };

export function parseServerRoleUpdate(payload: unknown): ServerRoleUpdate | null {
	if (!payload || typeof payload !== 'object') return null;
	const { dbUserId, highestRole } = payload as Record<string, unknown>;
	if (!Number.isSafeInteger(dbUserId) || (dbUserId as number) <= 0 ||
		!['owner', 'admin', 'mod', 'member', 'guest'].includes(highestRole as string)) return null;
	return { dbUserId: dbUserId as number, highestRole: highestRole as ServerRole };
}

/** Update only existing identities. A role broadcast does not imply online presence. */
export function applyServerRoleUpdate<T extends RoleUser>(user: T, update: ServerRoleUpdate): T {
	const matches = user.dbUserId != null ? user.dbUserId === update.dbUserId : user.id === `user-${update.dbUserId}`;
	return matches ? { ...user, highestRole: update.highestRole, roles: [update.highestRole] } : user;
}
