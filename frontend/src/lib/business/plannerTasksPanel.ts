/**
 * The Tasks companion panel (design contract §8.6, §7.21): My Planner's tasks beside any page,
 * in the shell's companion frame (panel id `planner-tasks`) instead of a private split inside the
 * Planner. Opening it pins it beside the stage, or holds a peek when pinning would leave the stage
 * under 600px (layoutStoreRightPanel.openRightPanel); center stage never changes.
 *
 * The filter lives here so a caller (the board's "1 overdue" summary, the palette) can open the
 * panel already showing what it asked for.
 */
import { derived, writable, type Readable } from 'svelte/store';
import { openRightPanel } from '$lib/layoutStoreRightPanel';
import { activeRightTab, dockStack, rightPanelMode } from '$lib/layoutStoreStates';
import type { Todo } from './types';
import { isOpenTask, startOfDay, DAY_MS } from './plannerCalendar';

export const TASKS_PANEL_ID = 'planner-tasks';

export type TasksFilter = 'all' | 'today' | 'overdue' | 'week';

export const TASKS_FILTERS: readonly { value: TasksFilter; label: string }[] = [
	{ value: 'all', label: 'All' },
	{ value: 'today', label: 'Today' },
	{ value: 'overdue', label: 'Overdue' },
	{ value: 'week', label: 'This week' }
];

const filter = writable<TasksFilter>('all');

/** The filter the Tasks panel shows; the panel's segmented control writes it too. */
export const tasksPanelFilter = { subscribe: filter.subscribe, set: filter.set };

/** Open the Tasks companion (pin, or a held peek when there is no room), showing `show`. */
export function openPlannerTasksPanel(show: TasksFilter = 'all'): void {
	filter.set(show);
	openRightPanel(TASKS_PANEL_ID);
}

/** True while the Tasks companion is on screen (displayed, or pinned in the dock stack). */
export const tasksPanelShown: Readable<boolean> = derived(
	[rightPanelMode, activeRightTab, dockStack],
	([$mode, $tab, $stack]) => $mode !== 'none' && ($tab === TASKS_PANEL_ID || ($mode === 'pinned' && $stack.includes(TASKS_PANEL_ID)))
);

const PRIORITY_ORDER: Record<Todo['priority'], number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/** Open tasks for one filter, urgent first, then by due date (undated last). */
export function filterTasks(todos: readonly Todo[], show: TasksFilter, now = Date.now()): Todo[] {
	const today = startOfDay(now).getTime();
	const tomorrow = today + DAY_MS;
	const weekEnd = today + 7 * DAY_MS;
	return todos
		.filter((todo) => {
			if (!isOpenTask(todo)) return false;
			const due = todo.dueDate;
			switch (show) {
				case 'today':
					return due !== undefined && due >= today && due < tomorrow;
				case 'overdue':
					return due !== undefined && due < today;
				case 'week':
					return due !== undefined && due >= today && due < weekEnd;
				default:
					return true;
			}
		})
		.sort((a, b) => {
			const byPriority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
			if (byPriority !== 0) return byPriority;
			if (a.dueDate && b.dueDate) return a.dueDate - b.dueDate;
			if (a.dueDate) return -1;
			if (b.dueDate) return 1;
			return 0;
		});
}

/** The empty sentence for a filter (§7.16: what is missing, in words). */
export function emptyTasksWords(show: TasksFilter): { title: string; text: string } {
	switch (show) {
		case 'today':
			return { title: 'Nothing due today', text: 'Tasks with today’s date show up here.' };
		case 'overdue':
			return { title: 'Nothing overdue', text: 'Tasks past their due date show up here.' };
		case 'week':
			return { title: 'Nothing due this week', text: 'Tasks due in the next seven days show up here.' };
		default:
			return { title: 'No open tasks', text: 'Add a task here or on the Board; it shows up beside any page.' };
	}
}
