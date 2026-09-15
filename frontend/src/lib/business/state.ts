import { writable, type Updater } from 'svelte/store';
import { canWritePlanner } from './writeGate';

function ownedStore<T>(initial: T) {
	const store = writable(initial);
	return { subscribe: store.subscribe,
		set(value: T) { if (canWritePlanner()) store.set(value); },
		update(update: Updater<T>) { if (canWritePlanner()) store.update(update); }
	};
}
import type {
	Todo,
	KanbanColumn,
	CalendarEvent,
	DiaryEntry,
	Project,
	Sprint,
	DashboardView,
	TodoFilters,
	Resource,
	Tag,
	GraphEdge
} from './types';

export const DEFAULT_KANBAN_COLUMNS: KanbanColumn[] = [
	{ id: 'ideas', label: 'Ideas', color: '#a855f7', visible: true },
	{ id: 'todo', label: 'To Do', color: '#64748b', visible: true },
	{ id: 'in_progress', label: 'In Progress', color: '#3b82f6', visible: true },
	{ id: 'done', label: 'Done', color: '#10b981', visible: true },
	{ id: 'scrapped', label: 'Parked (Get to later)', color: '#f59e0b', visible: false },
	{ id: 'archived', label: 'Archived', color: '#475569', visible: false }
];

export const todos = ownedStore<Todo[]>([]);
export const calendarEvents = ownedStore<CalendarEvent[]>([]);
export const diaryEntries = ownedStore<DiaryEntry[]>([]);
export const projects = ownedStore<Project[]>([]);
export const sprints = ownedStore<Sprint[]>([]);
export const kanbanColumns = ownedStore<KanbanColumn[]>(DEFAULT_KANBAN_COLUMNS);

export const resources = ownedStore<Resource[]>([]);
export const tags = ownedStore<Tag[]>([]);
export const graphEdges = ownedStore<GraphEdge[]>([]);

export const currentView = writable<DashboardView>('overview');
export const selectedDate = writable<number>(Date.now());
export const selectedProjectId = writable<string | null>(null);
export const todoFilters = writable<TodoFilters>({});
