/**
 * My Planner — Projects (design contract §8.6): what a project card and the project page say
 * about a project. Pure functions over the store's arrays, so the words are tested once.
 */
import type { Project, Todo } from './types';
import { projectTasks } from './projectHierarchy';
import { isOpenTask, startOfDay } from './plannerCalendar';

export interface ProjectSummary {
	/** Tasks in the project and its sub-projects (archived and parked ones excluded). */
	total: number;
	done: number;
	/** 0–1, for the 64×2 progress bar. */
	ratio: number;
	/** The open task due soonest (overdue ones first), if any has a date. */
	nextDue: Todo | null;
	subprojects: number;
}

export function projectSummary(projects: readonly Project[], todos: readonly Todo[], projectId: string): ProjectSummary {
	const tasks = projectTasks([...projects], [...todos], projectId);
	const done = tasks.filter((task) => task.status === 'done').length;
	const nextDue =
		tasks
			.filter((task) => isOpenTask(task) && task.dueDate !== undefined)
			.sort((a, b) => (a.dueDate ?? 0) - (b.dueDate ?? 0))[0] ?? null;
	return {
		total: tasks.length,
		done,
		ratio: tasks.length ? done / tasks.length : 0,
		nextDue,
		subprojects: projects.filter((p) => p.parentId === projectId).length
	};
}

/** "3/10 done", or "No tasks yet". */
export function progressWords(summary: Pick<ProjectSummary, 'total' | 'done'>): string {
	return summary.total ? `${summary.done}/${summary.total} done` : 'No tasks yet';
}

export type StatusTone = 'ok' | 'info' | 'warn' | 'off' | 'danger';

/**
 * A project's status as a word and a status mark (§5.3). "Active" is the usual state, so a card
 * shows the mark only for the others (`quiet`).
 */
export function projectStatus(status: Project['status']): { word: string; tone: StatusTone; quiet: boolean } {
	switch (status) {
		case 'planning':
			return { word: 'Planning', tone: 'info', quiet: false };
		case 'paused':
			return { word: 'Paused', tone: 'warn', quiet: false };
		case 'completed':
			return { word: 'Completed', tone: 'off', quiet: false };
		case 'cancelled':
			return { word: 'Cancelled', tone: 'danger', quiet: false };
		default:
			return { word: 'Active', tone: 'ok', quiet: true };
	}
}

/** Projects the inventory lists: the top level, or every match for a search. */
export function inventoryProjects(projects: readonly Project[], search: string): Project[] {
	const query = search.trim().toLowerCase();
	if (!query) return projects.filter((project) => !project.parentId);
	return projects.filter((project) => `${project.name} ${project.description ?? ''}`.toLowerCase().includes(query));
}

/** The search field earns its place only once there are enough projects to look through. */
export const SEARCH_FROM = 6;

/** Parent names from the top down to (not including) the project, for the crumb. */
export function projectPath(projects: readonly Project[], project: Project): Project[] {
	const path: Project[] = [];
	const seen = new Set([project.id]);
	let current: Project | undefined = project;
	while (current?.parentId && !seen.has(current.parentId)) {
		seen.add(current.parentId);
		const parent = projects.find((p) => p.id === current?.parentId);
		if (!parent) break;
		path.unshift(parent);
		current = parent;
	}
	return path;
}

/**
 * Whether a burndown in hours means anything: at least one task in scope carries a time
 * estimate. (The store counts an unestimated task as one hour so a mixed backlog does not
 * shrink; with no estimates at all the chart would only count tasks dressed up as hours.)
 */
export function hasEstimates(tasks: readonly Pick<Todo, 'estimatedMinutes'>[]): boolean {
	return tasks.some((task) => typeof task.estimatedMinutes === 'number' && task.estimatedMinutes > 0);
}

/** True when a due date is before today (for the danger tone on "Next due"). */
export function isPastDue(at: number | undefined, now = Date.now()): boolean {
	return at !== undefined && at < startOfDay(now).getTime();
}
