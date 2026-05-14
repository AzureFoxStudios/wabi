import { derived } from 'svelte/store';
import type { Readable } from 'svelte/store';
import type { User, Channel } from './socket-types';
import { users } from './socket-manager';

/*
 * userLookupStore.ts
 *
 * Centralized user lookup derived from the $users store.
 * Eliminates per-component Map rebuilds in MessageList, Chat,
 * PinnedMessages, and PinnedMessagesModal.
 *
 * Usage in a component:
 *   import { userLookup } from '$lib/socket';
 *   $: author = getUserByMessageAuthor(message, $userLookup);
 */

export interface UserLookup {
	bySocketId: Map<string, User>;
	byDbId: Map<number, User>;
	byUsername: Map<string, User>;
	byHandle: Map<string, User>;
	byMentionValue: Map<string, User>;
}

function buildUserLookup(users: User[]): UserLookup {
	const bySocketId = new Map<string, User>();
	const byDbId = new Map<number, User>();
	const byUsername = new Map<string, User>();
	const byHandle = new Map<string, User>();
	const byMentionValue = new Map<string, User>();

	for (const user of users) {
		if (user.id) {
			bySocketId.set(user.id, user);
		}
		if (typeof user.dbUserId === 'number') {
			byDbId.set(user.dbUserId, user);
		}
		const usernameKey = user.username?.trim().toLowerCase();
		if (usernameKey) {
			byUsername.set(usernameKey, user);
			byMentionValue.set(usernameKey, user);
		}
		const handleKey = user.handle?.trim().toLowerCase();
		if (handleKey) {
			byHandle.set(handleKey, user);
			byMentionValue.set(handleKey, user);
		}
	}

	return { bySocketId, byDbId, byUsername, byHandle, byMentionValue };
}

export function createUserLookupStore(usersStore: Readable<User[]>): Readable<UserLookup> {
	return derived(usersStore, ($users) => buildUserLookup($users));
}

/* Pre-bound store for direct subscription */
export const userLookup = createUserLookupStore(users);

/* ---------- Standalone helpers (pass $userLookup) ---------- */

export function getUserByUsername(username: string, lookup: UserLookup): User | undefined {
	const normalized = username.trim().toLowerCase();
	return lookup.byUsername.get(normalized) ?? lookup.byHandle.get(normalized);
}

export function getUserByIdentityId(userId: string | undefined, lookup: UserLookup): User | undefined {
	if (!userId) return undefined;
	if (userId.startsWith('user-')) {
		const dbUserId = Number(userId.substring(5));
		if (!Number.isNaN(dbUserId)) {
			const byDbId = lookup.byDbId.get(dbUserId);
			if (byDbId) return byDbId;
		}
	}
	return lookup.bySocketId.get(userId);
}

export function getUserByMessageAuthor(
	message: { userId?: string; user?: string },
	lookup: UserLookup
): User | undefined {
	return getUserByIdentityId(message.userId, lookup) ?? getUserByUsername(message.user ?? '', lookup);
}

export function getUserByMentionValue(mentionToken: string, lookup: UserLookup): User | undefined {
	const normalized = mentionToken.trim().replace(/^@/, '').toLowerCase();
	if (!normalized || normalized === 'everyone' || normalized === 'here' || normalized === 'all') {
		return undefined;
	}
	return lookup.byMentionValue.get(normalized);
}

export function getDMOtherUser(
	channel: Channel | undefined,
	currentUser: User | null,
	lookup: UserLookup
): User | null {
	if (!channel || channel.type !== 'dm') return null;
	if (channel.otherUser) return channel.otherUser;

	const myStableId = currentUser?.dbUserId ? `user-${currentUser.dbUserId}` : currentUser?.id;
	const otherStableId = (channel.members || []).find((id: string) => id !== myStableId);
	if (!otherStableId) return null;

	if (otherStableId.startsWith('user-')) {
		const dbId = parseInt(otherStableId.substring(5), 10);
		if (!Number.isNaN(dbId)) {
			return lookup.byDbId.get(dbId) ?? null;
		}
	}
	return lookup.bySocketId.get(otherStableId) ?? null;
}

export function getCurrentReactionIdentityIds(currentUser: User | null): string[] {
	const ids: string[] = [];
	if (currentUser?.id) ids.push(currentUser.id);
	if (currentUser?.dbUserId) ids.push(`user-${currentUser.dbUserId}`);
	return ids;
}

export function isOwnMessage(message: { user?: string; userId?: string }, currentUser: { username?: string; id?: string; dbUserId?: number } | null): boolean {
	if (!currentUser) return false;
	if (message.user === currentUser.username) return true;
	if (message.userId === currentUser.id) return true;
	if (currentUser.dbUserId !== undefined && message.userId === `user-${currentUser.dbUserId}`) return true;
	return false;
}

export function getReactionTooltip(userIds: string[], lookup: UserLookup): string {
	return userIds
		.map((id) => getReactionUsername(id, lookup))
		.filter(Boolean)
		.join(', ');
}

export function resolvePayTargetUser(identifier: string, users: User[]): User | null {
	const normalized = identifier.trim().replace(/^@+/, '').toLowerCase();
	if (!normalized) return null;
	return users.find((candidate) => candidate.username.toLowerCase() === normalized) ?? null;
}
