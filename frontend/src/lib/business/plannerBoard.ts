/**
 * My Planner board model (design contract §7.27, §8.6): pure helpers for the tools row, the
 * lanes, the cards and their keyboard moves, plus the one "start a new item" request other
 * surfaces (the Ctrl K palette) can send to an open or opening Planner.
 *
 * Nothing here touches the DOM or the stores' persistence; components pass plain data in.
 */
import { get, writable, type Readable } from 'svelte/store';
import type { KanbanColumn, Todo, TodoStatus } from './types';

const DAY = 24 * 60 * 60 * 1000;

/** The four Planner views, in folio/segment order. */
export type PlannerView = 'calendar' | 'board' | 'journal' | 'projects';
export const PLANNER_VIEWS: readonly PlannerView[] = ['calendar', 'board', 'journal', 'projects'];

export function isPlannerView(value: unknown): value is PlannerView {
	return typeof value === 'string' && (PLANNER_VIEWS as readonly string[]).includes(value);
}

/** Legacy saved/deep-linked views: "insights" is part of Projects now. */
export function plannerViewFrom(value: unknown): PlannerView | null {
	if (value === 'insights') return 'projects';
	return isPlannerView(value) ? value : null;
}

// ---------- the "New …" request (palette → Planner) ----------

export interface PlannerNewRequest {
	view: PlannerView;
	seq: number;
}

const newRequest = writable<PlannerNewRequest | null>(null);
let newRequestSeq = 0;

/**
 * Ask My Planner to start a new item in `view` (default: a board task). An open Planner switches
 * to that view and opens its form at once; otherwise the request waits until the Planner mounts.
 * The caller still opens the Planner itself (`openPlannerSurface()`); this only says what to start.
 */
export function requestPlannerNew(view: PlannerView = 'board'): void {
	newRequest.set({ view, seq: ++newRequestSeq });
}

/** The pending request, if any (the Planner consumes it). */
export const plannerNewRequest: Readable<PlannerNewRequest | null> = { subscribe: newRequest.subscribe };

/** Take the pending request once; a newer request is left in place. */
export function takePlannerNewRequest(seq: number): PlannerNewRequest | null {
	const current = get(newRequest);
	if (!current || current.seq !== seq) return null;
	newRequest.set(null);
	return current;
}

// ---------- lanes ----------

/** Default lanes keep their Title Case data label; the board shows them in sentence case (§9.6). */
const DEFAULT_LANE_WORDS: Partial<Record<string, { data: string; shown: string }>> = {
	ideas: { data: 'Ideas', shown: 'Ideas' },
	todo: { data: 'To Do', shown: 'To do' },
	in_progress: { data: 'In Progress', shown: 'In progress' },
	done: { data: 'Done', shown: 'Done' },
	scrapped: { data: 'Parked (Get to later)', shown: 'Parked' },
	archived: { data: 'Archived', shown: 'Archived' }
};

/** The lane's name as shown: a renamed or custom lane keeps the words its owner chose. */
export function laneLabel(column: Pick<KanbanColumn, 'id' | 'label'>): string {
	const known = DEFAULT_LANE_WORDS[column.id];
	return known && column.label === known.data ? known.shown : column.label;
}

/** Which drawn status glyph a lane head carries (§7.27). */
export type LaneGlyph = 'idea' | 'todo' | 'progress' | 'done' | 'parked' | 'plain';

export function laneGlyph(status: TodoStatus | string): LaneGlyph {
	switch (status) {
		case 'ideas': return 'idea';
		case 'todo': return 'todo';
		case 'in_progress': return 'progress';
		case 'done': return 'done';
		case 'scrapped':
		case 'archived': return 'parked';
		default: return 'plain';
	}
}

/** Statuses that are finished work: no due pressure, a quiet dashed card. */
export function isClosedStatus(status: TodoStatus | string): boolean {
	return status === 'done' || status === 'archived' || status === 'scrapped';
}

// ---------- due words ----------

export function startOfDay(at: number): number {
	const d = new Date(at);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function weekdayDay(at: number, locale?: string): string {
	const d = new Date(at);
	const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(d);
	return `${weekday} ${d.getDate()}`;
}

function dayMonth(at: number, now: number, locale?: string): string {
	const d = new Date(at);
	const sameYear = d.getFullYear() === new Date(now).getFullYear();
	return new Intl.DateTimeFormat(locale, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}

/**
 * A date as words a person reads at a glance: "Today", "Tomorrow", "Wed 23" within the coming
 * week (and the past week), otherwise "3 Oct" (with the year when it differs). Never "2d".
 */
export function dateWords(at: number, now = Date.now(), locale?: string): string {
	const day = startOfDay(at);
	const today = startOfDay(now);
	const diff = Math.round((day - today) / DAY);
	if (diff === 0) return 'Today';
	if (diff === 1) return 'Tomorrow';
	if (diff === -1) return 'Yesterday';
	if (diff > -7 && diff < 7) return weekdayDay(at, locale);
	return dayMonth(at, now, locale);
}

export type DueTone = 'due' | 'overdue' | 'done';

export interface DueLabel {
	text: string;
	tone: DueTone;
	/** Full sentence for assistive tech and the tooltip. */
	title: string;
}

/**
 * What a card's date line says. Open work shows its due date ("Wed 23", or "Overdue · Mon 21" in
 * danger once the day has passed). Finished work shows when it was done ("Done · Sat 19") and
 * never a due date: it no longer matters.
 */
export function dueLabel(todo: Pick<Todo, 'status' | 'dueDate' | 'completedAt'>, now = Date.now(), locale?: string): DueLabel | null {
	if (isClosedStatus(todo.status)) {
		if (todo.status !== 'done') return null;
		if (!todo.completedAt) return { text: 'Done', tone: 'done', title: 'Done' };
		const when = dateWords(todo.completedAt, now, locale);
		return { text: `Done · ${when}`, tone: 'done', title: `Done ${when}` };
	}
	if (!todo.dueDate) return null;
	const when = dateWords(todo.dueDate, now, locale);
	if (startOfDay(todo.dueDate) < startOfDay(now)) {
		return { text: `Overdue · ${when}`, tone: 'overdue', title: `Overdue, was due ${when}` };
	}
	return { text: when, tone: 'due', title: `Due ${when}` };
}

/** Only High and Urgent earn a mark and a word on the card (§7.27). */
export function priorityMark(priority: Todo['priority']): { word: string; tone: 'warn' | 'danger' } | null {
	if (priority === 'urgent') return { word: 'Urgent', tone: 'danger' };
	if (priority === 'high') return { word: 'High', tone: 'warn' };
	return null;
}

// ---------- filters and the summary ----------

export type SummaryFilter = 'all' | 'week' | 'overdue';

export interface BoardFilters {
	project: string | null;
	priority: Todo['priority'] | null;
	/** An assignee id, 'none' for unassigned tasks, or null for anyone. */
	assignee: string | null;
	summary: SummaryFilter;
}

export const NO_FILTERS: BoardFilters = { project: null, priority: null, assignee: null, summary: 'all' };

export function isDueThisWeek(todo: Pick<Todo, 'status' | 'dueDate'>, now = Date.now()): boolean {
	if (!todo.dueDate || isClosedStatus(todo.status)) return false;
	const today = startOfDay(now);
	return todo.dueDate >= today && todo.dueDate < today + 7 * DAY;
}

export function isOverdue(todo: Pick<Todo, 'status' | 'dueDate'>, now = Date.now()): boolean {
	return Boolean(todo.dueDate) && !isClosedStatus(todo.status) && (todo.dueDate as number) < startOfDay(now);
}

/** The select filters (project, priority, assignee): what the summary counts are taken over. */
export function matchesSelectFilters(todo: Todo, filters: BoardFilters): boolean {
	if (filters.project && todo.projectId !== filters.project) return false;
	if (filters.priority && todo.priority !== filters.priority) return false;
	if (filters.assignee === 'none' && todo.assignedTo) return false;
	if (filters.assignee && filters.assignee !== 'none' && String(todo.assignedTo ?? '') !== filters.assignee) return false;
	return true;
}

export function matchesFilters(todo: Todo, filters: BoardFilters, now = Date.now()): boolean {
	if (!matchesSelectFilters(todo, filters)) return false;
	if (filters.summary === 'week') return isDueThisWeek(todo, now);
	if (filters.summary === 'overdue') return isOverdue(todo, now);
	return true;
}

export interface BoardSummary {
	tasks: number;
	dueThisWeek: number;
	overdue: number;
}

/** Counts for the mono summary, over the tasks the board's lanes can show. */
export function boardSummary(todos: readonly Todo[], laneIds: readonly string[], filters: BoardFilters, now = Date.now()): BoardSummary {
	const lanes = new Set(laneIds);
	const summary: BoardSummary = { tasks: 0, dueThisWeek: 0, overdue: 0 };
	for (const todo of todos) {
		if (!lanes.has(todo.status) || !matchesSelectFilters(todo, filters)) continue;
		summary.tasks += 1;
		if (isDueThisWeek(todo, now)) summary.dueThisWeek += 1;
		if (isOverdue(todo, now)) summary.overdue += 1;
	}
	return summary;
}

export function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

const PRIORITY_ORDER: Record<Todo['priority'], number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/** Lanes of filtered tasks, each sorted by priority and then by due date. */
export function tasksByLane(todos: readonly Todo[], filters: BoardFilters, now = Date.now()): Record<string, Todo[]> {
	const lanes: Record<string, Todo[]> = {};
	for (const todo of todos) {
		(lanes[todo.status] ??= []);
		if (matchesFilters(todo, filters, now)) lanes[todo.status].push(todo);
	}
	for (const list of Object.values(lanes)) {
		list.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || (a.dueDate || Infinity) - (b.dueDate || Infinity));
	}
	return lanes;
}

/** A project chip is noise when every card belongs to the same project (§7.27). */
export function spansSeveralProjects(todos: readonly Pick<Todo, 'projectId'>[]): boolean {
	const seen = new Set<string>();
	for (const todo of todos) {
		if (todo.projectId) seen.add(todo.projectId);
		if (seen.size > 1) return true;
	}
	return false;
}

// ---------- keyboard ----------

/** The lane one step left (-1) or right (+1) of `status` among the shown lanes, if any. */
export function neighbourLane(laneIds: readonly string[], status: string, step: -1 | 1): string | null {
	const index = laneIds.indexOf(status);
	if (index < 0) return null;
	return laneIds[index + step] ?? null;
}

export type CardKey = 'up' | 'down' | 'left' | 'right' | 'home' | 'end';

/**
 * Where focus goes from a card (the roving grid): up/down within its lane, left/right to the
 * nearest lane that has cards (same row, or that lane's last card), home/end within the lane.
 */
export function cardFocusTarget(lanes: readonly { id: string; cards: readonly string[] }[], cardId: string, key: CardKey): string | null {
	const laneIndex = lanes.findIndex((lane) => lane.cards.includes(cardId));
	if (laneIndex < 0) return null;
	const lane = lanes[laneIndex];
	const row = lane.cards.indexOf(cardId);
	switch (key) {
		case 'up': return lane.cards[row - 1] ?? null;
		case 'down': return lane.cards[row + 1] ?? null;
		case 'home': return row > 0 ? lane.cards[0] : null;
		case 'end': return row < lane.cards.length - 1 ? lane.cards[lane.cards.length - 1] : null;
		case 'left':
		case 'right': {
			const step = key === 'left' ? -1 : 1;
			for (let i = laneIndex + step; i >= 0 && i < lanes.length; i += step) {
				const next = lanes[i].cards;
				if (next.length) return next[Math.min(row, next.length - 1)];
			}
			return null;
		}
	}
}

/** The completion time a status move should leave on the task. */
export function completedAtFor(status: string, previous: number | undefined, now = Date.now()): number | undefined {
	return status === 'done' ? previous ?? now : undefined;
}

// ---------- the task dialog ----------

/**
 * The task dialog's date field keeps the stored format the board has always written: the chosen
 * day as UTC midnight (`Date.parse('YYYY-MM-DD')`), read back with `toISOString()`. Changing it
 * would shift saved due dates by a day in some time zones, so it round-trips exactly.
 */
export function dateInputValue(at: number | undefined): string {
	if (!at || !Number.isFinite(at)) return '';
	return new Date(at).toISOString().slice(0, 10);
}

export function dateFromInput(value: string): number | undefined {
	const trimmed = value.trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return undefined;
	const at = Date.parse(trimmed);
	return Number.isFinite(at) ? at : undefined;
}

/** Keep the stored due time untouched when the field still shows it (no rounding on save). */
export function dueDateForSave(fieldValue: string, original: number | undefined): number | undefined {
	if (original && dateInputValue(original) === fieldValue.trim()) return original;
	return dateFromInput(fieldValue);
}

/**
 * Project file links typed into the task dialog: `ch_<hex> ^c/path/file.ts:12-20`, separated by
 * commas or new lines. Returns the refs that parse and whether anything was left unread.
 */
export function parseFileLinks(raw: string): { refs: { channelId: string; path: string; startLine?: number; endLine?: number }[]; unread: number } {
	const refs: { channelId: string; path: string; startLine?: number; endLine?: number }[] = [];
	let unread = 0;
	for (const part of raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) {
		const m = part.match(/^(ch_[0-9a-fA-F]+)\s*\^c\/(.+?)(?::(\d+)(?:-(\d+))?)?$/);
		if (!m) {
			unread += 1;
			continue;
		}
		refs.push({ channelId: m[1], path: m[2], startLine: m[3] ? Number(m[3]) : undefined, endLine: m[4] ? Number(m[4]) : undefined });
	}
	return { refs, unread };
}

export function formatFileLinks(refs: readonly { channelId: string; path: string; startLine?: number; endLine?: number }[]): string {
	return refs
		.map((r) => `${r.channelId} ^c/${r.path}${r.startLine ? `:${r.startLine}${r.endLine && r.endLine !== r.startLine ? `-${r.endLine}` : ''}` : ''}`)
		.join(', ');
}
