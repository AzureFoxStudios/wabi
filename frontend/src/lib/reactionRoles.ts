/**
 * Role reactions: staff link an emoji on a message to a listed role. Reacting with that emoji
 * gives the role, removing the reaction takes it back. The server decides; this file holds what
 * the app shows. Only roles members may pick themselves can be linked.
 */
import { writable } from 'svelte/store';

export interface ReactionRoleRule {
	emojiId: string;
	roleId: string;
}
export interface ReactionRoleMessage {
	channelId: string;
	rules: ReactionRoleRule[];
}

/** Message id → its role reactions, for the rooms this person can open. */
export const reactionRoleMessages = writable<Record<string, ReactionRoleMessage>>({});

export function normalizeReactionRoles(raw: unknown): Record<string, ReactionRoleMessage> {
	if (!raw || typeof raw !== 'object') return {};
	const out: Record<string, ReactionRoleMessage> = {};
	for (const [messageId, value] of Object.entries(raw as Record<string, unknown>)) {
		const entry = value as { channelId?: unknown; rules?: unknown } | null;
		if (!entry || typeof entry.channelId !== 'string' || !Array.isArray(entry.rules)) continue;
		const rules = entry.rules.filter(
			(rule): rule is ReactionRoleRule =>
				Boolean(rule) && typeof (rule as ReactionRoleRule).emojiId === 'string' && typeof (rule as ReactionRoleRule).roleId === 'string'
		);
		if (rules.length > 0) out[messageId] = { channelId: entry.channelId, rules };
	}
	return out;
}

export interface ReactionEntry {
	emojiId: string;
	userIds: string[];
	/** The role this emoji gives on this message, when it gives one. */
	roleName?: string;
}

/**
 * The reactions to draw under a message. An emoji that gives a role is always there, even with
 * nobody on it yet, so a newcomer has something to press; those come first, in the order staff
 * set. A rule whose role is unknown here (removed, or not loaded) draws as an ordinary reaction.
 */
export function reactionEntries(
	reactions: Record<string, string[]> | undefined,
	rules: ReactionRoleRule[] | undefined,
	roles: { id: string; name: string }[]
): ReactionEntry[] {
	const present = Object.entries(reactions ?? {}).filter(([, userIds]) => Array.isArray(userIds));
	const byEmoji = new Map(present);
	const entries: ReactionEntry[] = [];
	const linked = new Set<string>();
	for (const rule of rules ?? []) {
		const role = roles.find((candidate) => candidate.id === rule.roleId);
		if (!role || linked.has(rule.emojiId)) continue;
		linked.add(rule.emojiId);
		entries.push({ emojiId: rule.emojiId, userIds: byEmoji.get(rule.emojiId) ?? [], roleName: role.name });
	}
	for (const [emojiId, userIds] of present) {
		if (!linked.has(emojiId) && userIds.length > 0) entries.push({ emojiId, userIds });
	}
	return entries;
}

/** What stops a set of rules from being saved, as a message key, or null when it can be. */
export function reactionRulesProblem(rules: ReactionRoleRule[]): 'incomplete' | 'duplicate' | null {
	if (rules.some((rule) => !rule.emojiId || !rule.roleId)) return 'incomplete';
	if (new Set(rules.map((rule) => rule.emojiId)).size !== rules.length) return 'duplicate';
	return null;
}
