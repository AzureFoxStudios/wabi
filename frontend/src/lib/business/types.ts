// Business Management Types

export type TodoStatus = 'ideas' | 'todo' | 'in_progress' | 'done' | 'scrapped' | 'archived';

export interface Todo {
	id: string;
	title: string;
	description?: string;
	status: TodoStatus;
	priority: 'low' | 'medium' | 'high' | 'urgent';
	dueDate?: number; // timestamp
	createdAt: number;
	updatedAt: number;
	createdBy: string; // user id
	assignedTo?: string; // user id
	tags?: string[];
	projectId?: string;
	completedAt?: number;
}

export interface KanbanColumn {
	id: TodoStatus;
	label: string;
	color: string;
	visible: boolean;
}

export interface CalendarEvent {
	id: string;
	title: string;
	description?: string;
	startDate: number; // timestamp
	endDate?: number; // timestamp (for multi-day events)
	allDay: boolean;
	color?: string;
	createdBy: string;
	recurring?: {
		frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
		interval: number; // every N days/weeks/months/years
		endDate?: number;
	};
	reminders?: number[]; // minutes before event
	cancelledDates?: number[]; // timestamps of cancelled recurring instances
}

export interface DiaryEntry {
	id: string;
	date: number; // timestamp for the day
	content: string; // markdown content
	images?: string[]; // base64 encoded images or URLs for physical notes photos
	tags?: string[];
	createdBy: string;
	createdAt: number;
	updatedAt: number;
	isPrivate: boolean; // only visible to creator
}

export interface Project {
	id: string;
	name: string;
	description?: string;
	color: string;
	createdBy: string;
	createdAt: number;
	startDate?: number;
	targetEndDate?: number;
	status: 'planning' | 'active' | 'paused' | 'completed' | 'cancelled';
	parentId?: string; // For sub-projects
}

export interface Sprint {
	id: string;
	projectId: string;
	name: string;
	startDate: number;
	endDate: number;
	goals?: string[];
	status: 'planned' | 'active' | 'completed';
}

export interface BurnChartDataPoint {
	date: number;
	totalPoints: number;
	completedPoints: number;
	remainingPoints: number;
}

// View types for the dashboard
export type DashboardView = 'overview' | 'todos' | 'calendar' | 'diary' | 'projects';

// Filter/sort options
export interface TodoFilters {
	status?: Todo['status'][];
	priority?: Todo['priority'][];
	projectId?: string;
	assignedTo?: string;
	dueBefore?: number;
	dueAfter?: number;
	tags?: string[];
}

export interface CalendarFilters {
	startDate: number;
	endDate: number;
	projectId?: string;
}
