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
	signedBy?: string; // Optional signature with username
	visibility?: 'public' | 'private'; // Defaults to 'public' if not set
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
	startDate: number; // timestamp (Unix milliseconds)
	endDate?: number; // timestamp (for multi-day events)
	allDay: boolean;
	color?: string;
	createdBy: string;
	recurring?: {
		frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
		interval: number; // every N days/weeks/months/years
		endDate?: number;
	};
	reminders?: Int32Array | number[]; // minutes before event (using Int32Array for efficiency)
	cancelledDates?: BigInt64Array | number[]; // timestamps of cancelled recurring instances
	signedBy?: string; // Optional signature with username
	visibility?: 'public' | 'private'; // Defaults to 'public' if not set
}

export interface DiaryEntry {
	id: string;
	date: number; // timestamp for the day
	content: string; // markdown content
	mood?: 'great' | 'good' | 'neutral' | 'bad' | 'awful';
	images?: string[]; // base64 encoded images or URLs for physical notes photos
	tags?: string[];
	createdBy: string;
	createdAt: number;
	updatedAt: number;
	isPrivate: boolean; // only visible to creator
	signedBy?: string; // Optional signature with username
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
	signedBy?: string; // Optional signature with username
	visibility?: 'public' | 'private'; // Defaults to 'public' if not set
}

export interface Sprint {
	id: string;
	projectId: string;
	name: string;
	startDate: number;
	endDate: number;
	goals?: string[];
	status: 'planned' | 'active' | 'completed';
	signedBy?: string; // Optional signature with username
	visibility?: 'public' | 'private'; // Defaults to 'public' if not set
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

// Knowledge Graph & Resource Types
export interface Resource {
	id: string;
	type: 'brush' | 'code' | 'image' | 'url' | 'note' | 'file' | 'youtube' | 'video' | 'pdf' | 'audio' | 'ebook' | 'document' | 'archive';
	name: string;
	description?: string;
	storageType: 'inline' | 'upload' | 'external';
	content?: string; // For inline (base64 or text) - store file data as data URI
	fileUrl?: string; // For uploads: /uploads/res-123.zip
	externalUrl?: string; // For external URLs (including YouTube URLs)
	fileSize?: number;
	mimeType?: string;
	preview?: string; // Thumbnail URL or base64
	tags: string[];
	createdBy: string;
	createdAt: number;
	updatedAt: number;
	// Privacy fields
	isAnonymous?: boolean;
	visibilityType?: 'public' | 'role_restricted' | 'private' | 'personal';
	minRole?: 'admin' | 'mod' | 'contributor' | 'viewer' | 'owner';
	isEncrypted?: boolean;
	workspaceId?: string;
}

export type UserRole = 'admin' | 'mod' | 'contributor' | 'viewer' | 'owner';

export interface Tag {
	id: string;
	name: string;
	color: string;
	createdAt: number;
}

export type NodeType = 'todo' | 'project' | 'diary_entry' | 'resource' | 'tag' | 'sprint';
export type EdgeType = 'contains' | 'depends_on' | 'references' | 'tagged_with' | 'related_to' | 'inspired_by';

export interface GraphNode {
	id: string;
	type: NodeType;
	label: string;
	data: Todo | Project | DiaryEntry | Resource | Tag | Sprint;
	position?: { x: number; y: number };
	collapsed?: boolean;
}

export interface GraphEdge {
	id: string;
	source: string; // Node ID
	target: string; // Node ID
	type: EdgeType;
	label?: string;
	weight?: number;
	createdAt: number;
	createdBy: string;
}
