import { expect, test } from 'bun:test';
import { PlannerSession } from './session';
import type { PlannerPersistence } from './persistence';
import type { BusinessDataSnapshot } from './types';
const snapshot = (title: string): BusinessDataSnapshot => ({ todos: [{ id: '1', title, status: 'todo', priority: 'medium', createdAt: 1, updatedAt: 1, createdBy: '1' }], calendarEvents: [], diaryEntries: [], projects: [], sprints: [], kanbanColumns: [], resources: [], tags: [], graphEdges: [] });
const adapter = (write: PlannerPersistence['write']): PlannerPersistence => ({ write, read: async () => null, drafts: async () => [] });

test('failed write retains dirty draft and revision; successful retry clears only after completion', async () => {
	let fail = true;
	const session = new PlannerSession('server-A/account-1', snapshot('Original'), 4, adapter(async (_scope, revision) => {
		if (fail) throw new Error('Quota exceeded'); return revision + 1;
	}), () => {});
	session.edit(snapshot('Unsaved prose'));
	expect(await session.flush()).toBe(false);
	expect(session.data.todos[0].title).toBe('Unsaved prose');
	expect(session.dirty).toBe(true); expect(session.revision).toBe(4);
	fail = false; expect(await session.flush()).toBe(true);
	expect(session.dirty).toBe(false); expect(session.error).toBeNull(); expect(session.revision).toBe(5);
});

test('edits during a save are queued with their captured snapshot and original account', async () => {
	let release!: () => void;
	const pause = new Promise<void>(resolve => { release = resolve; });
	const calls: Array<{ scope: string; title: string; revision: number }> = [];
	const session = new PlannerSession('A/1', snapshot('Original'), 0, adapter(async (scope, revision, data) => {
		calls.push({ scope, revision, title: data.todos[0].title });
		if (calls.length === 1) await pause;
		return revision + 1;
	}), () => {});
	const draft = snapshot('First edit'); session.edit(draft);
	draft.todos[0].title = 'External mutation';
	const saving = session.flush();
	session.edit(snapshot('Second edit')); release();
	expect(await saving).toBe(true);
	expect(calls).toEqual([{ scope: 'A/1', revision: 0, title: 'First edit' }, { scope: 'A/1', revision: 1, title: 'Second edit' }]);
	expect(session.dirty).toBe(false);
});

test('two accounts never share the draft being written', async () => {
	const calls: string[] = [];
	const persistence = adapter(async (scope, revision, data) => { calls.push(`${scope}:${data.todos[0].title}`); return revision + 1; });
	const a = new PlannerSession('A/1', snapshot('A'), 0, persistence, () => {});
	const b = new PlannerSession('B/1', snapshot('B'), 0, persistence, () => {});
	a.edit(snapshot('Private A')); b.edit(snapshot('Private B'));
	await Promise.all([a.flush(), b.flush()]);
	expect(calls.sort()).toEqual(['A/1:Private A', 'B/1:Private B']);
});
