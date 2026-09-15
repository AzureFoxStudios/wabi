import { sanitizeBusinessData } from './validation';
import type { BusinessDataSnapshot } from './types';

const MAX_UTF8_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ROWS = 10000;
const SUPPORTED_VERSION = '1.0';

const COLLECTION_KEYS = [
	'todos',
	'calendarEvents',
	'diaryEntries',
	'projects',
	'sprints',
	'kanbanColumns',
	'resources',
	'tags',
	'graphEdges'
] as const;

type CollectionKey = typeof COLLECTION_KEYS[number];

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasValidId(record: unknown): boolean {
	return isRecord(record) && typeof record.id === 'string' && record.id.trim().length > 0 && record.id === record.id.trim();
}

function canonicalStringify(obj: unknown): string {
	if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
	if (Array.isArray(obj)) return '[' + obj.map(canonicalStringify).join(',') + ']';
	const entries = Object.entries(obj as Record<string, unknown>).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b));
	return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalStringify(v)).join(',') + '}';
}

function recordsEqual(a: unknown, b: unknown): boolean {
	return canonicalStringify(a) === canonicalStringify(b);
}

function countRows(snapshot: Record<string, unknown>): number {
	let total = 0;
	for (const key of COLLECTION_KEYS) {
		const val = snapshot[key];
		if (Array.isArray(val)) total += val.length;
	}
	return total;
}

function utf8ByteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

function getCollectionName(key: string): string {
	return key.charAt(0).toUpperCase() + key.slice(1);
}

function getAllIncomingIds(incomingSnapshot: Record<string, unknown>): Set<string> {
	const ids = new Set<string>();
	for (const key of COLLECTION_KEYS) {
		const items = incomingSnapshot[key] as unknown[];
		for (const item of items) {
			if (isRecord(item) && typeof item.id === 'string') {
				ids.add(item.id);
			}
		}
	}
	return ids;
}

function getProjectIds(snapshot: Record<string, unknown>): Set<string> {
	const ids = new Set<string>();
	const projects = snapshot.projects as unknown[];
	for (const p of projects) {
		if (isRecord(p) && typeof p.id === 'string') ids.add(p.id);
	}
	return ids;
}

export function parsePlannerBackup(text: string, destinationScope?: string): BusinessDataSnapshot {
	if (utf8ByteLength(text) > MAX_UTF8_BYTES) {
		throw new Error(`Backup exceeds ${MAX_UTF8_BYTES} byte limit`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error('Invalid JSON in backup');
	}

	if (!isRecord(parsed)) {
		throw new Error('Backup must be a JSON object');
	}

	const version = parsed.version;
	if (version !== undefined && version !== SUPPORTED_VERSION) {
		throw new Error(`Unsupported backup version: ${version}`);
	}

	const extraKeys = Object.keys(parsed).filter((k) => !COLLECTION_KEYS.includes(k as CollectionKey) && k !== 'version' && k !== 'exportedAt' && k !== 'sourceScope');
	if (extraKeys.length > 0) {
		throw new Error(`Backup contains unrelated fields: ${extraKeys.join(', ')}`);
	}

	for (const key of COLLECTION_KEYS) {
		const val = parsed[key];
		if (!Array.isArray(val)) {
			throw new Error(`Missing or invalid ${key} array in backup`);
		}
	}

	const totalRows = countRows(parsed);
	if (totalRows > MAX_TOTAL_ROWS) {
		throw new Error(`Backup exceeds ${MAX_TOTAL_ROWS} row limit`);
	}

	for (const key of COLLECTION_KEYS) {
		const items = parsed[key] as unknown[];
		const ids = new Set<string>();
		for (const item of items) {
			if (!isRecord(item)) {
				throw new Error(`Invalid ${getCollectionName(key)} record: not a plain object`);
			}
			if (!hasValidId(item)) {
				throw new Error(`Invalid ${getCollectionName(key)} record: missing or invalid id`);
			}
			const id = item.id as string;
			if (ids.has(id)) {
				throw new Error(`Duplicate ${getCollectionName(key)} id: ${id}`);
			}
			ids.add(id);
		}
	}

	const sanitized = sanitizeBusinessData(parsed);

	for (const key of COLLECTION_KEYS) {
		if (key === 'kanbanColumns' && (parsed[key] as unknown[]).length === 0) continue;
		const inputCount = (parsed[key] as unknown[]).length;
		const sanitizedCount = (sanitized[key] as unknown[]).length;
		if (sanitizedCount !== inputCount) {
			throw new Error(`${inputCount - sanitizedCount} ${getCollectionName(key)} row(s) dropped by sanitizer`);
		}
	}

	if (Array.isArray(parsed.kanbanColumns)) {
		const inputCols = parsed.kanbanColumns as unknown[];
		const sanitizedCols = sanitized.kanbanColumns as unknown[];
		for (const col of inputCols) {
			if (!isRecord(col)) {
				throw new Error('Invalid KanbanColumn record: not a plain object');
			}
			if (!hasValidId(col)) {
				throw new Error('Invalid KanbanColumn record: missing or invalid id');
			}
		}
		if (sanitizedCols.length < inputCols.length) {
			throw new Error(`${inputCols.length - sanitizedCols.length} KanbanColumns row(s) dropped by sanitizer`);
		}
	}

	if (destinationScope && parsed.sourceScope !== destinationScope) {
		const hasServerReferences = sanitized.projects.some(project => !!project.channelId) ||
			sanitized.todos.some(todo => (todo.loreRefs?.length ?? 0) > 0);
		if (hasServerReferences) throw new Error('This file has channel or Lore links from an unverified account. Import it into its original account using a new export with account information.');
	}

	return sanitized;
}

export function mergePlannerBackup(
	current: BusinessDataSnapshot,
	incoming: BusinessDataSnapshot
): { data: BusinessDataSnapshot; added: number; skipped: number } {
	const incomingSnapshot = incoming as unknown as Record<string, unknown>;
	const currentSnapshot = current as unknown as Record<string, unknown>;
	const comparableCurrent = sanitizeBusinessData(current);
	const comparableIncoming = sanitizeBusinessData(incoming);

	const allIncomingIds = getAllIncomingIds(incomingSnapshot);
	const incomingProjectIds = getProjectIds(incomingSnapshot);
	const currentProjectIds = getProjectIds(currentSnapshot);

	const result = {} as Record<string, unknown>;
	let added = 0;
	let skipped = 0;

	for (const key of COLLECTION_KEYS) {
		const currentItems = currentSnapshot[key] as unknown[];
		const incomingItems = incomingSnapshot[key] as unknown[];
		const currentMap = new Map<string, unknown>();
		for (const item of currentItems) {
			if (isRecord(item) && typeof item.id === 'string') {
				currentMap.set(item.id, item);
			}
		}

		const mergedItems: unknown[] = [];
		for (const item of currentItems) {
			mergedItems.push(item);
		}
		for (const item of incomingItems) {
			if (!isRecord(item)) continue;
			const id = item.id as string;
			const existing = currentMap.get(id);

			if (existing !== undefined) {
				const comparable = comparableCurrent[key].find(row => row.id === id) ?? existing;
				const incomingComparable = comparableIncoming[key].find(row => row.id === id) ?? item;
				if (recordsEqual(incomingComparable, comparable)) {
					skipped++;
				} else {
					throw new Error(`Conflict in ${key}: record with id "${id}" differs between current and incoming import`);
				}
			} else {
				added++;
				mergedItems.push(item);
			}
		}

		result[key] = mergedItems;
	}

	const incomingTodos = incomingSnapshot.todos as unknown[];
	for (const todo of incomingTodos) {
		if (!isRecord(todo)) continue;
		const projectId = todo.projectId as string | undefined;
		if (projectId) {
			if (!incomingProjectIds.has(projectId)) {
				if (currentProjectIds.has(projectId)) {
					throw new Error(`Conflict: todo references projectId "${projectId}" which exists in current but not in incoming`);
				}
				throw new Error(`Conflict: todo references projectId "${projectId}" not found in incoming data`);
			}
		}
	}

	const incomingSprints = incomingSnapshot.sprints as unknown[];
	for (const sprint of incomingSprints) {
		if (!isRecord(sprint)) continue;
		const projectId = sprint.projectId as string | undefined;
		if (projectId) {
			if (!incomingProjectIds.has(projectId)) {
				if (currentProjectIds.has(projectId)) {
					throw new Error(`Conflict: sprint references projectId "${projectId}" which exists in current but not in incoming`);
				}
				throw new Error(`Conflict: sprint references projectId "${projectId}" not found in incoming data`);
			}
		}
	}

	for (const project of incoming.projects) {
		if (project.parentId && !incomingProjectIds.has(project.parentId)) {
			throw new Error(`Conflict: project parent "${project.parentId}" is missing from the imported file`);
		}
	}

	const incomingEdges = incomingSnapshot.graphEdges as unknown[];
	for (const edge of incomingEdges) {
		if (!isRecord(edge)) continue;
		const source = edge.source as string | undefined;
		const target = edge.target as string | undefined;
		if (source && !allIncomingIds.has(source)) {
			throw new Error(`Conflict: graphEdge source "${source}" not found in incoming data`);
		}
		if (target && !allIncomingIds.has(target)) {
			throw new Error(`Conflict: graphEdge target "${target}" not found in incoming data`);
		}
	}

	return { data: result as unknown as BusinessDataSnapshot, added, skipped };
}
