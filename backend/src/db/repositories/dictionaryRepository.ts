import db from '../database.js';

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

export class DictionaryRepository {
	upsert(params: {
		workspaceId?: string;
		term: string;
		definition: string;
		language?: string;
		createdByUserId?: number | null;
		createdByUsername?: string | null;
	}): DictionaryEntry {
		const workspaceId = (params.workspaceId || 'default-workspace').trim() || 'default-workspace';
		const term = params.term.trim();
		const termNormalized = normalizeTerm(term);
		const definition = params.definition.trim();
		const language = normalizeLanguage(params.language);
		const now = Date.now();

		const stmt = db.prepare(`
			INSERT INTO dictionary_entries (
				workspace_id, term, term_normalized, definition, language,
				created_by_user_id, created_by_username, created_at, updated_at, votes
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
			ON CONFLICT(workspace_id, language, term_normalized)
			DO UPDATE SET
				term = excluded.term,
				definition = excluded.definition,
				created_by_user_id = excluded.created_by_user_id,
				created_by_username = excluded.created_by_username,
				updated_at = excluded.updated_at
		`);

		stmt.run(
			workspaceId,
			term,
			termNormalized,
			definition,
			language,
			params.createdByUserId ?? null,
			params.createdByUsername ?? null,
			now,
			now
		);

		return this.findExact(term, language, workspaceId)!;
	}

	findExact(term: string, language: string | undefined, workspaceId = 'default-workspace'): DictionaryEntry | null {
		const normalized = normalizeTerm(term);
		const lang = normalizeLanguage(language);
		const stmt = db.prepare(`
			SELECT * FROM dictionary_entries
			WHERE workspace_id = ? AND language = ? AND term_normalized = ?
			LIMIT 1
		`);
		return (stmt.get(workspaceId, lang, normalized) as DictionaryEntry) || null;
	}

	search(term: string, language: string | undefined, workspaceId = 'default-workspace', limit = 12): DictionaryEntry[] {
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
		return stmt.all(workspaceId, lang, `%${normalized}%`, normalized, safeLimit) as DictionaryEntry[];
	}

	deleteByTerm(params: {
		workspaceId?: string;
		term: string;
		language?: string;
		requestingUserId: number;
		canModerate: boolean;
	}): number {
		const workspaceId = (params.workspaceId || 'default-workspace').trim() || 'default-workspace';
		const normalized = normalizeTerm(params.term);
		const lang = normalizeLanguage(params.language);

		if (params.canModerate) {
			const stmt = db.prepare(`
				DELETE FROM dictionary_entries
				WHERE workspace_id = ? AND language = ? AND term_normalized = ?
			`);
			return stmt.run(workspaceId, lang, normalized).changes;
		}

		const stmt = db.prepare(`
			DELETE FROM dictionary_entries
			WHERE workspace_id = ? AND language = ? AND term_normalized = ? AND created_by_user_id = ?
		`);
		return stmt.run(workspaceId, lang, normalized, params.requestingUserId).changes;
	}
}

export const dictionaryRepository = new DictionaryRepository();
