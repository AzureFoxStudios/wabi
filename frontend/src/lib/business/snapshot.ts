import { get } from 'svelte/store';
import type { BusinessDataSnapshot } from './types';
import {
	calendarEvents,
	diaryEntries,
	graphEdges,
	kanbanColumns,
	projects,
	resources,
	sprints,
	tags,
	todos
} from './state';

export function getBusinessDataSnapshot(): BusinessDataSnapshot {
	return {
		todos: get(todos),
		calendarEvents: get(calendarEvents),
		diaryEntries: get(diaryEntries),
		projects: get(projects),
		sprints: get(sprints),
		kanbanColumns: get(kanbanColumns),
		resources: get(resources),
		tags: get(tags),
		graphEdges: get(graphEdges)
	};
}

export function applyBusinessDataSnapshot(data: BusinessDataSnapshot): void {
	todos.set(data.todos);
	calendarEvents.set(data.calendarEvents);
	diaryEntries.set(data.diaryEntries);
	projects.set(data.projects);
	sprints.set(data.sprints);
	kanbanColumns.set(data.kanbanColumns);
	resources.set(data.resources);
	tags.set(data.tags);
	graphEdges.set(data.graphEdges);
}
