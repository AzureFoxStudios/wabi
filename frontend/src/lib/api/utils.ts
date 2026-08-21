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
		const res = await fetch(url, {
			...requestOptions,
			credentials: requestOptions.credentials ?? 'include',
			signal: controller.signal
		});
		return await refreshAndRetry(url, res, options);
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

/**
 * Silent-refresh retry for expired access tokens, folded into the shared
 * fetch wrapper so every API module gets it without per-file migration.
 * Fires only when the original request carried an Authorization header
 * (i.e. it authenticated and its token has since expired), never on auth
 * endpoints themselves, and never more than once — on refresh failure the
 * original 401 is returned for the caller to classify as auth-fatal.
 */
async function refreshAndRetry(url: string, res: Response, options: RequestWithTimeout): Promise<Response> {
	const hadAuthHeader = new Headers(options.headers).has('Authorization');
	if (!hadAuthHeader || res.status !== 401 || !isJsonContentType(res)) return res;

	try {
		const path = new URL(url, getApiBase()).pathname;
		if (path.endsWith('/auth/refresh') || path.endsWith('/auth/login')) return res;
	} catch {
		return res; // unparseable URL — don't risk a loop
	}

	const ok = await tryRefresh();
	if (!ok) return res;

	const headers = new Headers(options.headers);
	const token = getAuthToken();
	if (token) headers.set('Authorization', `Bearer ${token}`);
	return fetchWithTimeout(url, { ...options, headers });
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

export function isPositiveNumber(value: unknown): boolean {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function toQueryParam(value: unknown): string | null {
	return typeof value === 'number' && Number.isFinite(value) ? String(Math.floor(value)) : null;
}
