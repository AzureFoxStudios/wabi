import { writable } from 'svelte/store';
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

export const todos = writable<Todo[]>([]);
export const calendarEvents = writable<CalendarEvent[]>([]);
export const diaryEntries = writable<DiaryEntry[]>([]);
export const projects = writable<Project[]>([]);
export const sprints = writable<Sprint[]>([]);
export const kanbanColumns = writable<KanbanColumn[]>(DEFAULT_KANBAN_COLUMNS);

export const resources = writable<Resource[]>([]);
export const tags = writable<Tag[]>([]);
export const graphEdges = writable<GraphEdge[]>([]);

export const currentView = writable<DashboardView>('overview');
export const selectedDate = writable<number>(Date.now());
export const selectedProjectId = writable<string | null>(null);
export const todoFilters = writable<TodoFilters>({});
