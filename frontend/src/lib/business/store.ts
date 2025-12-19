import { writable, derived, get } from 'svelte/store';
import { browser } from '$app/environment';
import type {
	Todo,
	TodoStatus,
	KanbanColumn,
	CalendarEvent,
	DiaryEntry,
	Project,
	Sprint,
	DashboardView,
	TodoFilters,
	BurnChartDataPoint
} from './types';

// Default kanban columns configuration
const DEFAULT_KANBAN_COLUMNS: KanbanColumn[] = [
	{ id: 'ideas', label: 'Ideas', color: '#a855f7', visible: true },
	{ id: 'todo', label: 'To Do', color: '#64748b', visible: true },
	{ id: 'in_progress', label: 'In Progress', color: '#3b82f6', visible: true },
	{ id: 'done', label: 'Done', color: '#10b981', visible: true },
	{ id: 'scrapped', label: 'Scrapped', color: '#ef4444', visible: true },
	{ id: 'archived', label: 'Archived', color: '#475569', visible: false }
];

// Core data stores
export const todos = writable<Todo[]>([]);
export const calendarEvents = writable<CalendarEvent[]>([]);
export const diaryEntries = writable<DiaryEntry[]>([]);
export const projects = writable<Project[]>([]);
export const sprints = writable<Sprint[]>([]);
export const kanbanColumns = writable<KanbanColumn[]>(DEFAULT_KANBAN_COLUMNS);

// UI state
export const currentView = writable<DashboardView>('overview');
export const selectedDate = writable<number>(Date.now());
export const selectedProjectId = writable<string | null>(null);
export const todoFilters = writable<TodoFilters>({});

// Local storage persistence
const STORAGE_KEY = 'business_data';

function loadFromStorage() {
	if (!browser) return;
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved) {
			const data = JSON.parse(saved);
			// Migrate todos: convert old 'blocked' status to 'scrapped'
			if (data.todos) {
				const migratedTodos = data.todos.map((todo: any) => ({
					...todo,
					status: todo.status === 'blocked' ? 'scrapped' : todo.status
				})) as Todo[];
				todos.set(migratedTodos);
			}
			if (data.calendarEvents) calendarEvents.set(data.calendarEvents);
			if (data.diaryEntries) diaryEntries.set(data.diaryEntries);
			if (data.projects) projects.set(data.projects);
			if (data.sprints) sprints.set(data.sprints);
			// Migrate kanban columns: replace 'blocked' with 'scrapped'
			if (data.kanbanColumns) {
				const migratedColumns = data.kanbanColumns.map((col: any) => {
					if (col.id === 'blocked') {
						return { ...col, id: 'scrapped', label: 'Scrapped' };
					}
					return col;
				}) as KanbanColumn[];
				// Ensure scrapped column exists
				if (!migratedColumns.find((c: KanbanColumn) => c.id === 'scrapped')) {
					migratedColumns.push({ id: 'scrapped', label: 'Scrapped', color: '#ef4444', visible: true });
				}
				kanbanColumns.set(migratedColumns);
			}
		}
	} catch (e) {
		console.error('Failed to load business data from localStorage:', e);
	}
}

function saveToStorage() {
	if (!browser) return;
	try {
		const data = {
			todos: get(todos),
			calendarEvents: get(calendarEvents),
			diaryEntries: get(diaryEntries),
			projects: get(projects),
			sprints: get(sprints),
			kanbanColumns: get(kanbanColumns)
		};
		localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
	} catch (e) {
		console.error('Failed to save business data to localStorage:', e);
	}
}

// Auto-save on changes
if (browser) {
	loadFromStorage();

	// Save to localStorage and trigger sync on any data change
	todos.subscribe(() => {
		saveToStorage();
		import('./sync').then(({ triggerSync }) => triggerSync());
	});
	calendarEvents.subscribe(() => {
		saveToStorage();
		import('./sync').then(({ triggerSync }) => triggerSync());
	});
	diaryEntries.subscribe(() => {
		saveToStorage();
		import('./sync').then(({ triggerSync }) => triggerSync());
	});
	projects.subscribe(() => {
		saveToStorage();
		import('./sync').then(({ triggerSync }) => triggerSync());
	});
	sprints.subscribe(() => {
		saveToStorage();
		import('./sync').then(({ triggerSync }) => triggerSync());
	});
	kanbanColumns.subscribe(saveToStorage);

	// Initialize sync engine for server sync
	import('./sync').then(({ initSync }) => {
		initSync();
	});
}

// Helper function to generate IDs
export function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Todo CRUD operations
export function addTodo(todo: Omit<Todo, 'id' | 'createdAt' | 'updatedAt'>): Todo {
	const newTodo: Todo = {
		...todo,
		id: generateId(),
		createdAt: Date.now(),
		updatedAt: Date.now()
	};
	todos.update(t => [...t, newTodo]);
	return newTodo;
}

export function updateTodo(id: string, updates: Partial<Todo>): void {
	todos.update(t =>
		t.map(todo =>
			todo.id === id
				? { ...todo, ...updates, updatedAt: Date.now() }
				: todo
		)
	);
}

export function deleteTodo(id: string): void {
	todos.update(t => t.filter(todo => todo.id !== id));
}

export function completeTodo(id: string): void {
	updateTodo(id, { status: 'done', completedAt: Date.now() });
}

// Calendar Event CRUD operations
export function addCalendarEvent(event: Omit<CalendarEvent, 'id'>): CalendarEvent {
	const newEvent: CalendarEvent = {
		...event,
		id: generateId()
	};
	calendarEvents.update(e => [...e, newEvent]);
	return newEvent;
}

export function updateCalendarEvent(id: string, updates: Partial<CalendarEvent>): void {
	calendarEvents.update(e =>
		e.map(event =>
			event.id === id ? { ...event, ...updates } : event
		)
	);
}

export function deleteCalendarEvent(id: string): void {
	calendarEvents.update(e => e.filter(event => event.id !== id));
}

// Diary Entry CRUD operations
export function addDiaryEntry(entry: Omit<DiaryEntry, 'id' | 'createdAt' | 'updatedAt'>): DiaryEntry {
	const newEntry: DiaryEntry = {
		...entry,
		id: generateId(),
		createdAt: Date.now(),
		updatedAt: Date.now()
	};
	diaryEntries.update(d => [...d, newEntry]);
	return newEntry;
}

export function updateDiaryEntry(id: string, updates: Partial<DiaryEntry>): void {
	diaryEntries.update(d =>
		d.map(entry =>
			entry.id === id
				? { ...entry, ...updates, updatedAt: Date.now() }
				: entry
		)
	);
}

export function deleteDiaryEntry(id: string): void {
	diaryEntries.update(d => d.filter(entry => entry.id !== id));
}

// Project CRUD operations
export function addProject(project: Omit<Project, 'id' | 'createdAt'>): Project {
	const newProject: Project = {
		...project,
		id: generateId(),
		createdAt: Date.now()
	};
	projects.update(p => [...p, newProject]);
	return newProject;
}

export function updateProject(id: string, updates: Partial<Project>): void {
	projects.update(p =>
		p.map(project =>
			project.id === id ? { ...project, ...updates } : project
		)
	);
}

export function deleteProject(id: string): void {
	// Get all child projects recursively
	const allChildIds = getChildProjectIds(id);
	const idsToDelete = [id, ...allChildIds];

	projects.update(p => p.filter(project => !idsToDelete.includes(project.id)));
	// Also delete associated todos and sprints
	todos.update(t => t.filter(todo => !todo.projectId || !idsToDelete.includes(todo.projectId)));
	sprints.update(s => s.filter(sprint => !idsToDelete.includes(sprint.projectId)));
}

// Helper to get all child project IDs recursively
function getChildProjectIds(parentId: string): string[] {
	const allProjects = get(projects);
	const directChildren = allProjects.filter(p => p.parentId === parentId);
	let allChildren = directChildren.map(p => p.id);

	for (const child of directChildren) {
		allChildren = [...allChildren, ...getChildProjectIds(child.id)];
	}

	return allChildren;
}

// Get root projects (no parent)
export const rootProjects = derived(projects, ($projects) => {
	return $projects.filter(p => !p.parentId);
});

// Get sub-projects for a given parent
export function getSubProjects(parentId: string): Project[] {
	return get(projects).filter(p => p.parentId === parentId);
}

// Derived store for project tree structure
export const projectTree = derived(projects, ($projects) => {
	const buildTree = (parentId: string | undefined): (Project & { children: any[] })[] => {
		return $projects
			.filter(p => p.parentId === parentId)
			.map(p => ({
				...p,
				children: buildTree(p.id)
			}));
	};
	return buildTree(undefined);
});

// Sprint CRUD operations
export function addSprint(sprint: Omit<Sprint, 'id'>): Sprint {
	const newSprint: Sprint = {
		...sprint,
		id: generateId()
	};
	sprints.update(s => [...s, newSprint]);
	return newSprint;
}

export function updateSprint(id: string, updates: Partial<Sprint>): void {
	sprints.update(s =>
		s.map(sprint =>
			sprint.id === id ? { ...sprint, ...updates } : sprint
		)
	);
}

export function deleteSprint(id: string): void {
	sprints.update(s => s.filter(sprint => sprint.id !== id));
}

// Derived stores for filtered/computed data
export const filteredTodos = derived(
	[todos, todoFilters],
	([$todos, $filters]) => {
		let result = [...$todos];

		if ($filters.status?.length) {
			result = result.filter(t => $filters.status!.includes(t.status));
		}
		if ($filters.priority?.length) {
			result = result.filter(t => $filters.priority!.includes(t.priority));
		}
		if ($filters.projectId) {
			result = result.filter(t => t.projectId === $filters.projectId);
		}
		if ($filters.assignedTo) {
			result = result.filter(t => t.assignedTo === $filters.assignedTo);
		}
		if ($filters.dueBefore) {
			result = result.filter(t => t.dueDate && t.dueDate <= $filters.dueBefore!);
		}
		if ($filters.dueAfter) {
			result = result.filter(t => t.dueDate && t.dueDate >= $filters.dueAfter!);
		}
		if ($filters.tags?.length) {
			result = result.filter(t =>
				t.tags?.some(tag => $filters.tags!.includes(tag))
			);
		}

		return result;
	}
);

export const todosByStatus = derived(todos, ($todos) => {
	return {
		ideas: $todos.filter(t => t.status === 'ideas'),
		todo: $todos.filter(t => t.status === 'todo'),
		in_progress: $todos.filter(t => t.status === 'in_progress'),
		done: $todos.filter(t => t.status === 'done'),
		scrapped: $todos.filter(t => t.status === 'scrapped'),
		archived: $todos.filter(t => t.status === 'archived')
	};
});

// Visible kanban columns (filtered by visibility setting)
export const visibleKanbanColumns = derived(kanbanColumns, ($columns) => {
	return $columns.filter(c => c.visible);
});

// Kanban column management functions
export function toggleColumnVisibility(columnId: TodoStatus): void {
	kanbanColumns.update(cols =>
		cols.map(col =>
			col.id === columnId ? { ...col, visible: !col.visible } : col
		)
	);
}

export function updateColumnLabel(columnId: TodoStatus, newLabel: string): void {
	kanbanColumns.update(cols =>
		cols.map(col =>
			col.id === columnId ? { ...col, label: newLabel } : col
		)
	);
}

export function reorderColumns(fromIndex: number, toIndex: number): void {
	kanbanColumns.update(cols => {
		const newCols = [...cols];
		const [removed] = newCols.splice(fromIndex, 1);
		newCols.splice(toIndex, 0, removed);
		return newCols;
	});
}

export function resetColumnsToDefault(): void {
	kanbanColumns.set(DEFAULT_KANBAN_COLUMNS);
}

// Archive old completed tasks
export function archiveOldCompletedTasks(olderThanDays: number = 30): number {
	const cutoffDate = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
	let archivedCount = 0;

	todos.update(t =>
		t.map(todo => {
			if (todo.status === 'done' && todo.completedAt && todo.completedAt < cutoffDate) {
				archivedCount++;
				return { ...todo, status: 'archived' as TodoStatus, updatedAt: Date.now() };
			}
			return todo;
		})
	);

	return archivedCount;
}

export const upcomingEvents = derived(
	[calendarEvents, selectedDate],
	([$events, $date]) => {
		const now = Date.now();
		const weekFromNow = now + 7 * 24 * 60 * 60 * 1000;
		return $events
			.filter(e => e.startDate >= now && e.startDate <= weekFromNow)
			.sort((a, b) => a.startDate - b.startDate);
	}
);

export const todaysTodos = derived(todos, ($todos) => {
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const tomorrow = new Date(today);
	tomorrow.setDate(tomorrow.getDate() + 1);

	return $todos.filter(t =>
		t.dueDate &&
		t.dueDate >= today.getTime() &&
		t.dueDate < tomorrow.getTime() &&
		t.status !== 'done'
	);
});

export const overdueTodos = derived(todos, ($todos) => {
	const now = Date.now();
	return $todos.filter(t =>
		t.dueDate &&
		t.dueDate < now &&
		t.status !== 'done'
	);
});

// Burn chart data generator
export function generateBurnChartData(
	projectId: string,
	startDate: number,
	endDate: number
): BurnChartDataPoint[] {
	const projectTodos = get(todos).filter(t => t.projectId === projectId);
	const totalPoints = projectTodos.length; // Simple: 1 todo = 1 point

	const data: BurnChartDataPoint[] = [];
	const dayMs = 24 * 60 * 60 * 1000;

	for (let date = startDate; date <= endDate; date += dayMs) {
		const completedByDate = projectTodos.filter(
			t => t.completedAt && t.completedAt <= date
		).length;

		data.push({
			date,
			totalPoints,
			completedPoints: completedByDate,
			remainingPoints: totalPoints - completedByDate
		});
	}

	return data;
}

// Get events for a specific date range
export function getEventsForDateRange(start: number, end: number): CalendarEvent[] {
	return get(calendarEvents).filter(e =>
		(e.startDate >= start && e.startDate <= end) ||
		(e.endDate && e.endDate >= start && e.startDate <= end)
	);
}

// Get diary entry for a specific date
export function getDiaryEntryForDate(date: number): DiaryEntry | undefined {
	const dayStart = new Date(date);
	dayStart.setHours(0, 0, 0, 0);
	const dayEnd = new Date(dayStart);
	dayEnd.setDate(dayEnd.getDate() + 1);

	return get(diaryEntries).find(e =>
		e.date >= dayStart.getTime() && e.date < dayEnd.getTime()
	);
}
