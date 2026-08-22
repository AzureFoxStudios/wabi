export type BusinessVisibility = 'public' | 'private';
/**
 * A sign-off on a planner item: "I stand behind this item."
 * `by` is the stable user id when known, `name` is the display name at sign
 * time, `at` is an epoch-ms timestamp. Legacy single-signer `signedBy` fields
 * remain written (first signer's name) for backward compatibility.
 */
export interface ItemSignature {
  by: string;
  name: string;
  at: number;
}
export type TodoStatus = 'ideas' | 'todo' | 'in_progress' | 'done' | 'scrapped' | 'archived';
export type TodoPriority = 'low' | 'medium' | 'high' | 'urgent';
export type DiaryMood = 'great' | 'good' | 'neutral' | 'bad' | 'awful';
export type ProjectStatus = 'planning' | 'active' | 'paused' | 'completed' | 'cancelled';
export type SprintStatus = 'planned' | 'active' | 'completed';
export type ResourceType =
  | 'brush'
  | 'code'
  | 'image'
  | 'url'
  | 'note'
  | 'file'
  | 'youtube'
  | 'video'
  | 'pdf'
  | 'audio'
  | 'ebook'
  | 'document'
  | 'archive';
export type ResourceStorageType = 'inline' | 'upload' | 'external';
export type ResourceVisibilityType = 'public' | 'role_restricted' | 'private' | 'personal';
export type UserRole = 'admin' | 'mod' | 'contributor' | 'viewer' | 'owner';
export type NodeType = 'todo' | 'project' | 'diary_entry' | 'resource' | 'tag' | 'sprint';
export type EdgeType = 'contains' | 'depends_on' | 'references' | 'tagged_with' | 'related_to' | 'inspired_by';

export interface Todo {
  id: string;
  title: string;
  description?: string;
  status: TodoStatus;
  priority: TodoPriority;
  estimatedMinutes?: number;
  dueDate?: number;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  assignedTo?: string;
  tags?: string[];
  projectId?: string;
  completedAt?: number;
  /** Optional lore file references (inert when the lore addon is absent). */
  loreRefs?: import('./businessContracts').LoreCitationRef[];
  signedBy?: string;
  signatures?: ItemSignature[];
  visibility?: BusinessVisibility;
}

export interface CalendarRecurringRule {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  endDate?: number;
}

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  startDate: number;
  endDate?: number;
  allDay: boolean;
  color?: string;
  createdBy: string;
  recurring?: CalendarRecurringRule;
  reminders?: Int32Array | number[];
  cancelledDates?: BigInt64Array | number[];
  signedBy?: string;
  signatures?: ItemSignature[];
  visibility?: BusinessVisibility;
}

export interface DiaryEntry {
  id: string;
  date: number;
  content: string;
  mood?: DiaryMood;
  images?: string[];
  tags?: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  isPrivate: boolean;
  signedBy?: string;
  signatures?: ItemSignature[];
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
  status: ProjectStatus;
  parentId?: string;
  /**
   * Optional channel link — when set, this project is "piped" to that
   * channel: shared with channel members (once server sync lands) and
   * surfaced as "this channel's plan". Unset = personal/global.
   */
  channelId?: string;
  signedBy?: string;
  signatures?: ItemSignature[];
  visibility?: BusinessVisibility;
}

/**
 * A reference from a planner item into a Lore repo file (optionally a line
 * range). Mirrors the chat citation shape (MessageContent ^c/ refs) so a
 * citation pasted in chat and one attached to a task are the same object.
 * Additive + optional: inert when the lore addon is disabled.
 */
export interface LoreCitationRef {
  channelId: string;
  path: string;
  startLine?: number;
  endLine?: number;
  label?: string;
}

export interface Sprint {
  id: string;
  projectId: string;
  createdBy?: string;
  name: string;
  startDate: number;
  endDate: number;
  goals?: string[];
  status: SprintStatus;
  signedBy?: string;
  signatures?: ItemSignature[];
  visibility?: BusinessVisibility;
}

export interface Resource {
  id: string;
  type: ResourceType;
  name: string;
  description?: string;
  storageType: ResourceStorageType;
  content?: string;
  fileUrl?: string;
  externalUrl?: string;
  fileSize?: number;
  mimeType?: string;
  preview?: string;
  tags: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  isAnonymous?: boolean;
  visibilityType?: ResourceVisibilityType;
  minRole?: UserRole;
  isEncrypted?: boolean;
  workspaceId?: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  createdAt: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  label?: string;
  weight?: number;
  createdAt: number;
  createdBy: string;
}

export interface BusinessDataCollections {
  todos: Todo[];
  calendarEvents: CalendarEvent[];
  diaryEntries: DiaryEntry[];
  projects: Project[];
  sprints: Sprint[];
  resources: Resource[];
  tags: Tag[];
  graphEdges: GraphEdge[];
}
