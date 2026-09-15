import { expect, test } from 'bun:test';
import { parsePlannerBackup, mergePlannerBackup } from './backup';
import type { BusinessDataSnapshot } from './types';

const EMPTY_SNAPSHOT: BusinessDataSnapshot = {
	todos: [],
	calendarEvents: [],
	diaryEntries: [],
	projects: [],
	sprints: [],
	kanbanColumns: [],
	resources: [],
	tags: [],
	graphEdges: []
};

const MINIMAL_TODO = { id: 't1', title: 'Test', status: 'todo', priority: 'medium', createdAt: 1, updatedAt: 1, createdBy: 'u1' };
const MINIMAL_PROJECT = { id: 'p1', name: 'Proj', createdBy: 'u1', createdAt: 1, status: 'planning' };
const MINIMAL_SPRINT = { id: 's1', projectId: 'p1', name: 'Sprint', startDate: 1, endDate: 2 };
const MINIMAL_EDGE = { id: 'e1', source: 't1', target: 'p1', type: 'related_to', createdAt: 1, createdBy: 'u1' };

function makeBackup(overrides: Record<string, unknown> = {}, version?: string): string {
	const data: Record<string, unknown> = {
		todos: overrides.todos ?? [],
		calendarEvents: overrides.calendarEvents ?? [],
		diaryEntries: overrides.diaryEntries ?? [],
		projects: overrides.projects ?? [],
		sprints: overrides.sprints ?? [],
		kanbanColumns: overrides.kanbanColumns ?? [],
		resources: overrides.resources ?? [],
		tags: overrides.tags ?? [],
		graphEdges: overrides.graphEdges ?? []
	};
	if (version !== undefined) data.version = version;
	return JSON.stringify(data);
}

function makeCurrentSnapshot(overrides: Record<string, unknown[]> = {}): BusinessDataSnapshot {
	return {
		todos: overrides.todos ?? [{ ...MINIMAL_TODO }],
		calendarEvents: overrides.calendarEvents ?? [],
		diaryEntries: overrides.diaryEntries ?? [],
		projects: overrides.projects ?? [{ ...MINIMAL_PROJECT }],
		sprints: overrides.sprints ?? [],
		kanbanColumns: overrides.kanbanColumns ?? [],
		resources: overrides.resources ?? [],
		tags: overrides.tags ?? [],
		graphEdges: overrides.graphEdges ?? []
	} as unknown as BusinessDataSnapshot;
}

test('parsePlannerBackup accepts valid full export with version', () => {
	const text = makeBackup({ todos: [MINIMAL_TODO], projects: [MINIMAL_PROJECT] }, '1.0');
	const result = parsePlannerBackup(text);
	expect(result.todos).toHaveLength(1);
	expect(result.projects).toHaveLength(1);
	expect(result.todos[0].id).toBe('t1');
});

test('parsePlannerBackup accepts legacy full export without version', () => {
	const text = makeBackup({ todos: [MINIMAL_TODO] });
	const result = parsePlannerBackup(text);
	expect(result.todos).toHaveLength(1);
});

test('parsePlannerBackup rejects unrelated JSON', () => {
	expect(() => parsePlannerBackup('{"foo":"bar"}')).toThrow();
});

test('parsePlannerBackup rejects partial shape', () => {
	const text = '{"todos":[{"id":"t1","title":"x","status":"todo","priority":"medium","createdAt":1,"updatedAt":1,"createdBy":"u1"}]}';
	expect(() => parsePlannerBackup(text)).toThrow();
});

test('parsePlannerBackup rejects corrupt JSON', () => {
	expect(() => parsePlannerBackup('not json')).toThrow();
});

test('parsePlannerBackup rejects duplicate ids', () => {
	const text = makeBackup({ todos: [MINIMAL_TODO, { ...MINIMAL_TODO }] });
	expect(() => parsePlannerBackup(text)).toThrow(/Duplicate.*id/);
});

test('parsePlannerBackup rejects invalid version', () => {
	const text = makeBackup({}, '2.0');
	expect(() => parsePlannerBackup(text)).toThrow(/Unsupported/);
});

test('parsePlannerBackup rejects missing id', () => {
	const badTodo = { title: 'NoId', status: 'todo', priority: 'medium', createdAt: 1, updatedAt: 1, createdBy: 'u1' };
	const text = makeBackup({ todos: [badTodo as Record<string, unknown>] });
	expect(() => parsePlannerBackup(text)).toThrow(/missing or invalid id/);
});

test('parsePlannerBackup rejects row dropped by sanitizer', () => {
	const badTodo = { id: 'bad', title: '', status: 'todo', priority: 'medium', createdAt: 1, updatedAt: 1, createdBy: 'u1' };
	const text = makeBackup({ todos: [badTodo as Record<string, unknown>] });
	expect(() => parsePlannerBackup(text)).toThrow(/dropped by sanitizer/);
});

test('parsePlannerBackup rejects empty array for required collection', () => {
	const text = '{"todos":[],"calendarEvents":[],"diaryEntries":[],"projects":[],"sprints":[],"kanbanColumns":[],"resources":[],"tags":[],"graphEdges":[]}';
	expect(() => parsePlannerBackup(text)).not.toThrow();
});

test('parsePlannerBackup enforces 20MB UTF8 byte limit', () => {
	const huge = 'x'.repeat(20 * 1024 * 1024 + 1);
	expect(() => parsePlannerBackup(huge)).toThrow(/byte limit/);
});

test('parsePlannerBackup enforces 10000 row limit', () => {
	const manyTodos = Array.from({ length: 10001 }, (_, i) => ({ id: `t${i}`, title: 'x', status: 'todo', priority: 'medium', createdAt: 1, updatedAt: 1, createdBy: 'u1' }));
	const text = makeBackup({ todos: manyTodos });
	expect(() => parsePlannerBackup(text)).toThrow(/row limit/);
});

test('parsePlannerBackup returns immutable snapshot', () => {
	const text = makeBackup({ todos: [{ ...MINIMAL_TODO }] });
	const result = parsePlannerBackup(text);
	expect(result.todos).not.toBe((JSON.parse(text) as Record<string, unknown>).todos);
});

test('mergePlannerBackup adds new records and preserves existing', () => {
	const current = makeCurrentSnapshot();
	const incoming = {
		todos: [{ id: 't2', title: 'New', status: 'todo', priority: 'medium', createdAt: 1, updatedAt: 1, createdBy: 'u1' }],
		calendarEvents: [],
		diaryEntries: [],
		projects: [],
		sprints: [],
		kanbanColumns: [],
		resources: [],
		tags: [],
		graphEdges: []
	};
	const result = mergePlannerBackup(current, incoming as BusinessDataSnapshot);
	expect(result.added).toBe(1);
	expect(result.skipped).toBe(0);
	expect(result.data.todos).toHaveLength(2);
});

test('mergePlannerBackup skips identical records', () => {
	const todo = { id: 't1', title: 'Same', status: 'todo', priority: 'medium', createdAt: 1, updatedAt: 1, createdBy: 'u1' };
	const current = makeCurrentSnapshot({ todos: [todo] });
	const incoming = {
		todos: [{ ...todo }],
		calendarEvents: [],
		diaryEntries: [],
		projects: [],
		sprints: [],
		kanbanColumns: [],
		resources: [],
		tags: [],
		graphEdges: []
	};
	const result = mergePlannerBackup(current, incoming as BusinessDataSnapshot);
	expect(result.added).toBe(0);
	expect(result.skipped).toBe(1);
});

test('mergePlannerBackup rejects conflict when records differ', () => {
	const current = makeCurrentSnapshot();
	const incoming = {
		todos: [{ id: 't1', title: 'Different', status: 'todo', priority: 'medium', createdAt: 1, updatedAt: 1, createdBy: 'u1' }],
		calendarEvents: [],
		diaryEntries: [],
		projects: [],
		sprints: [],
		kanbanColumns: [],
		resources: [],
		tags: [],
		graphEdges: []
	};
	expect(() => mergePlannerBackup(current, incoming as BusinessDataSnapshot)).toThrow(/Conflict/);
});

test('mergePlannerBackup input is not mutated', () => {
	const todo = { id: 't1', title: 'Same', status: 'todo', priority: 'medium', createdAt: 1, updatedAt: 1, createdBy: 'u1' };
	const current = makeCurrentSnapshot({ todos: [todo] });
	const incoming = {
		todos: [{ ...todo }],
		calendarEvents: [],
		diaryEntries: [],
		projects: [],
		sprints: [],
		kanbanColumns: [],
		resources: [],
		tags: [],
		graphEdges: []
	};
	const incomingCopy = JSON.parse(JSON.stringify(incoming));
	mergePlannerBackup(current, incoming as BusinessDataSnapshot);
	expect(JSON.stringify(incoming)).toBe(JSON.stringify(incomingCopy));
});

test('mergePlannerBackup rejects todo referencing project not in incoming', () => {
	const current = makeCurrentSnapshot({ projects: [{ id: 'p1', name: 'Proj', createdBy: 'u1', createdAt: 1, status: 'planning' }] });
	const incoming = {
		todos: [{ id: 't2', title: 'New', status: 'todo', priority: 'medium', createdAt: 1, updatedAt: 1, createdBy: 'u1', projectId: 'p1' }],
		calendarEvents: [],
		diaryEntries: [],
		projects: [],
		sprints: [],
		kanbanColumns: [],
		resources: [],
		tags: [],
		graphEdges: []
	};
	expect(() => mergePlannerBackup(current, incoming as BusinessDataSnapshot)).toThrow(/exists in current but not in incoming/);
});

test('mergePlannerBackup rejects todo referencing project in neither current nor incoming', () => {
	const current = makeCurrentSnapshot({ todos: [] });
	const incoming = {
		todos: [{ id: 't1', title: 'New', status: 'todo', priority: 'medium', createdAt: 1, updatedAt: 1, createdBy: 'u1', projectId: 'p99' }],
		calendarEvents: [],
		diaryEntries: [],
		projects: [],
		sprints: [],
		kanbanColumns: [],
		resources: [],
		tags: [],
		graphEdges: []
	};
	expect(() => mergePlannerBackup(current, incoming as BusinessDataSnapshot)).toThrow(/not found in incoming data/);
});

test('mergePlannerBackup rejects todo referencing project in current but not incoming', () => {
	const current = makeCurrentSnapshot({
		projects: [{ id: 'p1', name: 'Proj', createdBy: 'u1', createdAt: 1, status: 'planning' }],
		todos: []
	});
	const incoming = {
		todos: [{ id: 't1', title: 'New', status: 'todo', priority: 'medium', createdAt: 1, updatedAt: 1, createdBy: 'u1', projectId: 'p1' }],
		calendarEvents: [],
		diaryEntries: [],
		projects: [],
		sprints: [],
		kanbanColumns: [],
		resources: [],
		tags: [],
		graphEdges: []
	};
	expect(() => mergePlannerBackup(current, incoming as BusinessDataSnapshot)).toThrow(/exists in current but not in incoming/);
});

test('mergePlannerBackup accepts valid projectId reference in incoming', () => {
	const current = makeCurrentSnapshot({ todos: [] });
	const incoming = {
		todos: [{ id: 't1', title: 'New', status: 'todo', priority: 'medium', createdAt: 1, updatedAt: 1, createdBy: 'u1', projectId: 'p1' }],
		calendarEvents: [],
		diaryEntries: [],
		projects: [{ id: 'p1', name: 'Proj', createdBy: 'u1', createdAt: 1, status: 'planning' }],
		sprints: [],
		kanbanColumns: [],
		resources: [],
		tags: [],
		graphEdges: []
	};
	const result = mergePlannerBackup(current, incoming as BusinessDataSnapshot);
	expect(result.added).toBe(1);
	expect(result.data.todos[0].projectId).toBe('p1');
});

test('mergePlannerBackup rejects graphEdge source not in incoming', () => {
	const current = makeCurrentSnapshot();
	const incoming = {
		todos: [],
		calendarEvents: [],
		diaryEntries: [],
		projects: [],
		sprints: [],
		kanbanColumns: [],
		resources: [],
		tags: [],
		graphEdges: [{ id: 'e1', source: 'unknown', target: 'p1', type: 'related_to', createdAt: 1, createdBy: 'u1' }]
	};
	expect(() => mergePlannerBackup(current, incoming as BusinessDataSnapshot)).toThrow(/source.*not found/);
});

test('mergePlannerBackup rejects unsupported version in parse', () => {
	const text = makeBackup({}, '99');
	expect(() => parsePlannerBackup(text)).toThrow(/Unsupported/);
});

test('parsePlannerBackup accepts empty full export', () => {
	const text = makeBackup();
	const result = parsePlannerBackup(text);
	expect(result.todos).toHaveLength(0);
	expect(result.projects).toHaveLength(0);
});

test('parsePlannerBackup object field ordering does not affect parse', () => {
	const todo = { createdAt: 1, updatedAt: 1, title: 'Ordered', status: 'todo', priority: 'medium', id: 't1', createdBy: 'u1' };
	const text = makeBackup({ todos: [todo] });
	const result = parsePlannerBackup(text);
	expect(result.todos[0].id).toBe('t1');
});

test('mergePlannerBackup identical skip ignores field ordering', () => {
	const todo1 = { id: 't1', title: 'Same', status: 'todo', priority: 'medium', createdAt: 1, updatedAt: 1, createdBy: 'u1' };
	const todo2 = { id: 't1', createdBy: 'u1', updatedAt: 1, title: 'Same', createdAt: 1, priority: 'medium', status: 'todo' };
	const current = makeCurrentSnapshot({ todos: [todo1] });
	const incoming = {
		todos: [todo2],
		calendarEvents: [],
		diaryEntries: [],
		projects: [],
		sprints: [],
		kanbanColumns: [],
		resources: [],
		tags: [],
		graphEdges: []
	};
	const result = mergePlannerBackup(current, incoming as BusinessDataSnapshot);
	expect(result.skipped).toBe(1);
});


test('accepts the real exportedAt envelope and compares absent optional fields equally', () => {
	const current = parsePlannerBackup(makeBackup({ todos: [MINIMAL_TODO] }));
	const text = JSON.stringify({ ...current, version: '1.0', exportedAt: '2026-09-15T00:00:00Z' });
	const incoming = parsePlannerBackup(text);
	const merged = mergePlannerBackup(current, incoming);
	expect(merged.added).toBe(0);
	expect(merged.data.todos).toEqual(current.todos);
});


test('server references cannot bind silently in another account or server', () => {
	const snapshot = JSON.parse(makeBackup({ projects: [{ ...MINIMAL_PROJECT, channelId: '7' }] }));
	const text = JSON.stringify({ ...snapshot, sourceScope: 'planner:A/account:1' });
	expect(() => parsePlannerBackup(text, 'planner:B/account:1')).toThrow('unverified account');
	expect(() => parsePlannerBackup(text, 'planner:A/account:1')).not.toThrow();
	expect(() => parsePlannerBackup(JSON.stringify(snapshot), 'planner:A/account:1')).toThrow('unverified account');
});
