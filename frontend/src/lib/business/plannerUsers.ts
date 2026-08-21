import { writable, derived } from 'svelte/store';
import { browser } from '$app/environment';
import { getServerUrl } from '$lib/serverUrl';
import { getAuthToken } from '$lib/authSession';
import { isLocalMockApiMode, getLocalMockUsers } from '$lib/localMockApi';

/**
 * Shared directory of registered users for ALL planner surfaces
 * (kanban cards, calendar pills, TaskPanel rows, signature chips).
 *
 * Replaces the three independent `/api/users` fetches that previously lived in
 * KanbanBoardImpl / TaskPanel (and nowhere else). One fetch per session,
 * shared by reference; assignee lookups are O(1) via the derived Map.
 */

export interface PlannerDirectoryUser {
	user_id: number;
	username: string;
	profile_picture?: string;
	color: string;
}

export const plannerDirectoryUsers = writable<PlannerDirectoryUser[]>([]);

let fetchStarted = false;

/** Idempotent: safe to call from every surface's onMount. */
export function ensurePlannerDirectory(): void {
	if (!browser || fetchStarted) return;
	fetchStarted = true;

	if (isLocalMockApiMode()) {
		plannerDirectoryUsers.set(getLocalMockUsers() as PlannerDirectoryUser[]);
		return;
	}

	void (async () => {
		try {
			const authToken = getAuthToken();
			const response = await fetch(`${getServerUrl()}/api/users`, {
				headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
			});
			if (!response.ok) {
				console.error('[PlannerUsers] Failed to fetch users:', response.status);
				return;
			}
			const data = await response.json();
			const rows: unknown = Array.isArray(data) ? data : (data?.users ?? []);
			if (!Array.isArray(rows)) return;
			plannerDirectoryUsers.set(
				rows.map((u: Record<string, unknown>) => ({
					user_id:
						typeof u.user_id === 'number'
							? u.user_id
							: typeof u.userId === 'number'
								? (u.userId as number)
								: typeof u.id === 'number'
									? (u.id as number)
									: 0,
					username: (u.username as string) ?? (u.name as string) ?? 'user',
					profile_picture: (u.profile_picture as string) ?? (u.profilePicture as string),
					color: (u.color as string) ?? '#6366f1'
				}))
			);
		} catch (error) {
			console.error('[PlannerUsers] Failed to fetch users:', error);
		}
	})();
}

/** O(1) assignee lookup for cards/rows/chips. */
export const plannerUserById = derived(plannerDirectoryUsers, ($users) => {
	const map = new Map<number, PlannerDirectoryUser>();
	for (const u of $users) map.set(u.user_id, u);
	return map;
});

export function getPlannerUserName(
	map: Map<number, PlannerDirectoryUser>,
	userId: number | undefined | null
): string {
	if (!userId) return '';
	return map.get(userId)?.username || '';
}

export function getPlannerUserColor(
	map: Map<number, PlannerDirectoryUser>,
	userId: number | undefined | null
): string {
	if (!userId) return '#888888';
	return map.get(userId)?.color || '#888888';
}

export function getPlannerUserAvatarUrl(
	map: Map<number, PlannerDirectoryUser>,
	userId: number | undefined | null
): string | undefined {
	if (!userId) return undefined;
	return map.get(userId)?.profile_picture || undefined;
}

/** Parse a Todo.assignedTo string ("42") into a numeric id. */
export function parseAssigneeId(assignedTo: string | number | undefined | null): number | null {
	if (assignedTo === undefined || assignedTo === null || assignedTo === '') return null;
	const n = Number.parseInt(String(assignedTo), 10);
	return Number.isFinite(n) ? n : null;
}
