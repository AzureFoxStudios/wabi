import type { Sprint } from './types';
import { sprints } from './state';
import { generateId } from './utils';

export function addSprint(sprint: Omit<Sprint, 'id'>): Sprint {
	const newSprint: Sprint = { ...sprint, id: generateId() };
	sprints.update(s => [...s, newSprint]);
	return newSprint;
}

export function updateSprint(id: string, updates: Partial<Sprint>): void {
	sprints.update(s => s.map(sprint => sprint.id === id ? { ...sprint, ...updates } : sprint));
}

export function deleteSprint(id: string): void {
	sprints.update(s => s.filter(sprint => sprint.id !== id));
}
