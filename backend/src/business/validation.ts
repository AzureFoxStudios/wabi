import type {
  BusinessDataCollections,
  BusinessVisibility as SharedBusinessVisibility,
  CalendarEvent as SharedCalendarEvent,
  DiaryEntry as SharedDiaryEntry,
  EdgeType as SharedEdgeType,
  GraphEdge as SharedGraphEdge,
  Project as SharedProject,
  Resource as SharedResource,
  ResourceStorageType as SharedResourceStorageType,
  ResourceType as SharedResourceType,
  ResourceVisibilityType as SharedResourceVisibilityType,
  Sprint as SharedSprint,
  Tag as SharedTag,
  Todo as SharedTodo,
  TodoStatus as SharedTodoStatus,
  UserRole as SharedUserRole
} from '../../../shared/businessContracts.js';

export type BusinessTodoStatus = SharedTodoStatus;
export type BusinessVisibility = SharedBusinessVisibility;
export type BusinessEdgeType = SharedEdgeType;
export type BusinessResourceType = SharedResourceType;
export type BusinessResourceStorageType = SharedResourceStorageType;
export type BusinessResourceVisibilityType = SharedResourceVisibilityType;
export type BusinessUserRole = SharedUserRole;
export type BusinessTodo = SharedTodo;
export type BusinessCalendarEvent = SharedCalendarEvent;
export type BusinessDiaryEntry = SharedDiaryEntry;
export type BusinessProject = SharedProject;
export type BusinessSprint = SharedSprint;
export type BusinessResource = SharedResource;
export type BusinessTag = SharedTag;
export type BusinessGraphEdge = SharedGraphEdge;

export interface BusinessData extends BusinessDataCollections {
  workspaceId: string;
  lastUpdated: number;
}

const TODO_STATUSES = new Set<BusinessTodoStatus>([
  'ideas',
  'todo',
  'in_progress',
  'done',
  'scrapped',
  'archived'
]);
const TODO_PRIORITIES = new Set<BusinessTodo['priority']>(['low', 'medium', 'high', 'urgent']);
const PROJECT_STATUSES = new Set<BusinessProject['status']>(['planning', 'active', 'paused', 'completed', 'cancelled']);
const SPRINT_STATUSES = new Set<BusinessSprint['status']>(['planned', 'active', 'completed']);
const CALENDAR_FREQUENCIES = new Set<NonNullable<BusinessCalendarEvent['recurring']>['frequency']>([
  'daily',
  'weekly',
  'monthly',
  'yearly'
]);
const TODO_VISIBILITIES = new Set<BusinessVisibility>(['public', 'private']);
const RESOURCE_TYPES = new Set<BusinessResourceType>([
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
const RESOURCE_STORAGE_TYPES = new Set<BusinessResourceStorageType>(['inline', 'upload', 'external']);
const RESOURCE_VISIBILITY_TYPES = new Set<BusinessResourceVisibilityType>([
  'public',
  'role_restricted',
  'private',
  'personal'
]);
const RESOURCE_MIN_ROLES = new Set<BusinessUserRole>(['admin', 'mod', 'contributor', 'viewer', 'owner']);
const EDGE_TYPES = new Set<BusinessEdgeType>([
  'contains',
  'depends_on',
  'references',
  'tagged_with',
  'related_to',
  'inspired_by'
]);

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

function asIdentityString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
}

function asNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry));
}

function normalizeTodoStatus(value: unknown): BusinessTodoStatus {
  if (value === 'blocked') return 'scrapped';
  return typeof value === 'string' && TODO_STATUSES.has(value as BusinessTodoStatus)
    ? (value as BusinessTodoStatus)
    : 'todo';
}

function sanitizeVisibility(value: unknown): BusinessVisibility {
  return typeof value === 'string' && TODO_VISIBILITIES.has(value as BusinessVisibility)
    ? (value as BusinessVisibility)
    : 'public';
}

function sanitizeTodo(raw: unknown): BusinessTodo | null {
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
    priority: typeof raw.priority === 'string' && TODO_PRIORITIES.has(raw.priority as BusinessTodo['priority'])
      ? (raw.priority as BusinessTodo['priority'])
      : 'medium',
    estimatedMinutes: asFiniteNumber(raw.estimatedMinutes),
    dueDate: asFiniteNumber(raw.dueDate),
    createdAt: asFiniteNumber(raw.createdAt) ?? now,
    updatedAt: asFiniteNumber(raw.updatedAt) ?? now,
    createdBy: asIdentityString(raw.createdBy) ?? 'unknown',
    assignedTo: asIdentityString(raw.assignedTo),
    tags: asStringArray(raw.tags),
    projectId: asNonEmptyString(raw.projectId),
    completedAt: asFiniteNumber(raw.completedAt),
    signedBy: asString(raw.signedBy),
    visibility: sanitizeVisibility(raw.visibility)
  };
}

function sanitizeRecurring(value: unknown): BusinessCalendarEvent['recurring'] | undefined {
  if (!isRecord(value)) return undefined;
  const frequency = typeof value.frequency === 'string' && CALENDAR_FREQUENCIES.has(value.frequency as NonNullable<BusinessCalendarEvent['recurring']>['frequency'])
    ? (value.frequency as NonNullable<BusinessCalendarEvent['recurring']>['frequency'])
    : null;
  const interval = asFiniteNumber(value.interval);
  if (!frequency || interval == null || interval <= 0) return undefined;
  return {
    frequency,
    interval,
    endDate: asFiniteNumber(value.endDate)
  };
}

function sanitizeCalendarEvent(raw: unknown): BusinessCalendarEvent | null {
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
    createdBy: asIdentityString(raw.createdBy) ?? 'unknown',
    recurring: sanitizeRecurring(raw.recurring),
    reminders: asNumberArray(raw.reminders),
    cancelledDates: asNumberArray(raw.cancelledDates),
    signedBy: asString(raw.signedBy),
    visibility: sanitizeVisibility(raw.visibility)
  };
}

function sanitizeDiaryEntry(raw: unknown): BusinessDiaryEntry | null {
  if (!isRecord(raw)) return null;
  const content = asString(raw.content);
  const date = asFiniteNumber(raw.date);
  if (content == null || date == null) return null;

  const mood = typeof raw.mood === 'string' && ['great', 'good', 'neutral', 'bad', 'awful'].includes(raw.mood)
    ? (raw.mood as BusinessDiaryEntry['mood'])
    : undefined;
  const now = Date.now();

  return {
    ...raw,
    id: asNonEmptyString(raw.id) ?? createFallbackId('diary'),
    date,
    content,
    mood,
    images: asStringArray(raw.images),
    tags: asStringArray(raw.tags),
    createdBy: asIdentityString(raw.createdBy) ?? 'unknown',
    createdAt: asFiniteNumber(raw.createdAt) ?? now,
    updatedAt: asFiniteNumber(raw.updatedAt) ?? now,
    isPrivate: asBoolean(raw.isPrivate) ?? false,
    signedBy: asString(raw.signedBy)
  };
}

function sanitizeProject(raw: unknown): BusinessProject | null {
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
    createdBy: asIdentityString(raw.createdBy) ?? 'unknown',
    createdAt: asFiniteNumber(raw.createdAt) ?? now,
    startDate: asFiniteNumber(raw.startDate),
    targetEndDate: asFiniteNumber(raw.targetEndDate),
    status: typeof raw.status === 'string' && PROJECT_STATUSES.has(raw.status as BusinessProject['status'])
      ? (raw.status as BusinessProject['status'])
      : 'planning',
    parentId: asNonEmptyString(raw.parentId),
    signedBy: asString(raw.signedBy),
    visibility: sanitizeVisibility(raw.visibility)
  };
}

function sanitizeSprint(raw: unknown): BusinessSprint | null {
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
    createdBy: asIdentityString(raw.createdBy),
    name,
    startDate,
    endDate,
    goals: asStringArray(raw.goals),
    status: typeof raw.status === 'string' && SPRINT_STATUSES.has(raw.status as BusinessSprint['status'])
      ? (raw.status as BusinessSprint['status'])
      : 'planned',
    signedBy: asString(raw.signedBy),
    visibility: sanitizeVisibility(raw.visibility)
  };
}

function sanitizeResource(raw: unknown): BusinessResource | null {
  if (!isRecord(raw)) return null;
  const name = asString(raw.name);
  if (!name) return null;

  const now = Date.now();
  const type = typeof raw.type === 'string' && RESOURCE_TYPES.has(raw.type as BusinessResourceType)
    ? (raw.type as BusinessResourceType)
    : 'file';
  const storageType = typeof raw.storageType === 'string' && RESOURCE_STORAGE_TYPES.has(raw.storageType as BusinessResourceStorageType)
    ? (raw.storageType as BusinessResourceStorageType)
    : (asString(raw.externalUrl) ? 'external' : asString(raw.fileUrl) ? 'upload' : 'inline');
  const visibilityType = typeof raw.visibilityType === 'string' && RESOURCE_VISIBILITY_TYPES.has(raw.visibilityType as BusinessResourceVisibilityType)
    ? (raw.visibilityType as BusinessResourceVisibilityType)
    : 'public';
  const minRole = typeof raw.minRole === 'string' && RESOURCE_MIN_ROLES.has(raw.minRole as BusinessUserRole)
    ? (raw.minRole as BusinessUserRole)
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
    createdBy: asIdentityString(raw.createdBy) ?? 'unknown',
    createdAt: asFiniteNumber(raw.createdAt) ?? now,
    updatedAt: asFiniteNumber(raw.updatedAt) ?? now,
    isAnonymous: asBoolean(raw.isAnonymous),
    visibilityType,
    minRole,
    isEncrypted: asBoolean(raw.isEncrypted),
    workspaceId: asNonEmptyString(raw.workspaceId)
  };
}

function sanitizeTag(raw: unknown): BusinessTag | null {
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

function sanitizeGraphEdge(raw: unknown): BusinessGraphEdge | null {
  if (!isRecord(raw)) return null;
  const source = asNonEmptyString(raw.source);
  const target = asNonEmptyString(raw.target);
  if (!source || !target) return null;

  return {
    ...raw,
    id: asNonEmptyString(raw.id) ?? createFallbackId('edge'),
    source,
    target,
    type: typeof raw.type === 'string' && EDGE_TYPES.has(raw.type as BusinessEdgeType)
      ? (raw.type as BusinessEdgeType)
      : 'related_to',
    label: asString(raw.label),
    weight: asFiniteNumber(raw.weight),
    createdAt: asFiniteNumber(raw.createdAt) ?? Date.now(),
    createdBy: asIdentityString(raw.createdBy) ?? 'unknown'
  };
}

function sanitizeCollection<T>(value: unknown, sanitizer: (entry: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => sanitizer(entry))
    .filter((entry): entry is T => entry !== null);
}

export function createEmptyBusinessData(workspaceId: string): BusinessData {
  return {
    workspaceId,
    todos: [],
    calendarEvents: [],
    diaryEntries: [],
    projects: [],
    sprints: [],
    resources: [],
    tags: [],
    graphEdges: [],
    lastUpdated: Date.now()
  };
}

export function sanitizeBusinessData(raw: unknown, workspaceId: string): BusinessData {
  const input = isRecord(raw) ? raw : {};
  return {
    workspaceId,
    todos: sanitizeCollection(input.todos, sanitizeTodo),
    calendarEvents: sanitizeCollection(input.calendarEvents, sanitizeCalendarEvent),
    diaryEntries: sanitizeCollection(input.diaryEntries, sanitizeDiaryEntry),
    projects: sanitizeCollection(input.projects, sanitizeProject),
    sprints: sanitizeCollection(input.sprints, sanitizeSprint),
    resources: sanitizeCollection(input.resources, sanitizeResource),
    tags: sanitizeCollection(input.tags, sanitizeTag),
    graphEdges: sanitizeCollection(input.graphEdges, sanitizeGraphEdge),
    lastUpdated: asFiniteNumber(input.lastUpdated) ?? Date.now()
  };
}

export function sanitizeBusinessResourceCreate(
  raw: unknown,
  context: {
    id: string;
    createdBy: string;
    workspaceId: string;
    createdAt?: number;
    updatedAt?: number;
  }
): BusinessResource | null {
  const now = Date.now();
  return sanitizeResource({
    ...(isRecord(raw) ? raw : {}),
    id: context.id,
    createdBy: context.createdBy,
    workspaceId: context.workspaceId,
    createdAt: context.createdAt ?? now,
    updatedAt: context.updatedAt ?? now
  });
}

export function sanitizeBusinessResourceUpdate(
  existing: BusinessResource,
  raw: unknown,
  updatedAt: number = Date.now()
): BusinessResource | null {
  return sanitizeResource({
    ...existing,
    ...(isRecord(raw) ? raw : {}),
    id: existing.id,
    createdBy: existing.createdBy,
    createdAt: existing.createdAt,
    workspaceId: existing.workspaceId,
    updatedAt
  });
}
