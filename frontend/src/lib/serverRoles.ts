/**
 * The server's one role list and who holds each role.
 *
 * The staff ranks (owner, admin, moderator) come first and are fixed; they live with the account
 * (`highestRole`) and are given in People. Every other role is listed here: a person can hold
 * several, staff give or take any of them, and a member may pick up the ones marked for
 * self-choice in Welcome. Rooms can require one (the role editor, "Rooms that need a role").
 *
 * Storage and endpoints keep their earlier "community role" names so existing servers and older
 * apps keep working; only the wording changed.
 */
import { get, writable } from 'svelte/store';
import { getAuthToken } from '$lib/authSession';
import { getServerUrl } from '$lib/serverUrl';
import { normalizeReactionRoles, reactionRoleMessages, type ReactionRoleRule } from '$lib/reactionRoles';

export interface ListedRole {
	id: string;
	name: string;
	description: string;
	/** Members may give themselves this role in Welcome; otherwise only staff give it. */
	selfAssignable: boolean;
}

export const listedRoles = writable<ListedRole[]>([]);
/** Member account id → ids of the listed roles they hold. */
export const roleHolders = writable<Record<string, string[]>>({});

export function normalizeListedRoles(raw: unknown): ListedRole[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((role): role is Record<string, unknown> => Boolean(role) && typeof role === 'object' && typeof (role as { id?: unknown }).id === 'string')
		.map((role) => ({
			id: role.id as string,
			name: typeof role.name === 'string' ? role.name : '',
			description: typeof role.description === 'string' ? role.description : '',
			// A server from before the flag sends none: all its roles were self-chosen.
			selfAssignable: role.selfAssignable !== false
		}));
}

/** The listed roles a member holds, in the list's order. Unknown ids (a removed role) are dropped. */
export function rolesHeldBy(
	roles: ListedRole[],
	holders: Record<string, string[]>,
	userId: number | string | null | undefined
): ListedRole[] {
	if (userId === null || userId === undefined) return [];
	const held = new Set(holders[String(userId)] ?? []);
	return roles.filter((role) => held.has(role.id));
}

/** The next role ids for a member after ticking or unticking one role. */
export function toggledRoleIds(current: string[], roleId: string, on: boolean): string[] {
	const without = current.filter((id) => id !== roleId);
	return on ? [...without, roleId] : without;
}

async function request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
	const server = getServerUrl();
	const token = getAuthToken(server);
	if (!token) throw new Error('Sign in again to see roles.');
	const response = await fetch(`${server}/api/server-center${path}`, {
		...init,
		credentials: 'include',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) }
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error((body as { error?: string }).error || `Roles request failed (${response.status}).`);
	return body as Record<string, unknown>;
}

let refreshing: Promise<void> | null = null;
/** Load the list and its holders. Guests and older servers get an empty list, not an error. */
export function refreshRoleHolders(): Promise<void> {
	if (refreshing) return refreshing;
	const server = getServerUrl();
	refreshing = (async () => {
		try {
			const body = await request('/role-holders');
			if (server !== getServerUrl()) return;
			listedRoles.set(normalizeListedRoles(body.roles));
			const holders = body.holders && typeof body.holders === 'object' ? (body.holders as Record<string, unknown>) : {};
			roleHolders.set(
				Object.fromEntries(
					Object.entries(holders).map(([userId, ids]) => [userId, Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []])
				)
			);
			reactionRoleMessages.set(normalizeReactionRoles(body.reactionRoles));
		} catch {
			if (server === getServerUrl()) {
				listedRoles.set([]);
				roleHolders.set({});
				reactionRoleMessages.set({});
			}
		} finally {
			refreshing = null;
		}
	})();
	return refreshing;
}

/** Staff: set exactly which listed roles a member holds. */
export async function setMemberRoles(userId: number, roleIds: string[]): Promise<void> {
	await request(`/members/${encodeURIComponent(String(userId))}/roles`, { method: 'PUT', body: JSON.stringify({ roleIds }) });
	roleHolders.update((holders) => {
		const next = { ...holders };
		if (roleIds.length) next[String(userId)] = roleIds;
		else delete next[String(userId)];
		return next;
	});
}

export function heldRoleIds(userId: number | string): string[] {
	return get(roleHolders)[String(userId)] ?? [];
}

/** Staff: set which emoji on a message give which role. An empty list removes them. */
export async function saveReactionRoles(messageId: string, channelId: string, rules: ReactionRoleRule[]): Promise<void> {
	await request(`/reaction-roles/${encodeURIComponent(messageId)}`, { method: 'PUT', body: JSON.stringify({ channelId, rules }) });
	reactionRoleMessages.update((current) => {
		const next = { ...current };
		if (rules.length) next[messageId] = { channelId, rules };
		else delete next[messageId];
		return next;
	});
}
