import { get } from 'svelte/store';
import type { Project } from './types';
import { projects, todos, sprints } from './state';
import { generateId } from './utils';

export function addProject(project: Omit<Project, 'id' | 'createdAt'>): Project {
	const newProject: Project = { ...project, id: generateId(), createdAt: Date.now() };
	projects.update(p => [...p, newProject]);
	return newProject;
}

export function updateProject(id: string, updates: Partial<Project>): void {
	projects.update(p => p.map(project => project.id === id ? { ...project, ...updates } : project));
}

export function deleteProject(id: string): void {
	const allChildIds = getChildProjectIds(id);
	const idsToDelete = [id, ...allChildIds];
	projects.update(p => p.filter(project => !idsToDelete.includes(project.id)));
	todos.update(t => t.filter(todo => !todo.projectId || !idsToDelete.includes(todo.projectId)));
	sprints.update(s => s.filter(sprint => !idsToDelete.includes(sprint.projectId)));
}

function getChildProjectIds(parentId: string): string[] {
	const allProjects = get(projects);
	const directChildren = allProjects.filter(p => p.parentId === parentId);
	let allChildren = directChildren.map(p => p.id);
	for (const child of directChildren) {
		allChildren = [...allChildren, ...getChildProjectIds(child.id)];
	}
	return allChildren;
}

export function getSubProjects(parentId: string): Project[] {
	return get(projects).filter(p => p.parentId === parentId);
}
