/**
 * My Planner calendar (design contract §8.6): the month grid, what fits in a day cell, the
 * keyboard moves between days, the agenda list used below a 720px stage, and the side list of
 * upcoming and overdue tasks. Pure functions, so CalendarImpl stays presentation and the rules
 * are tested without a browser.
 */
import type { CalendarEvent, Todo } from './types';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** How many lines a day cell shows before the rest becomes "+N more" (§8.6: never clipped). */
export const CELL_LINES = 3;

/** Below this stage width the month grid becomes an agenda list (§8.6). */
export const AGENDA_BELOW = 720;

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

export interface CellLines<E, T> {
	events: E[];
	tasks: T[];
	/** Items behind the "+N more" button (0 when everything fits). */
	hidden: number;
}

/**
 * What a day cell shows: everything when it fits in `lines`, otherwise one line fewer plus a
 * "+N more" line, so a cell never grows and never clips a label. Events come before tasks.
 */
export function cellLines<E, T>(events: readonly E[], tasks: readonly T[], lines = CELL_LINES): CellLines<E, T> {
	const total = events.length + tasks.length;
	if (total <= lines) return { events: [...events], tasks: [...tasks], hidden: 0 };
	const room = Math.max(0, lines - 1);
	const shownEvents = events.slice(0, room);
	const shownTasks = tasks.slice(0, Math.max(0, room - shownEvents.length));
	return { events: shownEvents, tasks: shownTasks, hidden: total - shownEvents.length - shownTasks.length };
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

/** Open, dated tasks a calendar shows: not finished, archived or parked. */
export function isOpenTask(todo: Pick<Todo, 'status'>): boolean {
	return todo.status !== 'done' && todo.status !== 'archived' && todo.status !== 'scrapped';
}

/** Open tasks by the day they are due, earliest first within a day. */
export function tasksByDay(todos: readonly Todo[]): Map<string, Todo[]> {
	const map = new Map<string, Todo[]>();
	for (const todo of todos) {
		if (!todo.dueDate || !isOpenTask(todo)) continue;
		const key = dayKey(new Date(todo.dueDate));
		const list = map.get(key);
		if (list) list.push(todo);
		else map.set(key, [todo]);
	}
	for (const list of map.values()) list.sort((a, b) => (a.dueDate ?? 0) - (b.dueDate ?? 0));
	return map;
}

/** Open tasks due before today, oldest first. */
export function overdueTasks(todos: readonly Todo[], now = Date.now()): Todo[] {
	const today = startOfDay(now).getTime();
	return todos
		.filter((t) => t.dueDate !== undefined && isOpenTask(t) && t.dueDate < today)
		.sort((a, b) => (a.dueDate ?? 0) - (b.dueDate ?? 0));
}

/** Open tasks due from today through the next 6 days, soonest first. */
export function upcomingTasks(todos: readonly Todo[], now = Date.now(), limit = 8): Todo[] {
	const today = startOfDay(now).getTime();
	const end = today + 7 * DAY_MS;
	return todos
		.filter((t) => t.dueDate !== undefined && isOpenTask(t) && t.dueDate >= today && t.dueDate < end)
		.sort((a, b) => (a.dueDate ?? 0) - (b.dueDate ?? 0))
		.slice(0, limit);
}

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

/** The event colour as user data (§5.5): a tint and a dot only; no colour falls back to the accent role. */
export function eventTint(event: Pick<CalendarEvent, 'color'>): string {
	const color = (event.color ?? '').trim();
	return /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color) ? color : 'var(--w-accent)';
}
