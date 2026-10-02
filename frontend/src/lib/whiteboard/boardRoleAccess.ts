import type { WhiteboardPolicy } from './boardTypes';

type DrawingIdentity = {
	highestRole?: string | null;
	roles?: readonly string[] | null;
	isRegistered?: boolean | null;
};

function normalizeRole(role: string): string {
	const normalized = role.trim().toLowerCase();
	return normalized === 'moderator' ? 'mod' : normalized;
}

/** Mirrors the current Authority role for UI affordances; server admission owns writes. */
export function boardRoleAllowsDrawing(
	policy: Pick<WhiteboardPolicy, 'drawRole' | 'drawRoles'> | null | undefined,
	user: DrawingIdentity | null | undefined
): boolean {
	const role = normalizeRole(user?.highestRole || user?.roles?.[0] || '');
	if (role === 'owner') return true;
	switch (policy?.drawRole || 'participants') {
		case 'participants': return true;
		case 'moderators': return role === 'mod' || role === 'admin';
		case 'admins': return role === 'admin';
		case 'owner': return false;
		case 'custom':
			if (!role || role === 'member' && user?.isRegistered === false) return false;
			return (policy?.drawRoles || []).some(allowed => normalizeRole(allowed) === role);
		default: return false;
	}
}
