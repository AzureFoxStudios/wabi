import { normalizeNoteTitle, parseNoteLinks } from './links';
import { NotebookError, type NotebookNote, type NotebookLink } from './types';

export interface NotebookBackup {
	format: 'wabi-local-notebook';
	version: 1;
	sourceScopeId: string;
	exportedAt: number;
	notes: NotebookNote[];
	links: NotebookLink[];
}
export const MAX_NOTEBOOK_BACKUP_BYTES = 20_000_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function invalid(): never { throw new NotebookError('invalid', 'This file is not a valid Wabi notebook backup. The existing notebook was not changed.'); }

/** Validate the complete graph before opening a write transaction. */
export function parseNotebookBackup(raw: string): NotebookBackup {
	if (raw.length > MAX_NOTEBOOK_BACKUP_BYTES || new TextEncoder().encode(raw).byteLength > MAX_NOTEBOOK_BACKUP_BYTES) throw new NotebookError('invalid', 'This notebook exceeds the supported 20 MB backup size. Download individual notes; no partial backup was created.');
	let value: unknown;
	try { value = JSON.parse(raw); } catch { return invalid(); }
	if (!object(value) || value.format !== 'wabi-local-notebook' || value.version !== 1 || typeof value.sourceScopeId !== 'string' || !value.sourceScopeId || !time(value.exportedAt) || !Array.isArray(value.notes) || !Array.isArray(value.links) || value.notes.length > 10_000 || value.links.length > 100_000) return invalid();
	const ids = new Set<string>(), titles = new Set<string>();
	const parsedLinks = new Map<string, Set<string>>();
	const targetTitles = new Map<string, string>();
	for (const note of value.notes) {
		if (!object(note) || note.schemaVersion !== 1 || note.scopeId !== value.sourceScopeId || typeof note.id !== 'string' || !uuid.test(note.id) || ids.has(note.id) || typeof note.title !== 'string' || !note.title.trim() || note.title.length > 200 || /[\[\]|\u0000-\u001f]/.test(note.title) || note.normalizedTitle !== normalizeNoteTitle(note.title) || typeof note.text !== 'string' || note.text.length > 2_000_000 || !Number.isSafeInteger(note.revision) || Number(note.revision) < 1 || !time(note.createdAt) || !time(note.updatedAt) || !(note.trashedAt === null || time(note.trashedAt)) || typeof note.pinned !== 'boolean' || (note.color !== undefined && (typeof note.color !== 'string' || note.color.length > 200)) || (note.contextChannelId !== undefined && (typeof note.contextChannelId !== 'string' || note.contextChannelId.length > 200))) return invalid();
		if (titles.has(note.normalizedTitle as string)) return invalid();
		ids.add(note.id); titles.add(note.normalizedTitle as string);
		targetTitles.set(note.id, note.normalizedTitle as string);
		parsedLinks.set(note.id, new Set(parseNoteLinks(note.text).map(link => link.normalizedTitle)));
	}
	const seen = new Set<string>();
	for (const link of value.links) {
		if (!object(link) || link.scopeId !== value.sourceScopeId || typeof link.sourceId !== 'string' || !ids.has(link.sourceId) || typeof link.normalizedTitle !== 'string' || !parsedLinks.get(link.sourceId)?.has(link.normalizedTitle) || !(link.targetId === null || typeof link.targetId === 'string' && uuid.test(link.targetId))) return invalid();
		const key = JSON.stringify([link.sourceId, link.normalizedTitle]);
		if (seen.has(key)) return invalid();
		if (typeof link.targetId === 'string' && targetTitles.has(link.targetId) && targetTitles.get(link.targetId) !== link.normalizedTitle) return invalid();
		seen.add(key);
	}
	// A partial link index would lose deleted-target identity on import.
	for (const [id, links] of parsedLinks) for (const title of links) if (!seen.has(JSON.stringify([id, title]))) return invalid();
	return value as unknown as NotebookBackup;
}

/** Never offer a file that this version cannot restore, including UTF-8 limits. */
export function serializeNotebookBackup(backup: NotebookBackup): string {
	const raw = JSON.stringify(backup, null, 2);
	parseNotebookBackup(raw);
	return raw;
}
