import db from '../database.js';
import { escapeSqlLiteral } from '../../state-plane/stdbSyncClient.js';
import {
	stdbDictionaryEnabled,
	stdbDictionaryIngest,
	stdbDictionaryRows
} from './stdbDictionaryRuntime.js';

export interface DictionaryEntry {
	id?: number;
	workspace_id: string;
	term: string;
	term_normalized: string;
	definition: string;
	language: string;
	created_by_user_id?: number | null;
	created_by_username?: string | null;
	created_at: number;
	updated_at: number;
	votes: number;
}

function normalizeTerm(term: string): string {
	return term.trim().toLowerCase();
}

function normalizeLanguage(language: string | undefined): string {
	const raw = (language || 'en').trim().toLowerCase();
	return raw.length > 0 ? raw.slice(0, 16) : 'en';
}

function normalizeWorkspaceId(workspaceId: string | undefined): string {
	const raw = (workspaceId || 'default-workspace').trim();
	return raw.length > 0 ? raw : 'default-workspace';
}

function dictionaryEntryKey(workspaceId: string, language: string, termNormalized: string): string {
	return `${workspaceId}:${language}:${termNormalized}`;
}

export class DictionaryRepository {
	private normalizeRow(row: Partial<DictionaryEntry> | null | undefined): DictionaryEntry | null {
		if (!row) return null;
		const workspaceId = normalizeWorkspaceId(row.workspace_id);
		const term = typeof row.term === 'string' ? row.term.trim() : '';
		const termNormalized = normalizeTerm(row.term_normalized || term);
		const definition = typeof row.definition === 'string' ? row.definition.trim() : '';
		const language = normalizeLanguage(row.language);
		if (!term || !termNormalized || !definition) return null;
		const now = Date.now();

		return {
			id: row.id !== undefined && row.id !== null ? Number(row.id) : undefined,
			workspace_id: workspaceId,
			term,
			term_normalized: termNormalized,
			definition,
			language,
			created_by_user_id:
				row.created_by_user_id === undefined || row.created_by_user_id === null
					? null
					: Number(row.created_by_user_id),
			created_by_username:
				row.created_by_username === undefined || row.created_by_username === null
					? null
					: String(row.created_by_username),
			created_at: row.created_at !== undefined ? Number(row.created_at) : now,
			updated_at: row.updated_at !== undefined ? Number(row.updated_at) : now,
			votes: row.votes !== undefined ? Number(row.votes) : 0
		};
	}

	private findExactLegacy(term: string, language: string | undefined, workspaceId = 'default-workspace'): DictionaryEntry | null {
		const normalized = normalizeTerm(term);
		const lang = normalizeLanguage(language);
		const stmt = db.prepare(`
			SELECT * FROM dictionary_entries
			WHERE workspace_id = ? AND language = ? AND term_normalized = ?
			LIMIT 1
		`);
		return this.normalizeRow(
			(stmt.get(normalizeWorkspaceId(workspaceId), lang, normalized) as DictionaryEntry | undefined) || null
		);
	}

	private searchLegacy(term: string, language: string | undefined, workspaceId = 'default-workspace', limit = 12): DictionaryEntry[] {
		const normalized = normalizeTerm(term);
		const lang = normalizeLanguage(language);
		const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
		const stmt = db.prepare(`
			SELECT * FROM dictionary_entries
			WHERE workspace_id = ? AND language = ? AND term_normalized LIKE ?
			ORDER BY
				CASE WHEN term_normalized = ? THEN 0 ELSE 1 END ASC,
				updated_at DESC
			LIMIT ?
		`);
		return (stmt.all(normalizeWorkspaceId(workspaceId), lang, `%${normalized}%`, normalized, safeLimit) as DictionaryEntry[])
			.map((row) => this.normalizeRow(row))
			.filter((row): row is DictionaryEntry => Boolean(row));
	}

	private setLegacy(entry: DictionaryEntry): DictionaryEntry {
		const stmt = db.prepare(`
			INSERT INTO dictionary_entries (
				workspace_id, term, term_normalized, definition, language,
				created_by_user_id, created_by_username, created_at, updated_at, votes
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(workspace_id, language, term_normalized)
			DO UPDATE SET
				term = excluded.term,
				definition = excluded.definition,
				created_by_user_id = excluded.created_by_user_id,
				created_by_username = excluded.created_by_username,
				updated_at = excluded.updated_at,
				votes = excluded.votes
		`);

		stmt.run(
			entry.workspace_id,
			entry.term,
			entry.term_normalized,
			entry.definition,
			entry.language,
			entry.created_by_user_id ?? null,
			entry.created_by_username ?? null,
			entry.created_at,
			entry.updated_at,
			entry.votes
		);

		return this.findExactLegacy(entry.term, entry.language, entry.workspace_id) || entry;
	}

	private deleteLegacy(workspaceId: string, language: string, termNormalized: string, requestingUserId: number, canModerate: boolean): number {
		if (canModerate) {
			const stmt = db.prepare(`
				DELETE FROM dictionary_entries
				WHERE workspace_id = ? AND language = ? AND term_normalized = ?
			`);
			return stmt.run(workspaceId, language, termNormalized).changes;
		}

		const stmt = db.prepare(`
			DELETE FROM dictionary_entries
			WHERE workspace_id = ? AND language = ? AND term_normalized = ? AND created_by_user_id = ?
		`);
		return stmt.run(workspaceId, language, termNormalized, requestingUserId).changes;
	}

	private parseStdbRows(rows: Array<Record<string, unknown>> | null): DictionaryEntry[] | null {
		if (!rows) return null;
		return rows
			.map((row) => {
				try {
					return this.normalizeRow(JSON.parse(String(row.row_json || '{}')) as Partial<DictionaryEntry>);
				} catch {
					return null;
				}
			})
			.filter((row): row is DictionaryEntry => Boolean(row));
	}

	private upsertStdb(entry: DictionaryEntry): void {
		stdbDictionaryIngest('dictionary.write', 'upsert_entry', {
			entryKey: dictionaryEntryKey(entry.workspace_id, entry.language, entry.term_normalized),
			workspaceId: entry.workspace_id,
			language: entry.language,
			termNormalized: entry.term_normalized,
			row: entry
		});
	}

	private deleteStdb(entry: DictionaryEntry): void {
		stdbDictionaryIngest('dictionary.delete', 'delete_entry', {
			entryKey: dictionaryEntryKey(entry.workspace_id, entry.language, entry.term_normalized),
			workspaceId: entry.workspace_id,
			language: entry.language,
			termNormalized: entry.term_normalized
		});
	}

	private syncLegacyEntriesToStdb(entries: DictionaryEntry[]): void {
		if (!stdbDictionaryEnabled() || entries.length === 0) return;
		for (const entry of entries) {
			this.upsertStdb(entry);
		}
	}

	private findExactStdb(term: string, language: string | undefined, workspaceId = 'default-workspace'): DictionaryEntry | null {
		const normalized = normalizeTerm(term);
		const lang = normalizeLanguage(language);
		const workspace = normalizeWorkspaceId(workspaceId);
		const rows = stdbDictionaryRows(
			'dictionary.read_exact',
			`SELECT row_json FROM state_dictionary_entry WHERE workspace_id = ${escapeSqlLiteral(workspace)} AND language = ${escapeSqlLiteral(lang)} AND term_normalized = ${escapeSqlLiteral(normalized)} LIMIT 1`
		);
		const parsed = this.parseStdbRows(rows);
		return parsed && parsed.length > 0 ? parsed[0] : null;
	}

	private searchStdb(term: string, language: string | undefined, workspaceId = 'default-workspace', limit = 12): DictionaryEntry[] | null {
		const normalized = normalizeTerm(term);
		const lang = normalizeLanguage(language);
		const workspace = normalizeWorkspaceId(workspaceId);
		const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
		const rows = stdbDictionaryRows(
			'dictionary.search',
			`SELECT row_json FROM state_dictionary_entry WHERE workspace_id = ${escapeSqlLiteral(workspace)} AND language = ${escapeSqlLiteral(lang)}`
		);
		const parsed = this.parseStdbRows(rows);
		if (!parsed) return null;
		return parsed
			.filter((entry) => entry.term_normalized.includes(normalized))
			.sort(
				(a, b) =>
					Number(a.term_normalized !== normalized) - Number(b.term_normalized !== normalized) ||
					b.updated_at - a.updated_at
			)
			.slice(0, safeLimit);
	}

	upsert(params: {
		workspaceId?: string;
		term: string;
		definition: string;
		language?: string;
		createdByUserId?: number | null;
		createdByUsername?: string | null;
	}): DictionaryEntry {
		const workspaceId = normalizeWorkspaceId(params.workspaceId);
		const term = params.term.trim();
		const termNormalized = normalizeTerm(term);
		const definition = params.definition.trim();
		const language = normalizeLanguage(params.language);
		const existing = this.findExact(term, language, workspaceId);
		const now = Date.now();
		const next = this.normalizeRow({
			...(existing || {}),
			workspace_id: workspaceId,
			term,
			term_normalized: termNormalized,
			definition,
			language,
			created_by_user_id: params.createdByUserId ?? existing?.created_by_user_id ?? null,
			created_by_username: params.createdByUsername ?? existing?.created_by_username ?? null,
			created_at: existing?.created_at ?? now,
			updated_at: now,
			votes: existing?.votes ?? 0
		});
		if (!next) {
			throw new Error('Failed to normalize dictionary entry');
		}
		if (stdbDictionaryEnabled()) {
			this.upsertStdb(next);
		}
		this.setLegacy(next);
		return this.findExact(term, language, workspaceId) || next;
	}

	findExact(term: string, language: string | undefined, workspaceId = 'default-workspace'): DictionaryEntry | null {
		if (stdbDictionaryEnabled()) {
			const shadow = this.findExactStdb(term, language, workspaceId);
			if (shadow) return shadow;
			const legacy = this.findExactLegacy(term, language, workspaceId);
			if (legacy) {
				this.upsertStdb(legacy);
			}
			return legacy;
		}
		return this.findExactLegacy(term, language, workspaceId);
	}

	search(term: string, language: string | undefined, workspaceId = 'default-workspace', limit = 12): DictionaryEntry[] {
		if (stdbDictionaryEnabled()) {
			const shadow = this.searchStdb(term, language, workspaceId, limit);
			if (shadow && shadow.length > 0) return shadow;
			const legacy = this.searchLegacy(term, language, workspaceId, limit);
			this.syncLegacyEntriesToStdb(legacy);
			return legacy;
		}
		return this.searchLegacy(term, language, workspaceId, limit);
	}

	deleteByTerm(params: {
		workspaceId?: string;
		term: string;
		language?: string;
		requestingUserId: number;
		canModerate: boolean;
	}): number {
		const workspaceId = normalizeWorkspaceId(params.workspaceId);
		const normalized = normalizeTerm(params.term);
		const lang = normalizeLanguage(params.language);

		if (stdbDictionaryEnabled()) {
			const existing = this.findExact(params.term, lang, workspaceId);
			if (!existing) return 0;
			if (!params.canModerate && existing.created_by_user_id !== params.requestingUserId) {
				return 0;
			}
			const deleted = this.deleteLegacy(
				workspaceId,
				lang,
				normalized,
				params.requestingUserId,
				params.canModerate
			);
			this.deleteStdb(existing);
			return deleted > 0 ? deleted : 1;
		}

		return this.deleteLegacy(
			workspaceId,
			lang,
			normalized,
			params.requestingUserId,
			params.canModerate
		);
	}
}

export const dictionaryRepository = new DictionaryRepository();
