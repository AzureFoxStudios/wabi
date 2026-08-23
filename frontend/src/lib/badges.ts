//
// badges.ts — single source for badge rendering decisions.
//
// Role-derived badges come from `user.highestRole`; assignable badges come
// from the server's `user_badges` projection (`user.badges`). Tone names map
// 1:1 onto the `.role-inline-badge.tone-*` palette in ml-badges.css.
//
import type { User, UserBadge } from './socket-types';

export type BadgeTone = 'owner' | 'admin' | 'mod' | 'default';

export interface ResolvedBadge {
	kind: 'role' | 'custom';
	id: string;
	label: string;
	tone: BadgeTone;
	icon?: string;
}

/** Client mirror of the server's BADGE_CATALOG — used until the live
 *  catalog arrives via the `badge-catalog` socket event. */
export const FALLBACK_BADGE_CATALOG: UserBadge[] = [
	{ id: 'founder', icon: '👑', label: 'Founder' },
	{ id: 'bug-hunter', icon: '🐛', label: 'Bug Hunter' },
	{ id: 'artist', icon: '🎨', label: 'Artist' },
	{ id: 'contributor', icon: '🛠️', label: 'Contributor' },
	{ id: 'supporter', icon: '💜', label: 'Supporter' },
	{ id: 'mod-star', icon: '⭐', label: 'Star Mod' },
	{ id: 'event-winner', icon: '🏆', label: 'Event Winner' },
	{ id: 'early-adopter', icon: '🚀', label: 'Early Adopter' }
];

const ROLE_LABELS: Record<string, string> = {
	owner: 'Owner',
	admin: 'Admin',
	mod: 'Mod',
	moderator: 'Mod'
};

const ROLE_TONES: Record<string, BadgeTone> = {
	owner: 'owner',
	admin: 'admin',
	mod: 'mod',
	moderator: 'mod'
};

export function roleBadgeLabel(user: User | undefined | null): string | null {
	const role = user?.highestRole?.toLowerCase();
	return role ? ROLE_LABELS[role] ?? null : null;
}

export function roleBadgeTone(user: User | undefined | null): BadgeTone {
	const role = user?.highestRole?.toLowerCase();
	return role ? ROLE_TONES[role] ?? 'default' : 'default';
}

/** Full badge row for a user: role badge first, then assignable badges. */
export function resolvedBadges(user: User | undefined | null): ResolvedBadge[] {
	if (!user) return [];
	const out: ResolvedBadge[] = [];
	const roleLabel = roleBadgeLabel(user);
	if (roleLabel) {
		out.push({ kind: 'role', id: `role:${roleLabel}`, label: roleLabel, tone: roleBadgeTone(user) });
	}
	for (const b of user.badges ?? []) {
		out.push({ kind: 'custom', id: `badge:${b.id}`, label: b.label || b.id, tone: 'default', icon: b.icon });
	}
	return out;
}
