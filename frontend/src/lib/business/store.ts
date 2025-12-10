import { writable, derived, get } from 'svelte/store';
import { browser } from '$app/environment';
import type {
	Todo,
	CalendarEvent,
	DiaryEntry,
	Project,
	Sprint,
	DashboardView,
	TodoFilters,
	BurnChartDataPoint
} from './types';

// Core data stores
export const todos = writable<Todo[]>([]);
export const calendarEvents = writable<CalendarEvent[]>([]);
export const diaryEntries = writable<DiaryEntry[]>([]);
export const projects = writable<Project[]>([]);
export const sprints = writable<Sprint[]>([]);

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
			if (data.todos) todos.set(data.todos);
			if (data.calendarEvents) calendarEvents.set(data.calendarEvents);
			if (data.diaryEntries) diaryEntries.set(data.diaryEntries);
			if (data.projects) projects.set(data.projects);
			if (data.sprints) sprints.set(data.sprints);
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
			sprints: get(sprints)
		};
		localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
	} catch (e) {
		console.error('Failed to save business data to localStorage:', e);
	}
}

// Auto-save on changes
if (browser) {
	loadFromStorage();
	todos.subscribe(saveToStorage);
	calendarEvents.subscribe(saveToStorage);
	diaryEntries.subscribe(saveToStorage);
	projects.subscribe(saveToStorage);
	sprints.subscribe(saveToStorage);
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
	projects.update(p => p.filter(project => project.id !== id));
	// Also delete associated todos and sprints
	todos.update(t => t.filter(todo => todo.projectId !== id));
	sprints.update(s => s.filter(sprint => sprint.projectId !== id));
}

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
		todo: $todos.filter(t => t.status === 'todo'),
		in_progress: $todos.filter(t => t.status === 'in_progress'),
		done: $todos.filter(t => t.status === 'done'),
		blocked: $todos.filter(t => t.status === 'blocked')
	};
});

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
