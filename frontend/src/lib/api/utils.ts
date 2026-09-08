import { getServerUrl } from '../serverUrl';
import { tryRefresh } from './authRefresh';
import { getAuthToken, getStoredDbUserId, authSessionGeneration, onAuthSessionCleared } from '../authSession';
import { createApiRequester, accountTokenSubject } from '../apiRequest';
export { API_TIMEOUT_MS, RETRY_DELAYS_MS, type RequestWithTimeout } from '../apiRequest';

export const getApiBase = () => getServerUrl();
export const getApiBaseFor = (baseUrl?: string | null) => {
	if (typeof baseUrl === 'string' && baseUrl.trim().length > 0) {
		return baseUrl.trim().replace(/\/+$/, '');
	}
	return getApiBase();
};

export const LAUNCH_PAGE_TIMEOUT_MS = 5000;

export const RETRYABLE_STATUS = new Set([502, 503, 504]);
export const fetchWithTimeout = createApiRequester({
	fetch: (url, options) => fetch(url, options),
	base: getApiBase,
	session: server => {
		const token = getAuthToken(server);
		return { token, generation: authSessionGeneration(server), accountId: getStoredDbUserId(server)?.toString() ?? accountTokenSubject(token) };
	},
	refresh: tryRefresh,
	onSessionCleared: onAuthSessionCleared,
});

/** True when Content-Type looks like JSON (incl. +json). */
export function isJsonContentType(response: Response): boolean {
	const ct = response.headers.get('content-type') || '';
	return /\bjson\b/i.test(ct) || /[+_/]json\b/i.test(ct);
}

/**
 * Parse a Response as JSON only when it is actually JSON.
 * SPA fallback often returns 200 text/html for missing API routes — never
 * call response.json() on that (SyntaxError @ col 1).
 *
 * Returns null for non-JSON / empty / parse failure (callers treat as missing).
 * safeJsonParse keeps the older {} fallback for admin error bodies.
 */
export async function parseApiJson(response: Response): Promise<unknown | null> {
	const ct = response.headers.get('content-type') || '';
	// Fast reject: explicit HTML or missing json content-type on 2xx SPA shells
	if (!isJsonContentType(response)) {
		// Peek body start without throwing when content-type lied or was empty
		try {
			const text = await response.clone().text();
			const trimmed = text.trimStart();
			if (!trimmed) return null;
			if (trimmed.startsWith('<!') || trimmed.startsWith('<html') || trimmed.startsWith('<HTML')) {
				return null;
			}
			// content-type wrong but body might still be JSON
			try {
				return JSON.parse(text) as unknown;
			} catch {
				return null;
			}
		} catch {
			return null;
		}
	}
	try {
		return await response.json();
	} catch {
		return null;
	}
}

export async function safeJsonParse(response: Response): Promise<unknown> {
	const parsed = await parseApiJson(response);
	return parsed ?? {};
}

export function isPositiveNumber(value: unknown): boolean {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function toQueryParam(value: unknown): string | null {
	return typeof value === 'number' && Number.isFinite(value) ? String(Math.floor(value)) : null;
}
