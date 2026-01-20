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
	BurnChartDataPoint,
	Resource,
	Tag,
	GraphEdge
} from './types';

// Default kanban columns configuration
const DEFAULT_KANBAN_COLUMNS: KanbanColumn[] = [
	{ id: 'ideas', label: 'Ideas', color: '#a855f7', visible: true },
	{ id: 'todo', label: 'To Do', color: '#64748b', visible: true },
	{ id: 'in_progress', label: 'In Progress', color: '#3b82f6', visible: true },
	{ id: 'done', label: 'Done', color: '#10b981', visible: true },
	{ id: 'scrapped', label: 'Parked (Get to later)', color: '#f59e0b', visible: false },
	{ id: 'archived', label: 'Archived', color: '#475569', visible: false }
];

// Core data stores
export const todos = writable<Todo[]>([]);
export const calendarEvents = writable<CalendarEvent[]>([]);
export const diaryEntries = writable<DiaryEntry[]>([]);
export const projects = writable<Project[]>([]);
export const sprints = writable<Sprint[]>([]);
export const kanbanColumns = writable<KanbanColumn[]>(DEFAULT_KANBAN_COLUMNS);

// Knowledge Graph stores
export const resources = writable<Resource[]>([]);
export const tags = writable<Tag[]>([]);
export const graphEdges = writable<GraphEdge[]>([]);

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
			// Knowledge Graph entities
			if (data.resources) resources.set(data.resources);
			if (data.tags) tags.set(data.tags);
			if (data.graphEdges) graphEdges.set(data.graphEdges);
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
			kanbanColumns: get(kanbanColumns),
			resources: get(resources),
			tags: get(tags),
			graphEdges: get(graphEdges)
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

	// Knowledge Graph subscriptions
	resources.subscribe(() => {
		saveToStorage();
		import('./sync').then(({ triggerSync }) => triggerSync());
	});
	tags.subscribe(() => {
		saveToStorage();
		import('./sync').then(({ triggerSync }) => triggerSync());
	});
	graphEdges.subscribe(() => {
		saveToStorage();
		import('./sync').then(({ triggerSync }) => triggerSync());
	});

	// Initialize sync engine for server sync
	import('./sync').then(({ initSync }) => {
		initSync();
	});

	// Initialize sample data if empty
	initializeSampleData();
}

// Helper function to generate IDs
export function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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
		const sampleEdges = [
			{
				source: addedResources[0].id,
				target: addedResources[1].id,
				type: 'related',
				label: 'similar topic'
			},
			{
				source: addedResources[1].id,
				target: addedResources[2].id,
				type: 'related',
				label: 'same category'
			},
			{
				source: addedResources[0].id,
				target: addedResources[4].id,
				type: 'uses',
				label: 'used by'
			},
			{
				source: addedResources[3].id,
				target: addedResources[4].id,
				type: 'related',
				label: 'complementary'
			},
			{
				source: addedResources[2].id,
				target: addedResources[5].id,
				type: 'related',
				label: 'technique'
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

// Resource CRUD operations
export function addResource(resource: Omit<Resource, 'id' | 'createdAt' | 'updatedAt'>): Resource {
	const newResource: Resource = {
		...resource,
		id: generateId(),
		createdAt: Date.now(),
		updatedAt: Date.now()
	};
	resources.update(r => [...r, newResource]);
	return newResource;
}

export function updateResource(id: string, updates: Partial<Resource>): void {
	resources.update(r =>
		r.map(resource =>
			resource.id === id
				? { ...resource, ...updates, updatedAt: Date.now() }
				: resource
		)
	);
}

export function deleteResource(id: string): void {
	resources.update(r => r.filter(resource => resource.id !== id));
}

export function getResource(id: string): Resource | undefined {
	return get(resources).find(r => r.id === id);
}

// Tag CRUD operations
export function addTag(tag: Omit<Tag, 'id'>): Tag {
	const newTag: Tag = {
		...tag,
		id: generateId()
	};
	tags.update(t => [...t, newTag]);
	return newTag;
}

export function updateTag(id: string, updates: Partial<Tag>): void {
	tags.update(t =>
		t.map(tag =>
			tag.id === id ? { ...tag, ...updates } : tag
		)
	);
}

export function deleteTag(id: string): void {
	tags.update(t => t.filter(tag => tag.id !== id));
}

export function getTag(id: string): Tag | undefined {
	return get(tags).find(t => t.id === id);
}

// Graph Edge CRUD operations
export function addGraphEdge(edge: Omit<GraphEdge, 'id'>): GraphEdge {
	const newEdge: GraphEdge = {
		...edge,
		id: generateId()
	};
	graphEdges.update(e => [...e, newEdge]);
	return newEdge;
}

export function updateGraphEdge(id: string, updates: Partial<GraphEdge>): void {
	graphEdges.update(e =>
		e.map(edge =>
			edge.id === id ? { ...edge, ...updates } : edge
		)
	);
}

export function deleteGraphEdge(id: string): void {
	graphEdges.update(e => e.filter(edge => edge.id !== id));
}

export function getGraphEdge(id: string): GraphEdge | undefined {
	return get(graphEdges).find(e => e.id === id);
}

// Get all edges connected to a node
export function getConnectedEdges(nodeId: string): GraphEdge[] {
	return get(graphEdges).filter(e => e.source === nodeId || e.target === nodeId);
}

// Get all resources with a specific tag
export function getResourcesByTag(tagId: string): Resource[] {
	return get(resources).filter(r => r.tags.includes(tagId));
}

// Search resources by name or description
export function searchResources(query: string): Resource[] {
	const lowerQuery = query.toLowerCase();
	return get(resources).filter(r =>
		r.name.toLowerCase().includes(lowerQuery) ||
		r.description?.toLowerCase().includes(lowerQuery)
	);
}
