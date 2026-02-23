import { dictionaryRepository } from '../db/repositories/dictionaryRepository.js';
import { userRepository } from '../db/repositories/userRepository.js';

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

async function readJsonBody(req: any): Promise<any> {
	let body = '';
	for await (const chunk of req) {
		body += chunk.toString();
	}
	return body ? JSON.parse(body) : {};
}

function sendJson(res: any, status: number, payload: unknown): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(payload));
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

export async function handleDictionaryLookup(req: any, res: any, url: URL): Promise<void> {
	try {
		const term = sanitizeTerm(url.searchParams.get('term'));
		if (!term) {
			sendJson(res, 400, { error: 'term is required' });
			return;
		}
		const language = normalizeLanguage(url.searchParams.get('language') || undefined);
		const workspaceId = normalizeWorkspaceId(url.searchParams.get('workspaceId') || undefined);
		const rawLimit = Number(url.searchParams.get('limit') || '12');
		const limit = Number.isFinite(rawLimit) ? rawLimit : 12;

		const entries = dictionaryRepository.search(term, language, workspaceId, limit).map(toClientEntry);
		sendJson(res, 200, { entries });
	} catch (error) {
		console.error('[Dictionary] Lookup failed:', error);
		sendJson(res, 500, { error: 'Failed to lookup dictionary term' });
	}
}

export async function handleDictionaryUpsert(req: any, res: any, userId: number): Promise<void> {
	try {
		const body = await readJsonBody(req);
		const term = sanitizeTerm(body?.term);
		const definition = sanitizeDefinition(body?.definition);
		const language = normalizeLanguage(body?.language);
		const workspaceId = normalizeWorkspaceId(body?.workspaceId);

		if (!term || !definition) {
			sendJson(res, 400, { error: 'term and definition are required' });
			return;
		}
		if (term.length > 120) {
			sendJson(res, 400, { error: 'term is too long (max 120 chars)' });
			return;
		}
		if (definition.length > 2000) {
			sendJson(res, 400, { error: 'definition is too long (max 2000 chars)' });
			return;
		}

		const user = userRepository.findById(userId);
		const entry = dictionaryRepository.upsert({
			workspaceId,
			term,
			definition,
			language,
			createdByUserId: userId,
			createdByUsername: user?.username || null
		});

		sendJson(res, 200, { entry: toClientEntry(entry) });
	} catch (error) {
		console.error('[Dictionary] Upsert failed:', error);
		sendJson(res, 400, { error: 'Invalid dictionary payload' });
	}
}

export async function handleDictionaryDelete(req: any, res: any, userId: number, canModerate: boolean): Promise<void> {
	try {
		const body = await readJsonBody(req);
		const term = sanitizeTerm(body?.term);
		const language = normalizeLanguage(body?.language);
		const workspaceId = normalizeWorkspaceId(body?.workspaceId);

		if (!term) {
			sendJson(res, 400, { error: 'term is required' });
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
			sendJson(res, 404, { error: 'Entry not found or permission denied' });
			return;
		}

		sendJson(res, 200, { success: true, deleted });
	} catch (error) {
		console.error('[Dictionary] Delete failed:', error);
		sendJson(res, 400, { error: 'Invalid dictionary payload' });
	}
}
