import { IncomingMessage, ServerResponse } from 'http';
import { dictionaryRepository } from '../db/repositories/dictionaryRepository.js';
import { stateUserStore } from '../state-plane/index.js';
import {
	isInvalidJsonBodyError as isInvalidJsonError,
	isRequestBodyTooLargeError as isPayloadTooLargeError,
	readJsonObjectBody
} from '../utils/requestBodies.js';

const MAX_DICTIONARY_BODY_BYTES = Math.max(
	1024,
	Math.min(128 * 1024, Number(process.env.DICTIONARY_MAX_BODY_BYTES || 16 * 1024))
);

type DictionaryBody = Record<string, unknown>;

function normalizeWorkspaceId(input: string | undefined): string {
	const value = (input || 'default-workspace').trim();
	return value || 'default-workspace';
}

function normalizeLanguage(input: string | undefined): string {
	const value = (input || 'en').trim().toLowerCase();
	return value.length > 0 ? value.slice(0, 16) : 'en';
}

function sanitizeTerm(input: unknown): string {
	return typeof input === 'string' ? input.trim() : '';
}

function sanitizeDefinition(input: unknown): string {
	return typeof input === 'string' ? input.trim() : '';
}

function writeJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<DictionaryBody> {
	return await readJsonObjectBody(req, MAX_DICTIONARY_BODY_BYTES);
}

function toClientEntry(entry: {
	id?: number;
	term: string;
	definition: string;
	language: string;
	created_by_user_id?: number | null;
	created_by_username?: string | null;
	created_at: number;
	updated_at: number;
	votes: number;
}) {
	return {
		id: entry.id,
		term: entry.term,
		definition: entry.definition,
		language: entry.language,
		createdByUserId: entry.created_by_user_id ?? null,
		createdByUsername: entry.created_by_username ?? null,
		createdAt: entry.created_at,
		updatedAt: entry.updated_at,
		votes: entry.votes
	};
}

export async function handleDictionaryLookup(
	_req: IncomingMessage,
	res: ServerResponse,
	url: URL
): Promise<void> {
	try {
		const term = sanitizeTerm(url.searchParams.get('term'));
		if (!term) {
			writeJson(res, 400, { error: 'term is required' });
			return;
		}
		const language = normalizeLanguage(url.searchParams.get('language') || undefined);
		const workspaceId = normalizeWorkspaceId(url.searchParams.get('workspaceId') || undefined);
		const rawLimit = Number(url.searchParams.get('limit') || '12');
		const limit = Number.isFinite(rawLimit) ? rawLimit : 12;

		const entries = dictionaryRepository.search(term, language, workspaceId, limit).map(toClientEntry);
		writeJson(res, 200, { entries });
	} catch (error) {
		console.error('[Dictionary] Lookup failed:', error);
		writeJson(res, 500, { error: 'Failed to lookup dictionary term' });
	}
}

export async function handleDictionaryUpsert(
	req: IncomingMessage,
	res: ServerResponse,
	userId: number
): Promise<void> {
	try {
		const body = await readJsonBody(req);
		const term = sanitizeTerm(body.term);
		const definition = sanitizeDefinition(body.definition);
		const language = normalizeLanguage(typeof body.language === 'string' ? body.language : undefined);
		const workspaceId = normalizeWorkspaceId(typeof body.workspaceId === 'string' ? body.workspaceId : undefined);

		if (!term || !definition) {
			writeJson(res, 400, { error: 'term and definition are required' });
			return;
		}
		if (term.length > 120) {
			writeJson(res, 400, { error: 'term is too long (max 120 chars)' });
			return;
		}
		if (definition.length > 2000) {
			writeJson(res, 400, { error: 'definition is too long (max 2000 chars)' });
			return;
		}

		const user = stateUserStore.findById(userId);
		const entry = dictionaryRepository.upsert({
			workspaceId,
			term,
			definition,
			language,
			createdByUserId: userId,
			createdByUsername: user?.username || null
		});

		writeJson(res, 200, { entry: toClientEntry(entry) });
	} catch (error) {
		if (isPayloadTooLargeError(error)) {
			writeJson(res, 413, { error: 'Dictionary payload too large' });
			return;
		}
		if (isInvalidJsonError(error)) {
			writeJson(res, 400, { error: 'Invalid dictionary payload' });
			return;
		}
		console.error('[Dictionary] Upsert failed:', error);
		writeJson(res, 500, { error: 'Failed to save dictionary entry' });
	}
}

export async function handleDictionaryDelete(
	req: IncomingMessage,
	res: ServerResponse,
	userId: number,
	canModerate: boolean
): Promise<void> {
	try {
		const body = await readJsonBody(req);
		const term = sanitizeTerm(body.term);
		const language = normalizeLanguage(typeof body.language === 'string' ? body.language : undefined);
		const workspaceId = normalizeWorkspaceId(typeof body.workspaceId === 'string' ? body.workspaceId : undefined);

		if (!term) {
			writeJson(res, 400, { error: 'term is required' });
			return;
		}

		const deleted = dictionaryRepository.deleteByTerm({
			workspaceId,
			term,
			language,
			requestingUserId: userId,
			canModerate
		});

		if (deleted === 0) {
			writeJson(res, 404, { error: 'Entry not found or permission denied' });
			return;
		}

		writeJson(res, 200, { success: true, deleted });
	} catch (error) {
		if (isPayloadTooLargeError(error)) {
			writeJson(res, 413, { error: 'Dictionary payload too large' });
			return;
		}
		if (isInvalidJsonError(error)) {
			writeJson(res, 400, { error: 'Invalid dictionary payload' });
			return;
		}
		console.error('[Dictionary] Delete failed:', error);
		writeJson(res, 500, { error: 'Failed to delete dictionary entry' });
	}
}
