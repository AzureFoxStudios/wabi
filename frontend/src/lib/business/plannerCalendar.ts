/**
 * My Planner calendar (design contract §8.6): the month grid, what fits in a day cell, the
 * keyboard moves between days, the agenda list used below a 720px stage, and the side list of
 * upcoming and overdue tasks. Pure functions, so CalendarImpl stays presentation and the rules
 * are tested without a browser.
 */
import type { CalendarEvent, Todo } from './types';
import { calendarDay, daysFromToday, isClosedStatus } from './plannerBoard';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Below this stage width the month grid becomes an agenda list (§8.6). */
export const AGENDA_BELOW = 720;

/**
 * The narrowest day column the month keeps beside the Overdue / Upcoming list. Below it the list
 * steps aside (the head's "1 overdue · 7 due this week" opens the same tasks in the Tasks
 * companion) so titles keep their words instead of shrinking to a few letters.
 */
export const MIN_DAY_COLUMN = 140;
/** The side list's width and the gap before it (calendar-view-part1.css). */
export const ASIDE_WIDTH = 248;
export const ASIDE_GAP = 28;
/** The calendar width (inside its gutters) from which the side list sits beside the month. */
export const ASIDE_BESIDE_FROM = 7 * MIN_DAY_COLUMN + ASIDE_GAP + ASIDE_WIDTH;

export function startOfDay(at: number | Date): Date {
	const d = new Date(at);
	d.setHours(0, 0, 0, 0);
	return d;
}

/** A stable key for one calendar day in local time. */
export function dayKey(date: Date): string {
	return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function sameDay(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * The weeks shown for a month: from the week holding the 1st to the week holding the last day,
 * so 4, 5 or 6 rows as the month needs (never a whole trailing row of next month).
 */
export function monthWeeks(month: Date, weekStartsOn = 0): Date[][] {
	const year = month.getFullYear();
	const index = month.getMonth();
	const first = new Date(year, index, 1);
	const last = new Date(year, index + 1, 0);
	const lead = (first.getDay() - weekStartsOn + 7) % 7;
	const cursor = new Date(year, index, 1 - lead);
	const weeks: Date[][] = [];
	while (cursor <= last || weeks.length === 0) {
		const week: Date[] = [];
		for (let i = 0; i < 7; i++) {
			week.push(new Date(cursor));
			cursor.setDate(cursor.getDate() + 1);
		}
		weeks.push(week);
	}
	return weeks;
}

/**
 * How many of a day's lines fit in its cell (§8.6: never clipped; overflow is "+N more").
 * `bottoms` are the bottom edges of every line laid out in order, measured from the top of the
 * cell's list; `room` is the list's height. Everything shows when the last line fits. Otherwise
 * the cell keeps as many whole lines as leave room for a "+N more" line of `moreHeight` after
 * them (which may be none, in a very short cell). The calendar puts "+N more" in the day's head
 * row and passes 0, so the list spends all its height on titles. Lines may be one or two text
 * lines tall, so the cap comes from the cell's height, never a fixed count.
 */
export function fitCount(bottoms: readonly number[], room: number, moreHeight: number, gap: number, slack = 0.5): number {
	const total = bottoms.length;
	if (total === 0) return 0;
	if (bottoms[total - 1] <= room + slack) return total;
	for (let shown = total - 1; shown > 0; shown--) {
		if (bottoms[shown - 1] + gap + moreHeight <= room + slack) return shown;
	}
	return 0;
}

export type GridKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'PageUp' | 'PageDown';

const GRID_KEYS = new Set<string>(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

export function isGridKey(key: string): key is GridKey {
	return GRID_KEYS.has(key);
}

/**
 * The day a key moves to from `from` in the month grid (roving focus): arrows by a day or a week,
 * Home/End to the start/end of the week, PageUp/PageDown by a month (clamped to the month's length).
 */
export function moveDay(from: Date, key: GridKey, weekStartsOn = 0): Date {
	const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
	switch (key) {
		case 'ArrowLeft':
			d.setDate(d.getDate() - 1);
			return d;
		case 'ArrowRight':
			d.setDate(d.getDate() + 1);
			return d;
		case 'ArrowUp':
			d.setDate(d.getDate() - 7);
			return d;
		case 'ArrowDown':
			d.setDate(d.getDate() + 7);
			return d;
		case 'Home':
			d.setDate(d.getDate() - ((d.getDay() - weekStartsOn + 7) % 7));
			return d;
		case 'End':
			d.setDate(d.getDate() + (6 - ((d.getDay() - weekStartsOn + 7) % 7)));
			return d;
		case 'PageUp':
		case 'PageDown': {
			const step = key === 'PageUp' ? -1 : 1;
			const target = new Date(d.getFullYear(), d.getMonth() + step, 1);
			const length = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
			target.setDate(Math.min(d.getDate(), length));
			return target;
		}
	}
}

/**
 * Open tasks: not done, archived or parked. Parked ("Get to later", status `scrapped`) is closed
 * work like the board treats it (plannerBoard.isClosedStatus): the board's "N overdue" and
 * "N due this week" counts leave it out, so the calendar, its side list and the Tasks companion
 * do too, rather than nag about a date the person put off on purpose.
 */
export function isOpenTask(todo: Pick<Todo, 'status'>): boolean {
	return !isClosedStatus(todo.status);
}

/**
 * The local day a task's due date names. The task dialog saves a chosen day as UTC midnight;
 * plannerBoard.calendarDay reads that as the date it was saved as, so the calendar puts a task
 * on the same day the board's card names (never the evening before, west of UTC).
 */
export function dueDay(dueDate: number): Date {
	return new Date(calendarDay(dueDate));
}

/** Open tasks by the day they are due, earliest first within a day. */
export function tasksByDay(todos: readonly Todo[]): Map<string, Todo[]> {
	const map = new Map<string, Todo[]>();
	for (const todo of todos) {
		if (!todo.dueDate || !isOpenTask(todo)) continue;
		const key = dayKey(dueDay(todo.dueDate));
		const list = map.get(key);
		if (list) list.push(todo);
		else map.set(key, [todo]);
	}
	for (const list of map.values()) list.sort((a, b) => (a.dueDate ?? 0) - (b.dueDate ?? 0));
	return map;
}

/** Open tasks due before today, oldest first (a task is never overdue on its own due day). */
export function overdueTasks(todos: readonly Todo[], now = Date.now()): Todo[] {
	return todos
		.filter((t) => t.dueDate !== undefined && isOpenTask(t) && daysFromToday(t.dueDate, now) < 0)
		.sort((a, b) => (a.dueDate ?? 0) - (b.dueDate ?? 0));
}

/**
 * Open tasks due from today through the next 6 days, soonest first: the same window as the
 * board's "due this week". All of them (the side list shows the first few and says how many more).
 */
export function upcomingTasks(todos: readonly Todo[], now = Date.now()): Todo[] {
	return todos
		.filter((t) => {
			if (t.dueDate === undefined || !isOpenTask(t)) return false;
			const days = daysFromToday(t.dueDate, now);
			return days >= 0 && days < 7;
		})
		.sort((a, b) => (a.dueDate ?? 0) - (b.dueDate ?? 0));
}

/** How many tasks each side-list group shows before "and N more". */
export const SIDE_LIST_ROWS = 6;

export interface AgendaDay<E, T> {
	date: Date;
	events: E[];
	tasks: T[];
}

/**
 * The agenda list for a month (narrow stage): every day of the month that has something on it,
 * in order, plus today when it falls in the month (so "Today" is always there to add to).
 */
export function agendaDays<E, T>(
	month: Date,
	eventsByDay: ReadonlyMap<string, E[]>,
	tasksOn: ReadonlyMap<string, T[]>,
	now = Date.now()
): AgendaDay<E, T>[] {
	const year = month.getFullYear();
	const index = month.getMonth();
	const length = new Date(year, index + 1, 0).getDate();
	const today = startOfDay(now);
	const days: AgendaDay<E, T>[] = [];
	for (let d = 1; d <= length; d++) {
		const date = new Date(year, index, d);
		const key = dayKey(date);
		const events = eventsByDay.get(key) ?? [];
		const tasks = tasksOn.get(key) ?? [];
		if (events.length || tasks.length || sameDay(date, today)) days.push({ date, events: [...events], tasks: [...tasks] });
	}
	return days;
}

/** What a completed task goes back to when "Undo" is pressed. */
export interface CompletionUndo {
	status: Todo['status'];
	completedAt: number | undefined;
}

/** Mark a task done; returns the patch to apply and what Undo restores. */
export function completeTask(todo: Pick<Todo, 'status' | 'completedAt'>, now = Date.now()): { patch: Pick<Todo, 'status' | 'completedAt'>; undo: CompletionUndo } {
	return {
		patch: { status: 'done', completedAt: now },
		undo: { status: todo.status, completedAt: todo.completedAt }
	};
}

/**
 * The event colour as user data (§5.5): a tint and a dot only. An event without a usable colour
 * is neutral (--w-line-strong), never the accent: the accent means state, not decoration (§5.1).
 */
export function eventTint(event: Pick<CalendarEvent, 'color'>): string {
	const color = (event.color ?? '').trim();
	return /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color) ? color : 'var(--w-line-strong)';
}
