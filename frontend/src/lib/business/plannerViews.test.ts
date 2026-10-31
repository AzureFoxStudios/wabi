/**
 * My Planner views (design contract §8.6): the calendar's month, cells, keys, agenda and side
 * lists; the Tasks companion's filters; the project card words. Pure functions, no browser.
 */
import { describe, expect, test } from 'bun:test';
import type { Project, Todo } from './types';
import {
	CELL_LINES,
	agendaDays,
	cellLines,
	completeTask,
	dayKey,
	eventTint,
	isGridKey,
	monthWeeks,
	moveDay,
	overdueTasks,
	tasksByDay,
	upcomingTasks
} from './plannerCalendar';
import { emptyTasksWords, filterTasks, TASKS_FILTERS } from './plannerTasksPanel';
import { hasEstimates, inventoryProjects, isPastDue, progressWords, projectPath, projectStatus, projectSummary } from './plannerProjects';

const day = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).getTime();
// Monday 21 September 2026, mid-morning.
const NOW = new Date(2026, 8, 21, 10).getTime();

let seq = 0;
function todo(partial: Partial<Todo>): Todo {
	seq += 1;
	return {
		id: `t${seq}`,
		title: `Task ${seq}`,
		status: 'todo',
		priority: 'medium',
		createdAt: 0,
		updatedAt: 0,
		createdBy: 'me',
		...partial
	};
}

function project(partial: Partial<Project>): Project {
	seq += 1;
	return { id: `p${seq}`, name: `Project ${seq}`, color: '#98d8c8', createdBy: 'me', createdAt: 0, status: 'active', ...partial };
}

describe('the month grid', () => {
	test('September 2026 needs five weeks, from Sunday 30 August to Saturday 3 October', () => {
		const weeks = monthWeeks(new Date(2026, 8, 1));
		expect(weeks.length).toBe(5);
		expect(weeks.every((week) => week.length === 7)).toBe(true);
		expect(dayKey(weeks[0][0])).toBe(dayKey(new Date(2026, 7, 30)));
		expect(dayKey(weeks[4][6])).toBe(dayKey(new Date(2026, 9, 3)));
	});

	test('a month never gets a whole trailing week of the next month', () => {
		for (let m = 0; m < 24; m++) {
			const month = new Date(2026, m, 1);
			const weeks = monthWeeks(month);
			const lastWeek = weeks[weeks.length - 1];
			expect(lastWeek.some((d) => d.getMonth() === month.getMonth())).toBe(true);
			expect(weeks.length).toBeGreaterThanOrEqual(4);
			expect(weeks.length).toBeLessThanOrEqual(6);
		}
	});

	test('a Monday week start shifts the lead days', () => {
		const weeks = monthWeeks(new Date(2026, 8, 1), 1);
		expect(weeks[0][0].getDay()).toBe(1);
		expect(dayKey(weeks[0][0])).toBe(dayKey(new Date(2026, 7, 31)));
	});
});

describe('a day cell never clips: overflow becomes "+N more"', () => {
	test('everything shows when it fits', () => {
		const lines = cellLines(['e1'], ['t1', 't2']);
		expect(lines).toEqual({ events: ['e1'], tasks: ['t1', 't2'], hidden: 0 });
	});

	test('one line fewer plus "+N more" when it does not', () => {
		const lines = cellLines(['e1', 'e2'], ['t1', 't2', 't3']);
		expect(lines.events).toEqual(['e1', 'e2']);
		expect(lines.tasks).toEqual([]);
		expect(lines.hidden).toBe(3);
		expect(lines.events.length + lines.tasks.length + 1).toBe(CELL_LINES);
	});

	test('events come before tasks', () => {
		const lines = cellLines(['e1'], ['t1', 't2', 't3']);
		expect(lines.events).toEqual(['e1']);
		expect(lines.tasks).toEqual(['t1']);
		expect(lines.hidden).toBe(2);
	});
});

describe('keyboard moves between days', () => {
	const from = new Date(2026, 8, 23); // Wednesday

	test('arrows move a day or a week', () => {
		expect(dayKey(moveDay(from, 'ArrowLeft'))).toBe(dayKey(new Date(2026, 8, 22)));
		expect(dayKey(moveDay(from, 'ArrowRight'))).toBe(dayKey(new Date(2026, 8, 24)));
		expect(dayKey(moveDay(from, 'ArrowUp'))).toBe(dayKey(new Date(2026, 8, 16)));
		expect(dayKey(moveDay(from, 'ArrowDown'))).toBe(dayKey(new Date(2026, 8, 30)));
	});

	test('Home and End go to the ends of the week', () => {
		expect(dayKey(moveDay(from, 'Home'))).toBe(dayKey(new Date(2026, 8, 20)));
		expect(dayKey(moveDay(from, 'End'))).toBe(dayKey(new Date(2026, 8, 26)));
	});

	test('PageUp and PageDown move a month, clamped to its length', () => {
		expect(dayKey(moveDay(new Date(2026, 2, 31), 'PageUp'))).toBe(dayKey(new Date(2026, 1, 28)));
		expect(dayKey(moveDay(new Date(2026, 0, 31), 'PageDown'))).toBe(dayKey(new Date(2026, 1, 28)));
	});

	test('only grid keys are taken', () => {
		expect(isGridKey('ArrowLeft')).toBe(true);
		expect(isGridKey('Enter')).toBe(false);
		expect(isGridKey('Tab')).toBe(false);
	});
});

describe('tasks on the calendar', () => {
	const late = todo({ title: 'Late', dueDate: day(2026, 8, 18) });
	const today = todo({ title: 'Today', dueDate: day(2026, 8, 21) });
	const soon = todo({ title: 'Soon', dueDate: day(2026, 8, 25) });
	const far = todo({ title: 'Far', dueDate: day(2026, 9, 20) });
	const done = todo({ title: 'Done', status: 'done', dueDate: day(2026, 8, 22) });
	const parked = todo({ title: 'Parked', status: 'scrapped', dueDate: day(2026, 8, 22) });
	const all = [far, soon, today, late, done, parked];

	test('finished, archived and parked tasks are not on the grid', () => {
		const map = tasksByDay(all);
		expect(map.get(dayKey(new Date(2026, 8, 22)))).toBeUndefined();
		expect(map.get(dayKey(new Date(2026, 8, 21)))?.map((t) => t.title)).toEqual(['Today']);
	});

	test('overdue is before today; upcoming is today through the next six days', () => {
		expect(overdueTasks(all, NOW).map((t) => t.title)).toEqual(['Late']);
		expect(upcomingTasks(all, NOW).map((t) => t.title)).toEqual(['Today', 'Soon']);
	});

	test('completing records what Undo restores', () => {
		const { patch, undo } = completeTask({ status: 'in_progress', completedAt: undefined }, NOW);
		expect(patch).toEqual({ status: 'done', completedAt: NOW });
		expect(undo).toEqual({ status: 'in_progress', completedAt: undefined });
	});

	test('the agenda lists the days with something on them, plus today', () => {
		const events = new Map<string, string[]>([[dayKey(new Date(2026, 8, 3)), ['Gathering']]]);
		const days = agendaDays(new Date(2026, 8, 1), events, tasksByDay(all), NOW);
		expect(days.map((d) => d.date.getDate())).toEqual([3, 18, 21, 25]);
		expect(days.find((d) => d.date.getDate() === 21)?.tasks.map((t) => t.title)).toEqual(['Today']);
	});

	test('an event colour is a tint only when it is a colour; otherwise the accent role', () => {
		expect(eventTint({ color: '#98d8c8' })).toBe('#98d8c8');
		expect(eventTint({ color: undefined })).toBe('var(--w-accent)');
		expect(eventTint({ color: 'red; background: url(x)' })).toBe('var(--w-accent)');
	});
});

describe('the Tasks companion', () => {
	const urgentLater = todo({ title: 'Urgent later', priority: 'urgent', dueDate: day(2026, 8, 26) });
	const mediumToday = todo({ title: 'Medium today', dueDate: day(2026, 8, 21) });
	const lowOverdue = todo({ title: 'Low overdue', priority: 'low', dueDate: day(2026, 8, 19) });
	const undated = todo({ title: 'Undated' });
	const finished = todo({ title: 'Finished', status: 'done', dueDate: day(2026, 8, 21) });
	const all = [undated, lowOverdue, mediumToday, urgentLater, finished];

	test('every filter has a label and empty words', () => {
		for (const option of TASKS_FILTERS) {
			expect(option.label.length).toBeGreaterThan(0);
			expect(emptyTasksWords(option.value).title.length).toBeGreaterThan(0);
		}
	});

	test('All is every open task, urgent first, then by due date, undated last', () => {
		expect(filterTasks(all, 'all', NOW).map((t) => t.title)).toEqual(['Urgent later', 'Medium today', 'Undated', 'Low overdue']);
	});

	test('Today, Overdue and Week keep only their dates', () => {
		expect(filterTasks(all, 'today', NOW).map((t) => t.title)).toEqual(['Medium today']);
		expect(filterTasks(all, 'overdue', NOW).map((t) => t.title)).toEqual(['Low overdue']);
		expect(filterTasks(all, 'week', NOW).map((t) => t.title)).toEqual(['Urgent later', 'Medium today']);
	});
});

describe('project words', () => {
	const root = project({ name: 'A field guide to belonging' });
	const child = project({ name: 'The fold-out map', parentId: root.id });
	const grandchild = project({ name: 'Legend', parentId: child.id });
	const projects = [root, child, grandchild];
	const tasks = [
		todo({ projectId: root.id, status: 'done' }),
		todo({ projectId: root.id, dueDate: day(2026, 8, 24) }),
		todo({ projectId: child.id, dueDate: day(2026, 8, 22), estimatedMinutes: 90 }),
		todo({ projectId: child.id, status: 'archived' })
	];

	test('a summary counts the project and its sub-projects, without archived tasks', () => {
		const summary = projectSummary(projects, tasks, root.id);
		expect(summary.total).toBe(3);
		expect(summary.done).toBe(1);
		expect(summary.ratio).toBeCloseTo(1 / 3);
		expect(summary.nextDue?.dueDate).toBe(day(2026, 8, 22));
		expect(summary.subprojects).toBe(1);
		expect(progressWords(summary)).toBe('1/3 done');
		expect(progressWords({ total: 0, done: 0 })).toBe('No tasks yet');
	});

	test('only a status other than Active earns a mark on the card', () => {
		expect(projectStatus('active').quiet).toBe(true);
		expect(projectStatus('paused')).toEqual({ word: 'Paused', tone: 'warn', quiet: false });
		expect(projectStatus('cancelled').tone).toBe('danger');
	});

	test('the inventory lists top-level projects, or every match for a search', () => {
		expect(inventoryProjects(projects, '').map((p) => p.name)).toEqual(['A field guide to belonging']);
		expect(inventoryProjects(projects, 'map').map((p) => p.name)).toEqual(['The fold-out map']);
	});

	test('the crumb path runs from the top down', () => {
		expect(projectPath(projects, grandchild).map((p) => p.name)).toEqual(['A field guide to belonging', 'The fold-out map']);
		expect(projectPath(projects, root)).toEqual([]);
	});

	test('a burndown in hours needs at least one estimate', () => {
		expect(hasEstimates([{ estimatedMinutes: undefined }, { estimatedMinutes: 0 }])).toBe(false);
		expect(hasEstimates([{ estimatedMinutes: 30 }])).toBe(true);
	});

	test('past due means before today', () => {
		expect(isPastDue(day(2026, 8, 20), NOW)).toBe(true);
		expect(isPastDue(day(2026, 8, 21, 0), NOW)).toBe(false);
		expect(isPastDue(undefined, NOW)).toBe(false);
	});
});
