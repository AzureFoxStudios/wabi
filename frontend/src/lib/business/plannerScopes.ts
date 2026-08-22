import { derived } from 'svelte/store';
import { channels, currentChannel, type Channel } from '$lib/socket';
import type { Project, Todo } from './types';

/**
 * Planning scopes: 'personal' (device-local, yours only) vs a channel link
 * ("piped" — shared with that channel's members once server sync lands).
 *
 * Sharing rides channel membership; there is no per-item ACL and no planner
 * channel type. Any channel can host a piped plan; the Planner surfaces it
 * by link. See docs/plans/2026-08-21-planning-scopes-personal-vs-piped.md.
 */

export const PERSONAL_SCOPE = '__personal__' as const;
export type PlannerScope = typeof PERSONAL_SCOPE | string; // personal | channel id

/** Channels the user is in that can host a piped plan (no DMs/threads). */
export const pipableChannels = derived(channels, ($channels) =>
	($channels || []).filter(
		(c: Channel) => c.id && c.type !== 'dm' && c.type !== 'group' && c.type !== 'thread_public' && c.type !== 'thread_private'
	)
);

export function channelNameById(list: Channel[], id: string): string {
	return list.find((c) => c.id === id)?.name || id;
}

/** Projects linked to the channel currently open (empty when personal context). */
export const projectsForCurrentChannel = derived(
	[projectsSource, currentChannel],
	([$projects, $currentChannelId]) => {
		if (!$currentChannelId) return [] as Project[];
		return $projects.filter((p) => p.channelId === $currentChannelId);
	}
);

// Local import indirection to avoid a circular import with ./store.
import { projects as projectsSource } from './store';

/** True when the given project belongs to the given channel. */
export function isChannelLinkedProject(project: Project | null | undefined, channelId: string | null | undefined): boolean {
	return Boolean(project && channelId && project.channelId === channelId);
}

/**
 * Tasks visible in a scope. Personal scope = tasks whose project is not
 * piped (or has no project). Channel scope = tasks on projects piped to it.
 * Until server sync lands both stay device-local; this is routing intent,
 * not ACL.
 */
export function filterTodosByScope(allTodos: Todo[], allProjects: Project[], scope: PlannerScope): Todo[] {
	if (scope === PERSONAL_SCOPE) {
		const pipedProjectIds = new Set(allProjects.filter((p) => p.channelId).map((p) => p.id));
		return allTodos.filter((t) => !t.projectId || !pipedProjectIds.has(t.projectId));
	}
	const linkedIds = new Set(allProjects.filter((p) => p.channelId === scope).map((p) => p.id));
	return allTodos.filter((t) => t.projectId && linkedIds.has(t.projectId));
}
