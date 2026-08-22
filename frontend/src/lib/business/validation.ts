import { DEFAULT_KANBAN_COLUMNS } from './state';
import type {
	BusinessDataSnapshot,
	CalendarEvent,
	DiaryEntry,
	EdgeType,
	GraphEdge,
	KanbanColumn,
	ItemSignature,
	LoreCitationRef,
	Project,
	Resource,
	Sprint,
	Tag,
	Todo,
	TodoStatus,
	UserRole
} from './types';
const TODO_STATUSES = new Set<TodoStatus>([
	'ideas',
	'todo',
	'in_progress',
	'done',
	'scrapped',
	'archived'
]);
const TODO_PRIORITIES = new Set<Todo['priority']>(['low', 'medium', 'high', 'urgent']);
const PROJECT_STATUSES = new Set<Project['status']>(['planning', 'active', 'paused', 'completed', 'cancelled']);
const SPRINT_STATUSES = new Set<Sprint['status']>(['planned', 'active', 'completed']);
const CALENDAR_FREQUENCIES = new Set<NonNullable<CalendarEvent['recurring']>['frequency']>([
	'daily',
	'weekly',
	'monthly',
	'yearly'
]);
const RESOURCE_TYPES = new Set<Resource['type']>([
	'brush',
	'code',
	'image',
	'url',
	'note',
	'file',
	'youtube',
	'video',
	'pdf',
	'audio',
	'ebook',
	'document',
	'archive'
]);
const STORAGE_TYPES = new Set<Resource['storageType']>(['inline', 'upload', 'external']);
const VISIBILITY_TYPES = new Set<NonNullable<Resource['visibilityType']>>([
	'public',
	'role_restricted',
	'private',
	'personal'
]);
const MIN_ROLES = new Set<UserRole>(['admin', 'mod', 'contributor', 'viewer', 'owner']);
const EDGE_TYPES = new Set<EdgeType>([
	'contains',
	'depends_on',
	'references',
	'tagged_with',
	'related_to',
	'inspired_by'
]);
const TODO_VISIBILITIES = new Set<NonNullable<Todo['visibility']>>(['public', 'private']);
const PROJECT_VISIBILITIES = new Set<NonNullable<Project['visibility']>>(['public', 'private']);
const SPRINT_VISIBILITIES = new Set<NonNullable<Sprint['visibility']>>(['public', 'private']);
const CALENDAR_VISIBILITIES = new Set<NonNullable<CalendarEvent['visibility']>>(['public', 'private']);

function createFallbackId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value
		.map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
		.filter(Boolean);
	return items.length > 0 ? items : [];
}

function asNumberArray(value: unknown): number[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry));
	return items;
}

function normalizeTodoStatus(value: unknown): TodoStatus {
	if (value === 'blocked') return 'scrapped';
	return typeof value === 'string' && TODO_STATUSES.has(value as TodoStatus)
		? (value as TodoStatus)
		: 'todo';
}

function sanitizeTodoVisibility(value: unknown): Todo['visibility'] {
	return typeof value === 'string' && TODO_VISIBILITIES.has(value as Todo['visibility'])
		? (value as Todo['visibility'])
		: 'public';
}

/** Sanitize a sign-off list; tolerates legacy shapes (missing/invalid entries dropped). */
function sanitizeSignatures(value: unknown): ItemSignature[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items: ItemSignature[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const by = asNonEmptyString(entry.by);
		const name = asNonEmptyString(entry.name);
		const at = asFiniteNumber(entry.at);
		if (!by || !name || at == null) continue;
		items.push({ by, name, at });
	}
	return items.length > 0 ? items : undefined;
}

/** Sanitize lore file references; drops malformed entries. */
function sanitizeLoreRefs(value: unknown): LoreCitationRef[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items: LoreCitationRef[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const channelId = asNonEmptyString(entry.channelId);
		let path = asNonEmptyString(entry.path);
		if (!channelId || !path) continue;
		path = path.replace(/^\/+/, ''); // normalize leading slashes
		const startLine = asFiniteNumber(entry.startLine);
		const endLine = asFiniteNumber(entry.endLine);
		items.push({
			channelId,
			path,
			startLine: startLine && startLine > 0 ? Math.floor(startLine) : undefined,
			endLine: endLine && endLine >= (startLine || 0) ? Math.floor(endLine) : undefined,
			label: asNonEmptyString(entry.label)
		});
	}
	return items.length > 0 ? items : undefined;
}

function sanitizeProjectVisibility(value: unknown): Project['visibility'] {
	return typeof value === 'string' && PROJECT_VISIBILITIES.has(value as Project['visibility'])
		? (value as Project['visibility'])
		: 'public';
}

function sanitizeSprintVisibility(value: unknown): Sprint['visibility'] {
	return typeof value === 'string' && SPRINT_VISIBILITIES.has(value as Sprint['visibility'])
		? (value as Sprint['visibility'])
		: 'public';
}

function sanitizeCalendarVisibility(value: unknown): CalendarEvent['visibility'] {
	return typeof value === 'string' && CALENDAR_VISIBILITIES.has(value as CalendarEvent['visibility'])
		? (value as CalendarEvent['visibility'])
		: 'public';
}

function sanitizeTodo(raw: unknown): Todo | null {
	if (!isRecord(raw)) return null;
	const title = asString(raw.title);
	if (!title) return null;

	const now = Date.now();
	return {
		...raw,
		id: asNonEmptyString(raw.id) ?? createFallbackId('todo'),
		title,
		description: asString(raw.description),
		status: normalizeTodoStatus(raw.status),
		priority: typeof raw.priority === 'string' && TODO_PRIORITIES.has(raw.priority as Todo['priority'])
			? (raw.priority as Todo['priority'])
			: 'medium',
		estimatedMinutes: asFiniteNumber(raw.estimatedMinutes),
		dueDate: asFiniteNumber(raw.dueDate),
		createdAt: asFiniteNumber(raw.createdAt) ?? now,
		updatedAt: asFiniteNumber(raw.updatedAt) ?? now,
		createdBy: asNonEmptyString(raw.createdBy) ?? 'unknown',
		assignedTo: asNonEmptyString(raw.assignedTo),
		tags: asStringArray(raw.tags),
		projectId: asNonEmptyString(raw.projectId),
		completedAt: asFiniteNumber(raw.completedAt),
		loreRefs: sanitizeLoreRefs(raw.loreRefs),
		signedBy: asString(raw.signedBy),
		signatures: sanitizeSignatures(raw.signatures),
		visibility: sanitizeTodoVisibility(raw.visibility)
	};
}

function sanitizeRecurring(value: unknown): CalendarEvent['recurring'] | undefined {
	if (!isRecord(value)) return undefined;
	const frequency = typeof value.frequency === 'string' && CALENDAR_FREQUENCIES.has(value.frequency as NonNullable<CalendarEvent['recurring']>['frequency'])
		? (value.frequency as NonNullable<CalendarEvent['recurring']>['frequency'])
		: null;
	const interval = asFiniteNumber(value.interval);
	if (!frequency || interval == null || interval <= 0) return undefined;
	return {
		frequency,
		interval,
		endDate: asFiniteNumber(value.endDate)
	};
}

function sanitizeCalendarEvent(raw: unknown): CalendarEvent | null {
	if (!isRecord(raw)) return null;
	const title = asString(raw.title);
	const startDate = asFiniteNumber(raw.startDate);
	if (!title || startDate == null) return null;

	return {
		...raw,
		id: asNonEmptyString(raw.id) ?? createFallbackId('event'),
		title,
		description: asString(raw.description),
		startDate,
		endDate: asFiniteNumber(raw.endDate),
		allDay: asBoolean(raw.allDay) ?? false,
		color: asString(raw.color),
		createdBy: asNonEmptyString(raw.createdBy) ?? 'unknown',
		recurring: sanitizeRecurring(raw.recurring),
		reminders: asNumberArray(raw.reminders),
		cancelledDates: asNumberArray(raw.cancelledDates),
		signedBy: asString(raw.signedBy),
		signatures: sanitizeSignatures(raw.signatures),
		visibility: sanitizeCalendarVisibility(raw.visibility)
	};
}

function sanitizeDiaryEntry(raw: unknown): DiaryEntry | null {
	if (!isRecord(raw)) return null;
	const content = asString(raw.content);
	const date = asFiniteNumber(raw.date);
	if (content == null || date == null) return null;

	const now = Date.now();
	const mood = typeof raw.mood === 'string' && ['great', 'good', 'neutral', 'bad', 'awful'].includes(raw.mood)
		? (raw.mood as DiaryEntry['mood'])
		: undefined;

	return {
		...raw,
		id: asNonEmptyString(raw.id) ?? createFallbackId('diary'),
		date,
		content,
		mood,
		images: asStringArray(raw.images),
		tags: asStringArray(raw.tags),
		createdBy: asNonEmptyString(raw.createdBy) ?? 'unknown',
		createdAt: asFiniteNumber(raw.createdAt) ?? now,
		updatedAt: asFiniteNumber(raw.updatedAt) ?? now,
		isPrivate: asBoolean(raw.isPrivate) ?? false,
		signedBy: asString(raw.signedBy),
		signatures: sanitizeSignatures(raw.signatures)
	};
}

function sanitizeProject(raw: unknown): Project | null {
	if (!isRecord(raw)) return null;
	const name = asString(raw.name);
	if (!name) return null;

	const now = Date.now();
	return {
		...raw,
		id: asNonEmptyString(raw.id) ?? createFallbackId('project'),
		name,
		description: asString(raw.description),
		color: asString(raw.color) ?? '#5865f2',
		createdBy: asNonEmptyString(raw.createdBy) ?? 'unknown',
		createdAt: asFiniteNumber(raw.createdAt) ?? now,
		startDate: asFiniteNumber(raw.startDate),
		targetEndDate: asFiniteNumber(raw.targetEndDate),
		status: typeof raw.status === 'string' && PROJECT_STATUSES.has(raw.status as Project['status'])
			? (raw.status as Project['status'])
			: 'planning',
		parentId: asNonEmptyString(raw.parentId),
		channelId: asNonEmptyString(raw.channelId),
		signedBy: asString(raw.signedBy),
		signatures: sanitizeSignatures(raw.signatures),
		visibility: sanitizeProjectVisibility(raw.visibility)
	};
}

function sanitizeSprint(raw: unknown): Sprint | null {
	if (!isRecord(raw)) return null;
	const name = asString(raw.name);
	const projectId = asNonEmptyString(raw.projectId);
	const startDate = asFiniteNumber(raw.startDate);
	const endDate = asFiniteNumber(raw.endDate);
	if (!name || !projectId || startDate == null || endDate == null) return null;

	return {
		...raw,
		id: asNonEmptyString(raw.id) ?? createFallbackId('sprint'),
		projectId,
		createdBy: asNonEmptyString(raw.createdBy),
		name,
		startDate,
		endDate,
		goals: asStringArray(raw.goals),
		status: typeof raw.status === 'string' && SPRINT_STATUSES.has(raw.status as Sprint['status'])
			? (raw.status as Sprint['status'])
			: 'planned',
		signedBy: asString(raw.signedBy),
		signatures: sanitizeSignatures(raw.signatures),
		visibility: sanitizeSprintVisibility(raw.visibility)
	};
}

function sanitizeKanbanColumns(raw: unknown): KanbanColumn[] {
	if (!Array.isArray(raw)) {
		return DEFAULT_KANBAN_COLUMNS.map((column) => ({ ...column }));
	}

	const overrides = new Map<TodoStatus, KanbanColumn>();
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const id = normalizeTodoStatus(entry.id);
		const template = DEFAULT_KANBAN_COLUMNS.find((column) => column.id === id);
		if (!template) continue;
		overrides.set(id, {
			...template,
			...entry,
			id,
			label: asString(entry.label) ?? template.label,
			color: asString(entry.color) ?? template.color,
			visible: asBoolean(entry.visible) ?? template.visible
		});
	}

	return DEFAULT_KANBAN_COLUMNS.map((column) => ({ ...column, ...(overrides.get(column.id) ?? {}) }));
}

function sanitizeResource(raw: unknown): Resource | null {
	if (!isRecord(raw)) return null;
	const name = asString(raw.name);
	if (!name) return null;

	const now = Date.now();
	const type = typeof raw.type === 'string' && RESOURCE_TYPES.has(raw.type as Resource['type'])
		? (raw.type as Resource['type'])
		: 'file';
	const storageType = typeof raw.storageType === 'string' && STORAGE_TYPES.has(raw.storageType as Resource['storageType'])
		? (raw.storageType as Resource['storageType'])
		: (asString(raw.externalUrl) ? 'external' : asString(raw.fileUrl) ? 'upload' : 'inline');
	const visibilityType = typeof raw.visibilityType === 'string' && VISIBILITY_TYPES.has(raw.visibilityType as NonNullable<Resource['visibilityType']>)
		? (raw.visibilityType as NonNullable<Resource['visibilityType']>)
		: 'public';
	const minRole = typeof raw.minRole === 'string' && MIN_ROLES.has(raw.minRole as UserRole)
		? (raw.minRole as UserRole)
		: undefined;

	return {
		...raw,
		id: asNonEmptyString(raw.id) ?? createFallbackId('resource'),
		type,
		name,
		description: asString(raw.description),
		storageType,
		content: asString(raw.content),
		fileUrl: asString(raw.fileUrl),
		externalUrl: asString(raw.externalUrl),
		fileSize: asFiniteNumber(raw.fileSize),
		mimeType: asString(raw.mimeType),
		preview: asString(raw.preview),
		tags: asStringArray(raw.tags) ?? [],
		createdBy: asNonEmptyString(raw.createdBy) ?? 'unknown',
		createdAt: asFiniteNumber(raw.createdAt) ?? now,
		updatedAt: asFiniteNumber(raw.updatedAt) ?? now,
		isAnonymous: asBoolean(raw.isAnonymous),
		visibilityType,
		minRole,
		isEncrypted: asBoolean(raw.isEncrypted),
		workspaceId: asString(raw.workspaceId)
	};
}

function sanitizeTag(raw: unknown): Tag | null {
	if (!isRecord(raw)) return null;
	const name = asString(raw.name);
	if (!name) return null;

	return {
		...raw,
		id: asNonEmptyString(raw.id) ?? createFallbackId('tag'),
		name,
		color: asString(raw.color) ?? '#64748b',
		createdAt: asFiniteNumber(raw.createdAt) ?? Date.now()
	};
}

function sanitizeGraphEdge(raw: unknown): GraphEdge | null {
	if (!isRecord(raw)) return null;
	const source = asNonEmptyString(raw.source);
	const target = asNonEmptyString(raw.target);
	if (!source || !target) return null;

	return {
		...raw,
		id: asNonEmptyString(raw.id) ?? createFallbackId('edge'),
		source,
		target,
		type: typeof raw.type === 'string' && EDGE_TYPES.has(raw.type as EdgeType)
			? (raw.type as EdgeType)
			: 'related_to',
		label: asString(raw.label),
		weight: asFiniteNumber(raw.weight),
		createdAt: asFiniteNumber(raw.createdAt) ?? Date.now(),
		createdBy: asNonEmptyString(raw.createdBy) ?? 'unknown'
	};
}

function sanitizeCollection<T>(value: unknown, sanitizer: (entry: unknown) => T | null): T[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((entry) => sanitizer(entry))
		.filter((entry): entry is T => entry !== null);
}

export function sanitizeBusinessData(raw: unknown): BusinessDataSnapshot {
	const input = isRecord(raw) ? raw : {};

	return {
		todos: sanitizeCollection(input.todos, sanitizeTodo),
		calendarEvents: sanitizeCollection(input.calendarEvents, sanitizeCalendarEvent),
		diaryEntries: sanitizeCollection(input.diaryEntries, sanitizeDiaryEntry),
		projects: sanitizeCollection(input.projects, sanitizeProject),
		sprints: sanitizeCollection(input.sprints, sanitizeSprint),
		kanbanColumns: sanitizeKanbanColumns(input.kanbanColumns),
		resources: sanitizeCollection(input.resources, sanitizeResource),
		tags: sanitizeCollection(input.tags, sanitizeTag),
		graphEdges: sanitizeCollection(input.graphEdges, sanitizeGraphEdge)
	};
}

export function parseBusinessDataJson(raw: string): BusinessDataSnapshot {
	return sanitizeBusinessData(JSON.parse(raw));
}
