/**
 * My Planner views (design contract §8.6): the calendar's month, cells, keys, agenda and side
 * lists; the Tasks companion's filters; the project card words. Pure functions, no browser.
 */
import { describe, expect, test } from 'bun:test';
import { get } from 'svelte/store';
import type { Project, Todo, TodoStatus } from './types';
import {
	ASIDE_BESIDE_FROM,
	ASIDE_GAP,
	ASIDE_WIDTH,
	MIN_DAY_COLUMN,
	agendaDays,
	completeTask,
	dayKey,
	eventTint,
	fitCount,
	isGridKey,
	isOpenTask,
	monthWeeks,
	moveDay,
	overdueTasks,
	tasksByDay,
	upcomingTasks
} from './plannerCalendar';
import { isClosedStatus } from './plannerBoard';
import { openRightPanel } from '$lib/layoutStoreRightPanel';
import { dockStack, pinnedPanelId, rightPanelMode } from '$lib/layoutStoreStates';
import {
	closePlannerTasksPanel,
	emptyTasksWords,
	filterTasks,
	panelOnScreen,
	tasksPanelFilter,
	tasksPanelShown,
	togglePlannerTasksPanel,
	registerInSurfaceTasksList,
	tasksListShown,
	TASKS_FILTERS,
	TASKS_PANEL_ID,
	type CompanionState
} from './plannerTasksPanel';
import {
	deleteProjectWords,
	descendantIds,
	hasEstimates,
	inventoryProjects,
	isPastDue,
	progressWords,
	projectPath,
	projectStatus,
	projectSummary
} from './plannerProjects';

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

describe('a day cell never clips: it shows what its height holds, then "+N more"', () => {
	// Lines of 22px (one text line) or 38px (a two-line title), 2px apart; "+N more" is 20px.
	const bottomsOf = (heights: number[]) => {
		const bottoms: number[] = [];
		let y = 0;
		for (const [i, h] of heights.entries()) {
			y += (i ? 2 : 0) + h;
			bottoms.push(y);
		}
		return bottoms;
	};

	test('everything shows when the last line fits', () => {
		expect(fitCount(bottomsOf([22, 22, 22, 22]), 100, 20, 2)).toBe(4);
		expect(fitCount([], 100, 20, 2)).toBe(0);
	});

	test('a tall cell shows more than three lines (the cap comes from the height)', () => {
		// 109px of room (a 151px row): four one-line items fit (94px); six need "+N more", which
		// leaves room for three. 140px of room holds five and "+1 more".
		const shown = fitCount(bottomsOf([22, 22, 22, 22, 22, 22]), 109, 20, 2);
		expect(shown).toBe(3);
		expect(fitCount(bottomsOf([22, 22, 22, 22]), 109, 20, 2)).toBe(4);
		expect(fitCount(bottomsOf([22, 22, 22, 22, 22, 22]), 140, 20, 2)).toBe(5);
	});

	test('two-line titles take their room; whole lines only, with room left for "+N more"', () => {
		// 38 + 2 + 38 = 78; + 2 + 20 = 100 fits in 100; a third 38px line would not.
		expect(fitCount(bottomsOf([38, 38, 38, 22]), 100, 20, 2)).toBe(2);
		expect(fitCount(bottomsOf([38, 38, 38, 22]), 99, 20, 2)).toBe(1);
	});

	test('with "+N more" in the head row the list keeps no room for it: every line that fits shows', () => {
		// 109px of room: 22 + 38 + 38 = 102 (with gaps) fits; the 22px fourth line would not.
		expect(fitCount(bottomsOf([22, 38, 38, 22, 22]), 109, 0, 0)).toBe(3);
		expect(fitCount(bottomsOf([22, 38, 38, 22, 22]), 79, 0, 0)).toBe(2);
		expect(fitCount(bottomsOf([22, 22]), 79, 0, 0)).toBe(2);
	});

	test('a very short cell keeps only "+N more"', () => {
		expect(fitCount(bottomsOf([38, 38]), 30, 20, 2)).toBe(0);
	});

	test('the side list sits beside the month only while each day keeps 140px', () => {
		expect(ASIDE_BESIDE_FROM).toBe(7 * MIN_DAY_COLUMN + ASIDE_GAP + ASIDE_WIDTH);
		expect(MIN_DAY_COLUMN).toBe(140);
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

	test('open means what the board means: parked is closed work there and here', () => {
		const statuses: TodoStatus[] = ['ideas', 'todo', 'in_progress', 'done', 'archived', 'scrapped'];
		for (const status of statuses) expect(isOpenTask({ status })).toBe(!isClosedStatus(status));
		expect(isOpenTask({ status: 'scrapped' })).toBe(false);
	});

	test('overdue is before today; upcoming is today through the next six days', () => {
		expect(overdueTasks(all, NOW).map((t) => t.title)).toEqual(['Late']);
		expect(upcomingTasks(all, NOW).map((t) => t.title)).toEqual(['Today', 'Soon']);
	});

	test('upcoming is every task of the week, so its count never undercounts', () => {
		const many = Array.from({ length: 11 }, (_, i) => todo({ title: `Week ${i}`, dueDate: day(2026, 8, 21 + (i % 7)) }));
		expect(upcomingTasks(many, NOW).length).toBe(11);
	});

	test('a day saved as UTC midnight (the task dialog) lands on that day, as on the board', () => {
		const saved = todo({ title: 'Saved', dueDate: Date.UTC(2026, 8, 23) });
		expect(tasksByDay([saved]).get(dayKey(new Date(2026, 8, 23)))?.map((t) => t.title)).toEqual(['Saved']);
		expect(overdueTasks([saved], new Date(2026, 8, 23, 20).getTime())).toEqual([]);
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

	test('an event colour is a tint only when it is a colour; otherwise neutral, never the accent', () => {
		expect(eventTint({ color: '#98d8c8' })).toBe('#98d8c8');
		expect(eventTint({ color: undefined })).toBe('var(--w-line-strong)');
		expect(eventTint({ color: 'red; background: url(x)' })).toBe('var(--w-line-strong)');
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

	const base: CompanionState = { mode: 'pinned', tab: TASKS_PANEL_ID, stack: [TASKS_PANEL_ID], pinned: TASKS_PANEL_ID, canPin: true, mobile: false, held: false };

	test('a pin in flow is on screen; a stowed pin is not', () => {
		expect(panelOnScreen(base, TASKS_PANEL_ID)).toBe(true);
		expect(panelOnScreen({ ...base, tab: 'people', stack: ['people', TASKS_PANEL_ID] }, TASKS_PANEL_ID)).toBe(true);
		expect(panelOnScreen({ ...base, canPin: false }, TASKS_PANEL_ID)).toBe(false);
		// Phones show the pin as a sheet: nothing is stowed there.
		expect(panelOnScreen({ ...base, canPin: false, mobile: true }, TASKS_PANEL_ID)).toBe(true);
		expect(panelOnScreen({ ...base, mode: 'none' }, TASKS_PANEL_ID)).toBe(false);
	});

	test('a held peek is on screen; a hover peek is a glance and does not count', () => {
		const hover: CompanionState = { mode: 'peek', tab: TASKS_PANEL_ID, stack: [], pinned: null, canPin: true, mobile: false, held: false };
		expect(panelOnScreen(hover, TASKS_PANEL_ID)).toBe(false);
		expect(panelOnScreen({ ...hover, held: true }, TASKS_PANEL_ID)).toBe(true);
		// Hovering the Tasks stub over another pin does not put Tasks on screen either.
		expect(panelOnScreen({ ...base, tab: TASKS_PANEL_ID, stack: ['people'], pinned: 'people' }, TASKS_PANEL_ID)).toBe(false);
		// A held peek over a stowed pin is.
		expect(panelOnScreen({ ...base, stack: ['people'], pinned: 'people', canPin: false, held: true }, TASKS_PANEL_ID)).toBe(true);
	});

	test('the Planner switch opens the companion and puts it away again; other pins stay', () => {
		rightPanelMode.set('none');
		dockStack.set([]);
		pinnedPanelId.set(null);
		expect(get(tasksPanelShown)).toBe(false);
		togglePlannerTasksPanel('overdue');
		expect(get(tasksPanelShown)).toBe(true);
		expect(get(tasksPanelFilter)).toBe('overdue');
		openRightPanel('people');
		togglePlannerTasksPanel();
		expect(get(tasksPanelShown)).toBe(false);
		expect(get(dockStack)).toEqual(['people']);
		closePlannerTasksPanel();
		expect(get(dockStack)).toEqual(['people']);
		rightPanelMode.set('none');
		dockStack.set([]);
		pinnedPanelId.set(null);
	});

	test('an in-surface Tasks list counts as a Tasks list on screen while it is mounted', () => {
		expect(get(tasksListShown)).toBe(false);
		const remove = registerInSurfaceTasksList();
		expect(get(tasksListShown)).toBe(true);
		remove();
		remove();
		expect(get(tasksListShown)).toBe(false);
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

	test('deleting a project says everything that goes: sub-projects at any depth, tasks, sprints', () => {
		expect(descendantIds(projects, root.id)).toEqual([child.id, grandchild.id]);
		const sprints = [{ projectId: child.id }, { projectId: 'elsewhere' }];
		expect(deleteProjectWords(projects, tasks, sprints, root)).toBe(
			'“A field guide to belonging”, its 2 sub-projects, 4 tasks and 1 sprint will be removed from your Planner.'
		);
		expect(deleteProjectWords(projects, tasks, [], grandchild)).toBe('“Legend” will be removed from your Planner.');
		expect(deleteProjectWords(projects, tasks, [], child)).toBe('“The fold-out map”, its 1 sub-project and 2 tasks will be removed from your Planner.');
		const lone = project({ name: 'Zine' });
		expect(deleteProjectWords([lone], [todo({ projectId: lone.id })], [], lone)).toBe('“Zine” and its 1 task will be removed from your Planner.');
		// A loop in the parent links never hangs the count.
		const a = project({ name: 'A' });
		const b = project({ name: 'B', parentId: a.id });
		a.parentId = b.id;
		expect(descendantIds([a, b], a.id)).toEqual([b.id]);
	});

	test('past due means before today', () => {
		expect(isPastDue(day(2026, 8, 20), NOW)).toBe(true);
		expect(isPastDue(day(2026, 8, 21, 0), NOW)).toBe(false);
		expect(isPastDue(undefined, NOW)).toBe(false);
	});
});
