import { DEFAULT_WORKSPACE_ID } from '../../constants.js';
import {
	stdbWhiteboardIngest,
	stdbWhiteboardRows,
	stdbWhiteboardsEnabled
} from './stdbWhiteboardRuntime.js';

export type WhiteboardScopeType = 'channel';

export interface WhiteboardViewport {
	x: number;
	y: number;
	zoom: number;
}

export interface WhiteboardDocument {
	boardId: string;
	version: number;
	updatedAt: number;
	elements: unknown[];
	viewport?: WhiteboardViewport;
	[key: string]: unknown;
}

export interface WhiteboardRecord {
	boardId: string;
	workspaceId: string;
	scopeType: WhiteboardScopeType;
	scopeId: string;
	version: number;
	document: WhiteboardDocument;
	isPrivate: boolean;
	createdBy: string | null;
	updatedBy: string | null;
	createdAt: number;
	updatedAt: number;
}

interface WhiteboardRow {
	board_id: string;
	workspace_id: string;
	scope_type: WhiteboardScopeType;
	scope_id: string;
	version: number;
	document_json: string;
	is_private: number;
	created_by: string | null;
	updated_by: string | null;
	created_at: number;
	updated_at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown, fallback: number): number {
	const next = Number(value);
	return Number.isFinite(next) ? next : fallback;
}

function toSqlStringLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

export function getChannelWhiteboardId(channelId: string): string {
	return `channel:${channelId}`;
}

export class WhiteboardRepository {
	private createDefaultDocument(boardId: string, version = 1, updatedAt = Date.now()): WhiteboardDocument {
		return {
			boardId,
			version,
			updatedAt,
			elements: [],
			viewport: {
				x: 0,
				y: 0,
				zoom: 1
			}
		};
	}

	private normalizeDocument(
		boardId: string,
		value: unknown,
		versionFallback: number,
		updatedAtFallback: number
	): WhiteboardDocument {
		const input = isRecord(value) ? { ...value } : {};
		delete input.boardId;
		delete input.version;
		delete input.updatedAt;
		delete input.elements;
		delete input.viewport;

		const version = Math.max(1, Math.floor(toFiniteNumber((value as Record<string, unknown>)?.version, versionFallback)));
		const updatedAt = Math.max(
			0,
			Math.floor(toFiniteNumber((value as Record<string, unknown>)?.updatedAt, updatedAtFallback))
		);
		const elements = Array.isArray((value as Record<string, unknown>)?.elements)
			? (value as Record<string, unknown>).elements.slice(0, 10_000)
			: [];

		let viewport: WhiteboardViewport | undefined;
		if (isRecord((value as Record<string, unknown>)?.viewport)) {
			const rawViewport = (value as Record<string, unknown>).viewport as Record<string, unknown>;
			viewport = {
				x: toFiniteNumber(rawViewport.x, 0),
				y: toFiniteNumber(rawViewport.y, 0),
				zoom: Math.max(0.05, toFiniteNumber(rawViewport.zoom, 1))
			};
		}

		return {
			...input,
			boardId,
			version,
			updatedAt,
			elements,
			...(viewport ? { viewport } : {})
		};
	}

	private parseRow(row: Partial<WhiteboardRow> | null | undefined): WhiteboardRecord | null {
		if (!row?.board_id || !row.scope_id) return null;
		const version = Math.max(1, Math.floor(toFiniteNumber(row.version, 1)));
		const updatedAt = Math.max(0, Math.floor(toFiniteNumber(row.updated_at, Date.now())));
		const parsedDocument =
			typeof row.document_json === 'string' && row.document_json.trim()
				? this.safeParseJson(row.document_json)
				: null;

		return {
			boardId: row.board_id,
			workspaceId: row.workspace_id || DEFAULT_WORKSPACE_ID,
			scopeType: row.scope_type || 'channel',
			scopeId: row.scope_id,
			version,
			document: this.normalizeDocument(row.board_id, parsedDocument, version, updatedAt),
			isPrivate: Number(row.is_private ?? 1) === 1,
			createdBy: row.created_by ?? null,
			updatedBy: row.updated_by ?? null,
			createdAt: Math.max(0, Math.floor(toFiniteNumber(row.created_at, updatedAt))),
			updatedAt
		};
	}

	private safeParseJson(value: string): unknown {
		try {
			return JSON.parse(value);
		} catch {
			return null;
		}
	}

	private findByBoardIdStdb(boardId: string): WhiteboardRecord | null {
		const rows = stdbWhiteboardRows(
			'whiteboards.read',
			`SELECT row_json FROM state_whiteboards WHERE board_id = ${toSqlStringLiteral(boardId)} LIMIT 1`
		);
		if (!rows || rows.length === 0) return null;
		const parsed = this.safeParseJson(String(rows[0].row_json || ''));
		return this.parseRow(parsed as Partial<WhiteboardRow> | null);
	}

	private upsertStdb(row: WhiteboardRow): void {
		stdbWhiteboardIngest('whiteboards.write', 'upsert_board', {
			boardId: row.board_id,
			scopeType: row.scope_type,
			scopeId: row.scope_id,
			row
		});
	}

	getByBoardId(boardId: string): WhiteboardRecord | null {
		if (stdbWhiteboardsEnabled()) {
			return this.findByBoardIdStdb(boardId);
		}
		return null;
	}

	getOrCreateForChannel(channelId: string, actorStableId: string): WhiteboardRecord {
		const boardId = getChannelWhiteboardId(channelId);
		const existing = this.getByBoardId(boardId);
		if (existing) return existing;

		const now = Date.now();
		const row: WhiteboardRow = {
			board_id: boardId,
			workspace_id: DEFAULT_WORKSPACE_ID,
			scope_type: 'channel',
			scope_id: channelId,
			version: 1,
			document_json: JSON.stringify(this.createDefaultDocument(boardId, 1, now)),
			is_private: 1,
			created_by: actorStableId,
			updated_by: actorStableId,
			created_at: now,
			updated_at: now
		};

		if (stdbWhiteboardsEnabled()) {
			this.upsertStdb(row);
		}

		return this.parseRow(row)!;
	}

	listAll(): WhiteboardRecord[] {
		if (!stdbWhiteboardsEnabled()) {
			return [];
		}
		const rows = stdbWhiteboardRows(
			'whiteboards.list',
			`SELECT row_json FROM state_whiteboards ORDER BY last_updated_at DESC`
		);
		return rows
			.map((row) => this.safeParseJson(String(row.row_json || '')))
			.map((parsed) => this.parseRow(parsed as Partial<WhiteboardRow> | null))
			.filter((row): row is WhiteboardRecord => row !== null);
	}

	saveSnapshot(boardId: string, document: unknown, actorStableId: string): WhiteboardRecord | null {
		const existing = this.getByBoardId(boardId);
		if (!existing) return null;

		const now = Date.now();
		const nextVersion = existing.version + 1;
		const nextDocument = this.normalizeDocument(boardId, document, nextVersion, now);
		nextDocument.version = nextVersion;
		nextDocument.updatedAt = now;

		const row: WhiteboardRow = {
			board_id: existing.boardId,
			workspace_id: existing.workspaceId,
			scope_type: existing.scopeType,
			scope_id: existing.scopeId,
			version: nextVersion,
			document_json: JSON.stringify(nextDocument),
			is_private: existing.isPrivate ? 1 : 0,
			created_by: existing.createdBy,
			updated_by: actorStableId,
			created_at: existing.createdAt,
			updated_at: now
		};

		if (stdbWhiteboardsEnabled()) {
			this.upsertStdb(row);
		}

		return this.parseRow(row);
	}
}

export const whiteboardRepository = new WhiteboardRepository();