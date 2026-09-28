import { expect, test } from 'bun:test';
import { projectScope, projectTasks } from './projectHierarchy';
import type { Todo } from './types';
test('deep descendants stay in scope without looping through malformed parents', () => {
 const projects = [{id:'season',parentId:'poster'}, {id:'convention',parentId:'season'}, {id:'poster',parentId:'convention'}, {id:'other'}];
 expect([...projectScope(projects,'season')]).toEqual(['season','convention','poster']);
});
test('rollups count each active task once and exclude unrelated or retired tasks', () => {
 const projects = [{id:'root'}, {id:'child',parentId:'root'}];
 const tasks = [{id:'a',projectId:'child',status:'done'}, {id:'a',projectId:'child',status:'done'}, {id:'b',projectId:'root',status:'archived'}, {id:'c',projectId:'other',status:'todo'}] as Todo[];
 expect(projectTasks(projects,tasks,'root').map(t=>t.id)).toEqual(['a']);
});
