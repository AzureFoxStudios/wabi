import { describe, expect, test } from 'bun:test';
import { get } from 'svelte/store';
import type { Todo } from './types';
import {
	NO_FILTERS,
	boardSummary,
	cardFocusTarget,
	completedAtFor,
	dateFromInput,
	dateInputValue,
	dateWords,
	dueDateForSave,
	dueLabel,
	formatFileLinks,
	laneGlyph,
	laneLabel,
	matchesFilters,
	neighbourLane,
	parseFileLinks,
	plannerNewRequest,
	plannerViewFrom,
	priorityMark,
	requestPlannerNew,
	spansSeveralProjects,
	takePlannerNewRequest,
	tasksByLane
} from './plannerBoard';

// Wednesday 23 September 2026, 10:00 local time.
const NOW = new Date(2026, 8, 23, 10, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number, hour = 12) => new Date(2026, 8, 23 + days, hour, 0, 0).getTime();

function todo(partial: Partial<Todo> & Pick<Todo, 'id'>): Todo {
	return { title: partial.id, status: 'todo', priority: 'medium', createdAt: NOW, updatedAt: NOW, createdBy: 'me', ...partial };
}

describe('due words', () => {
	test('never a bare day count', () => {
		for (let d = -10; d <= 10; d++) expect(dateWords(at(d), NOW, 'en-GB')).not.toMatch(/^\d+d$/);
	});

	test('reads as words a person uses', () => {
		expect(dateWords(at(0), NOW, 'en-GB')).toBe('Today');
		expect(dateWords(at(1), NOW, 'en-GB')).toBe('Tomorrow');
		expect(dateWords(at(-1), NOW, 'en-GB')).toBe('Yesterday');
		expect(dateWords(at(3), NOW, 'en-GB')).toBe('Sat 26');
		expect(dateWords(at(-2), NOW, 'en-GB')).toBe('Mon 21');
		expect(dateWords(at(10), NOW, 'en-GB')).toBe('3 Oct');
		expect(dateWords(new Date(2027, 0, 4).getTime(), NOW, 'en-GB')).toBe('4 Jan 2027');
	});

	test('open work shows its due day, overdue once the day has passed', () => {
		expect(dueLabel({ status: 'todo', dueDate: at(0, 0) }, NOW, 'en-GB')).toEqual({ text: 'Today', tone: 'due', title: 'Due Today' });
		expect(dueLabel({ status: 'in_progress', dueDate: at(-2) }, NOW, 'en-GB')?.text).toBe('Overdue · Mon 21');
		expect(dueLabel({ status: 'in_progress', dueDate: at(-2) }, NOW, 'en-GB')?.tone).toBe('overdue');
		expect(dueLabel({ status: 'todo' }, NOW)).toBeNull();
	});

	test('finished work shows when it was done, never its due date', () => {
		expect(dueLabel({ status: 'done', dueDate: at(-3), completedAt: at(-4) }, NOW, 'en-GB')).toEqual({ text: 'Done · Sat 19', tone: 'done', title: 'Done Sat 19' });
		expect(dueLabel({ status: 'done', dueDate: at(2) }, NOW)?.text).toBe('Done');
		expect(dueLabel({ status: 'archived', dueDate: at(-3) }, NOW)).toBeNull();
	});
});

describe('card marks', () => {
	test('only High and Urgent earn a priority mark', () => {
		expect(priorityMark('urgent')).toEqual({ word: 'Urgent', tone: 'danger' });
		expect(priorityMark('high')).toEqual({ word: 'High', tone: 'warn' });
		expect(priorityMark('medium')).toBeNull();
		expect(priorityMark('low')).toBeNull();
	});

	test('a project chip only when the board spans several projects', () => {
		expect(spansSeveralProjects([{ projectId: 'a' }, { projectId: 'a' }, {}])).toBe(false);
		expect(spansSeveralProjects([{ projectId: 'a' }, { projectId: 'b' }])).toBe(true);
	});
});

describe('lanes', () => {
	test('default lanes read in sentence case; renamed lanes keep their words', () => {
		expect(laneLabel({ id: 'todo', label: 'To Do' })).toBe('To do');
		expect(laneLabel({ id: 'in_progress', label: 'In Progress' })).toBe('In progress');
		expect(laneLabel({ id: 'todo', label: 'Next Up' })).toBe('Next Up');
		expect(laneLabel({ id: 'qa' as Todo['status'], label: 'QA Review' })).toBe('QA Review');
	});

	test('each default lane draws its own status glyph', () => {
		expect(['ideas', 'todo', 'in_progress', 'done'].map(laneGlyph)).toEqual(['idea', 'todo', 'progress', 'done']);
		expect(laneGlyph('custom')).toBe('plain');
	});

	test('lanes sort by priority, then due date, and keep empty lanes', () => {
		const lanes = tasksByLane([
			todo({ id: 'late', dueDate: at(4) }),
			todo({ id: 'soon', dueDate: at(1) }),
			todo({ id: 'urgent', priority: 'urgent' }),
			todo({ id: 'idea', status: 'ideas', projectId: 'other' })
		], { ...NO_FILTERS, project: 'p' }, NOW);
		expect(lanes.todo).toEqual([]);
		expect(lanes.ideas).toEqual([]);
		const all = tasksByLane([todo({ id: 'late', dueDate: at(4) }), todo({ id: 'soon', dueDate: at(1) }), todo({ id: 'urgent', priority: 'urgent' })], NO_FILTERS, NOW);
		expect(all.todo.map((t) => t.id)).toEqual(['urgent', 'soon', 'late']);
	});
});

describe('filters and summary', () => {
	const todos = [
		todo({ id: 'a', dueDate: at(1) }),
		todo({ id: 'b', dueDate: at(-2), status: 'in_progress' }),
		todo({ id: 'c', dueDate: at(12) }),
		todo({ id: 'd', dueDate: at(-5), status: 'done' }),
		todo({ id: 'e', status: 'scrapped', dueDate: at(1) }),
		todo({ id: 'f', assignedTo: '7', priority: 'high' })
	];

	test('counts only what the shown lanes can hold, and skip finished work for due and overdue', () => {
		expect(boardSummary(todos, ['ideas', 'todo', 'in_progress', 'done'], NO_FILTERS, NOW)).toEqual({ tasks: 5, dueThisWeek: 1, overdue: 1 });
	});

	test('each summary count is a real filter', () => {
		expect(todos.filter((t) => matchesFilters(t, { ...NO_FILTERS, summary: 'week' }, NOW)).map((t) => t.id)).toEqual(['a']);
		expect(todos.filter((t) => matchesFilters(t, { ...NO_FILTERS, summary: 'overdue' }, NOW)).map((t) => t.id)).toEqual(['b']);
	});

	test('assignee filter: one person, or unassigned', () => {
		expect(todos.filter((t) => matchesFilters(t, { ...NO_FILTERS, assignee: '7' }, NOW)).map((t) => t.id)).toEqual(['f']);
		expect(todos.filter((t) => matchesFilters(t, { ...NO_FILTERS, assignee: 'none' }, NOW))).toHaveLength(5);
		expect(boardSummary(todos, ['todo'], { ...NO_FILTERS, priority: 'high' }, NOW)).toEqual({ tasks: 1, dueThisWeek: 0, overdue: 0 });
	});
});

describe('keyboard moves', () => {
	const lanes = [
		{ id: 'ideas', cards: ['i1', 'i2'] },
		{ id: 'todo', cards: [] },
		{ id: 'in_progress', cards: ['p1', 'p2', 'p3'] }
	];

	test('arrows move within a lane and skip empty lanes sideways', () => {
		expect(cardFocusTarget(lanes, 'i1', 'down')).toBe('i2');
		expect(cardFocusTarget(lanes, 'i1', 'up')).toBeNull();
		expect(cardFocusTarget(lanes, 'i2', 'right')).toBe('p2');
		expect(cardFocusTarget(lanes, 'p3', 'left')).toBe('i2');
		expect(cardFocusTarget(lanes, 'p1', 'end')).toBe('p3');
		expect(cardFocusTarget(lanes, 'p3', 'home')).toBe('p1');
		expect(cardFocusTarget(lanes, 'p1', 'right')).toBeNull();
	});

	test('[ and ] step one shown lane, and stop at the ends', () => {
		const ids = ['ideas', 'todo', 'in_progress', 'done'];
		expect(neighbourLane(ids, 'todo', -1)).toBe('ideas');
		expect(neighbourLane(ids, 'todo', 1)).toBe('in_progress');
		expect(neighbourLane(ids, 'done', 1)).toBeNull();
		expect(neighbourLane(ids, 'scrapped', 1)).toBeNull();
	});

	test('moving into Done stamps completion once; moving out clears it', () => {
		expect(completedAtFor('done', undefined, NOW)).toBe(NOW);
		expect(completedAtFor('done', NOW - DAY, NOW)).toBe(NOW - DAY);
		expect(completedAtFor('todo', NOW - DAY, NOW)).toBeUndefined();
	});
});

describe('task dialog fields', () => {
	test('the date field round-trips the stored format exactly', () => {
		const stored = Date.parse('2026-09-25');
		expect(dateInputValue(stored)).toBe('2026-09-25');
		expect(dateFromInput('2026-09-25')).toBe(stored);
		expect(dateFromInput('')).toBeUndefined();
		expect(dateFromInput('25/09/2026')).toBeUndefined();
	});

	test('an untouched due date is saved as it was, never rounded', () => {
		const odd = Date.parse('2026-09-25') + 5 * 60 * 60 * 1000;
		expect(dueDateForSave(dateInputValue(odd), odd)).toBe(odd);
		expect(dueDateForSave('2026-09-30', odd)).toBe(Date.parse('2026-09-30'));
		expect(dueDateForSave('', odd)).toBeUndefined();
	});

	test('project file links parse, report what they could not read, and format back', () => {
		const { refs, unread } = parseFileLinks('ch_1a ^c/src/app.ts:12-20, https://example.com/x\nch_2b^c/README.md');
		expect(unread).toBe(1);
		expect(refs).toEqual([
			{ channelId: 'ch_1a', path: 'src/app.ts', startLine: 12, endLine: 20 },
			{ channelId: 'ch_2b', path: 'README.md', startLine: undefined, endLine: undefined }
		]);
		expect(parseFileLinks(formatFileLinks(refs)).refs).toEqual(refs);
	});
});

describe('views and the New request', () => {
	test('saved and deep-linked views map onto the four views', () => {
		expect(plannerViewFrom('board')).toBe('board');
		expect(plannerViewFrom('insights')).toBe('projects');
		expect(plannerViewFrom('kanban')).toBeNull();
	});

	test('a New request is taken once, and a newer one is never dropped', () => {
		requestPlannerNew();
		const first = get(plannerNewRequest);
		expect(first?.view).toBe('board');
		requestPlannerNew('calendar');
		const second = get(plannerNewRequest);
		expect(takePlannerNewRequest(first!.seq)).toBeNull();
		expect(get(plannerNewRequest)).toEqual(second);
		expect(takePlannerNewRequest(second!.seq)).toEqual(second);
		expect(get(plannerNewRequest)).toBeNull();
	});
});
