import { getApiBase, fetchWithTimeout, safeJsonParse } from './utils';

export interface DictionaryEntry {
	id?: number;
	term: string;
	definition: string;
	language: string;
	createdByUserId?: number | null;
	createdByUsername?: string | null;
	createdAt: number;
	updatedAt: number;
	votes: number;
}

export async function lookupDictionary(term: string, language = 'en', limit = 8): Promise<DictionaryEntry[]> {
	const params = new URLSearchParams({
		term,
		language,
		limit: String(limit)
	});
	const res = await fetchWithTimeout(`${getApiBase()}/api/dictionary?${params.toString()}`, { method: 'GET' });
	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Failed to lookup dictionary entry');
	}
	const data = await res.json();
	return Array.isArray(data.entries) ? data.entries : [];
}

export async function upsertDictionaryEntry(
	token: string,
	term: string,
	definition: string,
	language = 'en'
): Promise<DictionaryEntry> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/dictionary`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ term, definition, language })
	});
	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Failed to save dictionary entry');
	}
	const data = await res.json();
	return data.entry as DictionaryEntry;
}

export async function deleteDictionaryEntry(token: string, term: string, language = 'en'): Promise<void> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/dictionary`, {
		method: 'DELETE',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ term, language })
	});
	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Failed to delete dictionary entry');
	}
}
