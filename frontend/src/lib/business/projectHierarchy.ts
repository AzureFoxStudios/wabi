import type { Project, Todo } from './types';

/** Includes the selected project and every descendant, safely even for malformed cycles. */
export function projectScope(projects: Pick<Project, 'id' | 'parentId'>[], rootId: string): Set<string> {
 const ids = new Set([rootId]);
 const queue = [rootId];
 for (let index = 0; index < queue.length; index++) {
  for (const project of projects) {
   if (project.parentId === queue[index] && !ids.has(project.id)) {
    ids.add(project.id); queue.push(project.id);
   }
  }
 }
 return ids;
}
export function projectTasks(projects: Pick<Project, 'id' | 'parentId'>[], todos: Todo[], rootId: string): Todo[] {
 const scope = projectScope(projects, rootId);
 const seen = new Set<string>();
 return todos.filter(task => {
  if (!task.projectId || !scope.has(task.projectId) || seen.has(task.id) || task.status === 'archived' || task.status === 'scrapped') return false;
  seen.add(task.id); return true;
 });
}
