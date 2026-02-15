import type { User } from './socket-types';

export type ModerationPermission =
	| 'user.force_logout'
	| 'user.timeout'
	| 'user.ban'
	| 'user.shadow_restrict';

const ROLE_GRANTS: Record<string, ModerationPermission[]> = {
	owner: ['user.force_logout', 'user.timeout', 'user.ban', 'user.shadow_restrict'],
	admin: ['user.force_logout', 'user.timeout', 'user.ban', 'user.shadow_restrict'],
	mod: ['user.force_logout', 'user.timeout', 'user.shadow_restrict']
};

const ROLE_RANK: Record<string, number> = {
	owner: 100,
	admin: 90,
	mod: 70,
	contributor: 40,
	viewer: 20,
	member: 10,
	guest: 0
};

export function getEffectivePermissions(user: User | null | undefined): Set<ModerationPermission> {
	const permissions = new Set<ModerationPermission>();
	if (!user?.roles) return permissions;

	for (const role of user.roles) {
		for (const grant of ROLE_GRANTS[role] || []) {
			permissions.add(grant);
		}
	}

	return permissions;
}

export function hasModerationPermission(user: User | null | undefined, permission: ModerationPermission): boolean {
	return getEffectivePermissions(user).has(permission);
}

export function canModerateTarget(
	actor: User | null | undefined,
	target: User | null | undefined,
	permission: ModerationPermission
): boolean {
	if (!actor || !target) return false;
	if (actor.id === target.id) return false;
	if (!hasModerationPermission(actor, permission)) return false;

	const actorRank = ROLE_RANK[actor.highestRole || 'member'] || 0;
	const targetRank = ROLE_RANK[target.highestRole || 'member'] || 0;
	return actorRank > targetRank;
}
