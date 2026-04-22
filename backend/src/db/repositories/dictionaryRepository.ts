import { escapeSqlLiteral } from '../../state-plane/stdbSyncClient.js';
import { stdbDictionaryIngest, stdbDictionaryRows } from './stdbDictionaryRuntime.js';

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

	private parseStdbRows(rows: Array<Record<string, unknown>>): DictionaryEntry[] {
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

	private findExactStdb(term: string, language: string | undefined, workspaceId = 'default-workspace'): DictionaryEntry | null {
		const normalized = normalizeTerm(term);
		const lang = normalizeLanguage(language);
		const workspace = normalizeWorkspaceId(workspaceId);
		const rows = stdbDictionaryRows(
			'dictionary.read_exact',
			`SELECT row_json FROM state_dictionary_entry WHERE workspace_id = ${escapeSqlLiteral(workspace)} AND language = ${escapeSqlLiteral(lang)} AND term_normalized = ${escapeSqlLiteral(normalized)} LIMIT 1`
		);
		const parsed = this.parseStdbRows(rows);
		return parsed.length > 0 ? parsed[0] : null;
	}

	private searchStdb(term: string, language: string | undefined, workspaceId = 'default-workspace', limit = 12): DictionaryEntry[] {
		const normalized = normalizeTerm(term);
		const lang = normalizeLanguage(language);
		const workspace = normalizeWorkspaceId(workspaceId);
		const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
		const rows = stdbDictionaryRows(
			'dictionary.search',
			`SELECT row_json FROM state_dictionary_entry WHERE workspace_id = ${escapeSqlLiteral(workspace)} AND language = ${escapeSqlLiteral(lang)}`
		);
		const parsed = this.parseStdbRows(rows);
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
		this.upsertStdb(next);
		return this.findExact(term, language, workspaceId) || next;
	}

	findExact(term: string, language: string | undefined, workspaceId = 'default-workspace'): DictionaryEntry | null {
		return this.findExactStdb(term, language, workspaceId);
	}

	search(term: string, language: string | undefined, workspaceId = 'default-workspace', limit = 12): DictionaryEntry[] {
		return this.searchStdb(term, language, workspaceId, limit);
	}

	deleteByTerm(params: {
		workspaceId?: string;
		term: string;
		language?: string;
		requestingUserId: number;
		canModerate: boolean;
	}): number {
		const workspaceId = normalizeWorkspaceId(params.workspaceId);
		const lang = normalizeLanguage(params.language);
		const existing = this.findExact(params.term, lang, workspaceId);
		if (!existing) return 0;
		if (!params.canModerate && existing.created_by_user_id !== params.requestingUserId) {
			return 0;
		}
		this.deleteStdb(existing);
		return 1;
	}
}

export const dictionaryRepository = new DictionaryRepository();
