import { derived, get } from 'svelte/store';
import { browser } from '$app/environment';
import { startupMark, startupMeasure } from '$lib/startupProfiler';
import type {
	Todo,
	TodoStatus,
	CalendarEvent,
	DiaryEntry,
	Project,
	Sprint,
	BurnChartDataPoint,
	Resource,
	Tag,
	GraphEdge
} from './types';
import { getBusinessDataSnapshot, applyBusinessDataSnapshot } from './snapshot';
import { parseBusinessDataJson } from './validation';
import { generateId } from './utils';
import { addResource, addGraphEdge } from './resourceStore';
import {
	DEFAULT_KANBAN_COLUMNS,
	todos,
	calendarEvents,
	diaryEntries,
	projects,
	sprints,
	kanbanColumns,
	resources,
	tags,
	graphEdges,
	selectedDate,
	todoFilters
} from './state';

export {
	todos,
	calendarEvents,
	diaryEntries,
	projects,
	sprints,
	kanbanColumns,
	resources,
	tags,
	graphEdges,
	currentView,
	selectedDate,
	selectedProjectId,
	todoFilters
} from './state';

export {
	addResource, updateResource, deleteResource, getResource,
	addTag, updateTag, deleteTag, getTag,
	addGraphEdge, updateGraphEdge, deleteGraphEdge, getGraphEdge,
	getConnectedEdges, getResourcesByTag, searchResources
} from './resourceStore';

export { addSprint, updateSprint, deleteSprint } from './sprintStore';
export { addProject, updateProject, deleteProject, getSubProjects } from './projectStore';

export { generateId } from './utils';

// Local storage persistence
const STORAGE_KEY = 'business_data';
let syncInitScheduled = false;

function loadFromStorage() {
	if (!browser) return;
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved) {
			applyBusinessDataSnapshot(parseBusinessDataJson(saved));
		}
	} catch (e) {
		console.error('Failed to load business data from localStorage:', e);
	}
}

function saveToStorage() {
	if (!browser) return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(getBusinessDataSnapshot()));
	} catch (e) {
		console.error('Failed to save business data to localStorage:', e);
	}
}

// Auto-save on changes
if (browser) {
	// Ready flag prevents store subscriptions from triggering sync during init
	let ready = false;

	loadFromStorage();

	// Save to localStorage and trigger sync on any data change
	const syncOnChange = () => {
		saveToStorage();
		if (ready) {
			import('./sync').then(({ triggerSync }) => triggerSync());
		}
	};

	todos.subscribe(syncOnChange);
	calendarEvents.subscribe(syncOnChange);
	diaryEntries.subscribe(syncOnChange);
	projects.subscribe(syncOnChange);
	sprints.subscribe(syncOnChange);
	kanbanColumns.subscribe(saveToStorage);

	// Knowledge Graph subscriptions
	resources.subscribe(syncOnChange);
	tags.subscribe(syncOnChange);
	graphEdges.subscribe(syncOnChange);

	// All subscriptions registered and storage loaded — enable sync
	ready = true;

	// Initialize sync engine during idle time so first paint/socket init stay responsive.
	const scheduleSyncInit = () => {
		if (syncInitScheduled) return;
		syncInitScheduled = true;
		const run = () => {
			startupMark('business:sync:init:start');
			import('./sync').then(({ initSync }) => {
				initSync();
				startupMark('business:sync:init:end');
				startupMeasure('business:sync:init', 'business:sync:init:start', 'business:sync:init:end');
			});
		};
		const ric = (window as Window & {
			requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
		}).requestIdleCallback;
		if (ric) {
			ric(run, { timeout: 2500 });
			return;
		}
		setTimeout(run, 800);
	};
	scheduleSyncInit();

	// Initialize sample data only when explicitly enabled in development.
	// This prevents accidental overwrites/noise in real business workspaces.
	const enableSampleData = import.meta.env.DEV && localStorage.getItem('enableBusinessSampleData') === 'true';
	if (enableSampleData) {
		initializeSampleData();
	}
}

// Initialize sample data for demo/testing
function initializeSampleData() {
	// Only add sample data if resources are empty AND no server connection
	const currentResources = get(resources);
	if (currentResources.length > 0) return; // Already have data locally

	// Sample resources
	const sampleResources: Omit<Resource, 'id' | 'createdAt' | 'updatedAt'>[] = [
		{
			name: 'Brush Pack - Watercolor',
			type: 'brush',
			description: 'Professional watercolor brush set for digital painting',
			createdBy: 'Alice',
			isAnonymous: false,
			tags: ['brush', 'watercolor', 'painting'],
			fileUrl: '/brushes/watercolor.abr',
			storageType: 'external',
			visibilityType: 'public'
		},
		{
			name: 'Color Theory Guide',
			type: 'note',
			description: 'Comprehensive guide to color harmony and theory',
			createdBy: 'Bob',
			isAnonymous: false,
			tags: ['color', 'theory', 'tutorial'],
			storageType: 'inline',
			visibilityType: 'public'
		},
		{
			name: 'Digital Painting Tutorial',
			type: 'url',
			description: 'Learn advanced digital painting techniques',
			createdBy: 'Charlie',
			isAnonymous: false,
			tags: ['painting', 'tutorial', 'digital'],
			externalUrl: 'https://example.com/tutorials/digital-painting',
			storageType: 'external',
			visibilityType: 'public'
		},
		{
			name: 'Texture Pack - Nature',
			type: 'file',
			description: 'Natural textures for background and surface details',
			createdBy: 'Diana',
			isAnonymous: false,
			tags: ['texture', 'nature', 'assets'],
			fileUrl: '/textures/nature-pack.zip',
			storageType: 'external',
			visibilityType: 'public'
		},
		{
			name: 'Character Design Reference',
			type: 'image',
			description: 'Reference images for character design and anatomy',
			createdBy: 'Eve',
			isAnonymous: false,
			tags: ['character', 'design', 'reference'],
			fileUrl: '/images/character-ref.jpg',
			preview: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22150%22%3E%3Crect fill=%22%234f46e5%22 width=%22200%22 height=%22150%22/%3E%3Ctext fill=%22white%22 x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22%3ECharacter Design%3C/text%3E%3C/svg%3E',
			storageType: 'external',
			visibilityType: 'public'
		},
		{
			name: 'Perspective Techniques',
			type: 'code',
			description: 'Code snippets and techniques for perspective drawing',
			createdBy: 'Frank',
			isAnonymous: false,
			tags: ['perspective', 'technique', 'drawing'],
			storageType: 'inline',
			visibilityType: 'public'
		}
	];

	// Add sample resources
	const addedResources: Resource[] = [];
	sampleResources.forEach(res => {
		addedResources.push(addResource(res));
	});

	// Sample edges (connections between resources)
	if (addedResources.length >= 2) {
		const sampleEdges: Omit<GraphEdge, 'id'>[] = [
			{
				source: addedResources[0].id,
				target: addedResources[1].id,
				type: 'related_to',
				label: 'similar topic',
				createdAt: Date.now(),
				createdBy: 'system'
			},
			{
				source: addedResources[1].id,
				target: addedResources[2].id,
				type: 'related_to',
				label: 'same category',
				createdAt: Date.now(),
				createdBy: 'system'
			},
			{
				source: addedResources[0].id,
				target: addedResources[4].id,
				type: 'references',
				label: 'used by',
				createdAt: Date.now(),
				createdBy: 'system'
			},
			{
				source: addedResources[3].id,
				target: addedResources[4].id,
				type: 'related_to',
				label: 'complementary',
				createdAt: Date.now(),
				createdBy: 'system'
			},
			{
				source: addedResources[2].id,
				target: addedResources[5].id,
				type: 'related_to',
				label: 'technique',
				createdAt: Date.now(),
				createdBy: 'system'
			}
		];

		sampleEdges.forEach(edge => {
			addGraphEdge(edge);
		});
	}
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

// Get root projects (no parent)
export const rootProjects = derived(projects, ($projects) => {
	return $projects.filter(p => !p.parentId);
});

// Derived store for project tree structure
export const projectTree = derived(projects, ($projects) => {
	const buildTree = (parentId: string | undefined): (Project & { children: any[] })[] => {
		return $projects
			.filter(p => p.parentId === parentId)
			.map(p => ({ ...p, children: buildTree(p.id) }));
	};
	return buildTree(undefined);
});

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
		t.status !== 'done' &&
		t.status !== 'archived' &&
		t.status !== 'scrapped'
	);
});

export const overdueTodos = derived(todos, ($todos) => {
	const now = Date.now();
	return $todos.filter(t =>
		t.dueDate &&
		t.dueDate < now &&
		t.status !== 'done' &&
		t.status !== 'archived' &&
		t.status !== 'scrapped'
	);
});

// Burn chart data generator
export function generateBurnChartData(
	projectId: string,
	startDate: number,
	endDate: number
): BurnChartDataPoint[] {
	const projectTodos = get(todos).filter(t => t.projectId === projectId);
	const getEstimatedHours = (todo: Todo): number => {
		if (typeof todo.estimatedMinutes === 'number' && todo.estimatedMinutes > 0) {
			return todo.estimatedMinutes / 60;
		}
		// Stable fallback for legacy tasks so mixed backlogs do not suddenly shrink.
		return 1;
	};

	const totalPoints = projectTodos.reduce((sum, todo) => sum + getEstimatedHours(todo), 0);

	const data: BurnChartDataPoint[] = [];
	const dayMs = 24 * 60 * 60 * 1000;

	for (let date = startDate; date <= endDate; date += dayMs) {
		const completedByDate = projectTodos
			.filter(t => t.completedAt && t.completedAt <= date)
			.reduce((sum, todo) => sum + getEstimatedHours(todo), 0);

		data.push({
			date,
			totalPoints: Math.max(0, Number(totalPoints.toFixed(2))),
			completedPoints: completedByDate,
			remainingPoints: Math.max(0, Number((totalPoints - completedByDate).toFixed(2)))
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
