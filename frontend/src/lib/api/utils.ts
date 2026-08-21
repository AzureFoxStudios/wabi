import { browser } from '$app/environment';
import { getServerUrl } from '../serverUrl';
import { tryRefresh, setRefreshToken } from './authRefresh';
import { getAuthToken } from '../authSession';

export const getApiBase = () => getServerUrl();
export const getApiBaseFor = (baseUrl?: string | null) => {
	if (typeof baseUrl === 'string' && baseUrl.trim().length > 0) {
		return baseUrl.trim().replace(/\/+$/, '');
	}
	return getApiBase();
};

export const API_TIMEOUT_MS = 15000;
export const LAUNCH_PAGE_TIMEOUT_MS = 5000;

export const RETRYABLE_STATUS = new Set([502, 503, 504]);
export const RETRY_DELAYS_MS = [600, 2000];

export type RequestWithTimeout = RequestInit & { timeoutMs?: number; retries?: number };

export async function fetchWithTimeout(url: string, options: RequestWithTimeout = {}): Promise<Response> {
	const { retries = 0, ...rest } = options;
	const controller = new AbortController();
	const timeoutMs =
		typeof rest.timeoutMs === 'number' && Number.isFinite(rest.timeoutMs) && rest.timeoutMs > 0
			? rest.timeoutMs
			: API_TIMEOUT_MS;
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const requestOptions: RequestInit = { ...rest };
	delete (requestOptions as RequestWithTimeout).timeoutMs;
	try {
		return await fetch(url, {
			...requestOptions,
			credentials: requestOptions.credentials ?? 'include',
			signal: controller.signal
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError') {
			throw new Error(`Request timed out after ${timeoutMs}ms`);
		}
		if (retries > 0) {
			const delay = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - retries] ?? RETRY_DELAYS_MS[0];
			await new Promise(r => setTimeout(r, delay));
			return fetchWithTimeout(url, { ...options, retries: retries - 1 });
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

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

/**
 * Fetch wrapper that silently refreshes an expired access token on 401 and
 * retries the original request once. Mirrors fetchWithTimeout's signature so
 * callers can drop it in. On refresh failure (no token, or refresh returned
 * its own 401) the original 401 Response is returned — callers classify it as
 * auth-fatal and route to login.
 */
export async function fetchWithAuth(
	url: string,
	options: RequestWithTimeout = {}
): Promise<Response> {
	const res = await fetchWithTimeout(url, options);

	// Only act on clean 401s from JSON API responses, not auth-fatal bodies
	// the caller needs to inspect (e.g., "token reuse detected").
	if (res.status !== 401 || !isJsonContentType(res)) return res;

	// Don't try to refresh auth endpoints themselves.
	try {
		const path = new URL(url, getApiBase()).pathname;
		if (path.endsWith('/auth/refresh') || path.endsWith('/auth/login')) return res;
	} catch {
		/* ignore parse failure, fall through to refresh attempt */
	}

	const ok = await tryRefresh();
	if (!ok) return res;

	// Retry with the freshly minted access token.
	const headers = new Headers(options.headers);
	const token = getAuthToken();
	if (token) headers.set('Authorization', `Bearer ${token}`);
	return fetchWithTimeout(url, { ...options, headers });
}

export function isPositiveNumber(value: unknown): boolean {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function toQueryParam(value: unknown): string | null {
	return typeof value === 'number' && Number.isFinite(value) ? String(Math.floor(value)) : null;
}
