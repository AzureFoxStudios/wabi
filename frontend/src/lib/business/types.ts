import type {
	BusinessDataCollections as SharedBusinessDataCollections,
	BusinessVisibility as SharedBusinessVisibility,
	CalendarEvent as SharedCalendarEvent,
	DiaryEntry as SharedDiaryEntry,
	EdgeType as SharedEdgeType,
	GraphEdge as SharedGraphEdge,
	ItemSignature as SharedItemSignature,
	NodeType as SharedNodeType,
	Project as SharedProject,
	Resource as SharedResource,
	Sprint as SharedSprint,
	Tag as SharedTag,
	Todo as SharedTodo,
	TodoStatus as SharedTodoStatus,
	UserRole as SharedUserRole
} from '../../../../shared/businessContracts';

export type BusinessVisibility = SharedBusinessVisibility;
export type ItemSignature = SharedItemSignature;
export type BusinessDataCollections = SharedBusinessDataCollections;
export type TodoStatus = SharedTodoStatus;
export type Todo = SharedTodo;
export type CalendarEvent = SharedCalendarEvent;
export type DiaryEntry = SharedDiaryEntry;
export type Project = SharedProject;
export type Sprint = SharedSprint;
export type Resource = SharedResource;
export type UserRole = SharedUserRole;
export type Tag = SharedTag;
export type NodeType = SharedNodeType;
export type EdgeType = SharedEdgeType;
export type GraphEdge = SharedGraphEdge;

export interface KanbanColumn {
	id: TodoStatus;
	label: string;
	color: string;
	visible: boolean;
}

export interface BurnChartDataPoint {
	date: number;
	totalPoints: number;
	completedPoints: number;
	remainingPoints: number;
}

export type DashboardView = 'overview' | 'todos' | 'calendar' | 'diary' | 'projects';

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

export interface GraphNode {
	id: string;
	type: NodeType;
	label: string;
	data: Todo | Project | DiaryEntry | Resource | Tag | Sprint;
	position?: { x: number; y: number };
	collapsed?: boolean;
}

export interface BusinessDataSnapshot extends SharedBusinessDataCollections {
	kanbanColumns: KanbanColumn[];
}
