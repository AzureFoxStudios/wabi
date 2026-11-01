/**
 * The Tasks companion panel (design contract §8.6, §7.21): My Planner's tasks beside any page,
 * in the shell's companion frame (panel id `planner-tasks`) instead of a private split inside the
 * Planner. Opening it pins it beside the stage, or holds a peek when pinning would leave the stage
 * under 600px (layoutStoreRightPanel.openRightPanel); center stage never changes.
 *
 * The filter lives here so a caller (the board's "1 overdue" summary, the palette) can open the
 * panel already showing what it asked for.
 */
import { derived, get, writable, type Readable } from 'svelte/store';
import { dockCanPin, endPeek, openRightPanel, peekHeld, unpinOne } from '$lib/layoutStoreRightPanel';
import { activeRightTab, dockStack, isMobile, pinnedPanelId, rightPanelMode } from '$lib/layoutStoreStates';
import type { Todo } from './types';
import { isOpenTask } from './plannerCalendar';
import { daysFromToday } from './plannerBoard';

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

export interface CompanionState {
	mode: 'none' | 'peek' | 'pinned' | string;
	/** The panel the companion displays (a hover peek moves it too). */
	tab: string;
	/** Everything pinned in the dock (empty for a single legacy pin, which `pinned` names). */
	stack: readonly string[];
	pinned: string | null;
	/** The stage keeps 600px beside a pin (layoutStoreRightPanel.dockCanPin). */
	canPin: boolean;
	mobile: boolean;
	/** A peek opened on purpose (click, tap, Enter), not a hover. */
	held: boolean;
}

/**
 * Whether a panel is really on screen and stays there: pinned in flow (not a stowed pin, which
 * keeps its place but is off screen while the stage has no room), or a held peek. A hover peek
 * is a glance that retracts on pointer leave, so it does not count: center stage must not
 * reflow because the pointer crossed a stub.
 */
export function panelOnScreen(state: CompanionState, panelId: string): boolean {
	if (state.mode === 'none') return false;
	if (state.held && state.tab === panelId) return true;
	if (state.mode !== 'pinned' || !(state.canPin || state.mobile)) return false;
	const pins = state.stack.length > 0 ? state.stack : state.pinned ? [state.pinned] : [];
	return pins.includes(panelId);
}

/** True while the Tasks companion is on screen (pinned in flow or a held peek; see panelOnScreen). */
export const tasksPanelShown: Readable<boolean> = derived(
	[rightPanelMode, activeRightTab, dockStack, pinnedPanelId, dockCanPin, isMobile, peekHeld],
	([$mode, $tab, $stack, $pinned, $canPin, $mobile, $held]) =>
		panelOnScreen({ mode: $mode, tab: $tab, stack: $stack, pinned: $pinned, canPin: $canPin, mobile: $mobile, held: $held }, TASKS_PANEL_ID)
);

/**
 * Put the Tasks companion away: a held peek of it ends (a stowed pin under it stays), a pin of it
 * is unpinned and the other pins keep their place. Nothing else on the rail changes.
 */
export function closePlannerTasksPanel(): void {
	if (get(peekHeld) && get(activeRightTab) === TASKS_PANEL_ID) {
		endPeek();
		return;
	}
	unpinOne(TASKS_PANEL_ID);
}

/**
 * The Planner's "Tasks panel" switch (a menuitemcheckbox whose checked state is
 * `$tasksPanelShown`): open the companion on `show`, or put it away when it is on screen.
 */
export function togglePlannerTasksPanel(show: TasksFilter = 'all'): void {
	if (get(tasksPanelShown)) closePlannerTasksPanel();
	else openPlannerTasksPanel(show);
}

/**
 * Tasks lists drawn inside a surface rather than in the companion frame (the Planner's older
 * in-surface split still mounts TaskPanel). Each one registers while mounted so the Calendar's
 * side list steps aside for it too, instead of showing the same tasks twice side by side.
 */
const inSurfaceLists = writable(0);

/** Register an in-surface Tasks list; returns the call that removes it. */
export function registerInSurfaceTasksList(): () => void {
	inSurfaceLists.update((count) => count + 1);
	let done = false;
	return () => {
		if (done) return;
		done = true;
		inSurfaceLists.update((count) => Math.max(0, count - 1));
	};
}

/** True while any Tasks list is on screen: the companion, or an in-surface list. */
export const tasksListShown: Readable<boolean> = derived(
	[tasksPanelShown, inSurfaceLists],
	([$panel, $lists]) => $panel || $lists > 0
);

const PRIORITY_ORDER: Record<Todo['priority'], number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/** Open tasks for one filter, urgent first, then by due date (undated last). */
export function filterTasks(todos: readonly Todo[], show: TasksFilter, now = Date.now()): Todo[] {
	return todos
		.filter((todo) => {
			if (!isOpenTask(todo)) return false;
			if (show === 'all') return true;
			if (todo.dueDate === undefined) return false;
			// Calendar days, read the way the board reads them (plannerBoard.daysFromToday).
			const days = daysFromToday(todo.dueDate, now);
			switch (show) {
				case 'today':
					return days === 0;
				case 'overdue':
					return days < 0;
				case 'week':
					return days >= 0 && days < 7;
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
