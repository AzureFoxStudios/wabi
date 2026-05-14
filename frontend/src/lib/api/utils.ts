import { getServerUrl } from '../serverUrl';

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

export async function safeJsonParse(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return {};
	}
}

export function isPositiveNumber(value: unknown): boolean {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function toQueryParam(value: unknown): string | null {
	return typeof value === 'number' && Number.isFinite(value) ? String(Math.floor(value)) : null;
}
