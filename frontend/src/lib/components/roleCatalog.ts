// The pure half of the member role menu: which catalog roles are offered.
// It imports nothing, so tests can load it without the socket and call stores.

/** A role the viewer may grant/revoke from the member menu. */
export interface AssignableRoleEntry {
	roleName: string;
	displayName: string;
	priority: number;
}

/**
 * Lore roles = catalog roles that come from the Lore role store, i.e. every
 * role except the moderation (`mod`) and guest shells. The server sends a
 * `capabilities` list for each of them and never for the two shells. The list
 * may be empty: read access comes from channel membership, so a read-only
 * role has no capability and must still be assignable. The client role store
 * strips unknown fields, so when no entry carries `capabilities` (store not
 * yet refreshed) fall back to the same split on role names.
 */
export function selectLoreRoles(
	defs: Array<{ roleName: string; displayName: string; priority: number; capabilities?: string[] }> | null | undefined
): AssignableRoleEntry[] {
	if (!defs || defs.length === 0) return [];
	const withCaps = defs.filter((d) => Array.isArray(d.capabilities));
	const lore = withCaps.length > 0
		? withCaps
		: defs.filter((d) => d.roleName !== 'mod' && d.roleName !== 'guest');
	return [...lore]
		.map((d) => ({ roleName: d.roleName, displayName: d.displayName, priority: d.priority ?? 0 }))
		.sort((a, b) => b.priority - a.priority);
}

/**
 * Full offerable set for the member menu: lore roles (minus owner/member/
 * guest — owner is never grantable here, member is covered by reset) plus
 * `mod` for moderation. Falls back to the classic four when the catalog has
 * not loaded yet so the menu never goes empty.
 */
export function selectAssignableRoles(
	defs: Array<{ roleName: string; displayName: string; priority: number; capabilities?: string[] }> | null | undefined,
	rolePriority?: Record<string, number>
): AssignableRoleEntry[] {
	const excluded = new Set(['owner', 'member', 'guest']);
	if (!defs || defs.length === 0) {
		return [
			{ roleName: 'admin', displayName: 'Admin', priority: 90 },
			{ roleName: 'mod', displayName: 'Moderator', priority: 70 },
			{ roleName: 'developer', displayName: 'Developer', priority: 60 },
			{ roleName: 'artist', displayName: 'Artist', priority: 50 }
		];
	}
	const priorityOf = (roleName: string, fallback: number): number =>
		rolePriority?.[roleName] ?? fallback;
	const lore = selectLoreRoles(defs).filter((r) => !excluded.has(r.roleName));
	const offerable = [...lore];
	if (!offerable.some((r) => r.roleName === 'mod')) {
		const modDef = defs.find((d) => d.roleName === 'mod');
		offerable.push({
			roleName: 'mod',
			displayName: modDef?.displayName || 'Moderator',
			priority: modDef?.priority ?? priorityOf('mod', 70)
		});
	}
	return offerable.sort((a, b) => b.priority - a.priority);
}
