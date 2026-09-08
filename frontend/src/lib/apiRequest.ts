export interface ApiRequestSession {
	generation: number;
	accountId: string | null;
	token: string | null;
}

export type RequestWithTimeout = RequestInit & { timeoutMs?: number; retries?: number };

export class ApiRequestSessionChangedError extends Error {
	constructor() { super('Your session changed before the request completed.'); this.name = 'ApiRequestSessionChangedError'; }
}

export const API_TIMEOUT_MS = 15_000;
export const RETRY_DELAYS_MS = [600, 2000];

/** Account identity is only a client-side retry fence, never authentication.
 * Token signatures and permissions remain entirely the server's responsibility. */
export function accountTokenSubject(token: string | null): string | null {
	try {
		if (!token) return null;
		const segments = token.split('.');
		if (segments.length !== 3) return null;
		const encoded = segments[1].replace(/-/g, '+').replace(/_/g, '/');
		const claims = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
		return typeof claims.sub === 'string' && claims.sub.length > 0 ? claims.sub : null;
	} catch { return null; }
}

/** Preserve reverse-proxy prefixes and explicitly addressed background servers.
 * Never derive refresh ownership from the server selected after an await. */
export function apiRequestScope(url: string, base: string): { url: string; server: string | null; refreshablePath: boolean } {
	const capturedBase = new URL(base);
	const basePath = capturedBase.pathname.replace(/\/+$/, '');
	const destination = new URL(url, base.replace(/\/+$/, '') + '/');
	// A resource path (notably a Lore filename) may itself contain /api/.
	// Prefer the known exact base; the fallback handles explicit inactive servers.
	const api = destination.origin === capturedBase.origin && destination.pathname.startsWith(basePath + '/api/')
		? basePath.length : destination.pathname.lastIndexOf('/api/');
	const server = ['http:', 'https:'].includes(destination.protocol) && api >= 0
		? destination.origin + destination.pathname.slice(0, api) : null;
	const path = api >= 0 ? destination.pathname.slice(api).replace(/\/+$/, '') : '';
	return { url: destination.href, server, refreshablePath: path !== '/api/auth/login' && path !== '/api/auth/refresh' };
}

function aborted(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException('Request cancelled', 'AbortError');
}

/** Settle even when a fixture/transport ignores AbortSignal. A shared refresh
 * may continue for other callers, but this request cannot replay after abort. */
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) { void work.catch(() => {}); throw aborted(signal); }
	let remove = () => {};
	const cancellation = new Promise<never>((_, reject) => {
		const cancel = () => reject(aborted(signal));
		signal.addEventListener('abort', cancel, { once: true });
		remove = () => signal.removeEventListener('abort', cancel);
	});
	try { return await Promise.race([work, cancellation]); }
	finally { remove(); }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) { reject(aborted(signal)); return; }
		const cancel = () => { clearTimeout(timer); reject(aborted(signal)); };
		const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
		signal.addEventListener('abort', cancel, { once: true });
	});
}

/** One request owns its URL, credentials, cancellation and finite retry budget.
 * Only explicit network retries repeat uncertain transport failures. A 401 may
 * refresh a recognized account credential once; never substitute a bot/Lore
 * credential or credentials belonging to another account/server. */
export function createApiRequester(dependencies: {
	fetch: (url: string, options: RequestInit) => Promise<Response>;
	base: () => string;
	session: (server: string) => ApiRequestSession;
	refresh: (server: string) => Promise<boolean>;
	onSessionCleared?: (listener: (server: string) => void) => () => void;
	retryDelays?: number[];
}) {
	return async function request(url: string, options: RequestWithTimeout = {}): Promise<Response> {
		const { timeoutMs: requestedTimeout, retries: requestedRetries = 0, signal: external, ...init } = options;
		const timeoutMs = typeof requestedTimeout === 'number' && Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : API_TIMEOUT_MS;
		let retries = Number.isSafeInteger(requestedRetries) && requestedRetries > 0 ? requestedRetries : 0;
		const destination = apiRequestScope(url, dependencies.base());
		const headers = new Headers(init.headers);
		const authorization = headers.get('Authorization');
		const origin = authorization && destination.server ? dependencies.session(destination.server) : null;
		const subject = accountTokenSubject(origin?.token ?? null);
		const ownsCredential = Boolean(origin?.token && authorization === `Bearer ${origin.token}`);
		const replayable = !(typeof ReadableStream !== 'undefined' && init.body instanceof ReadableStream);
		let refreshed = false;
		let failures = 0;
		const lifetime = new AbortController();
		const cancel = () => lifetime.abort(external?.reason);
		if (external?.aborted) cancel(); else external?.addEventListener('abort', cancel, { once: true });
		const unsubscribe = origin && destination.server ? dependencies.onSessionCleared?.(server => {
			if (server === destination.server) lifetime.abort(new ApiRequestSessionChangedError());
		}) : undefined;
		const current = (allowRemovedCredential = false) => {
			if (!origin || !destination.server) return true;
			const next = dependencies.session(destination.server);
			return next.generation === origin.generation && next.accountId === origin.accountId &&
				(ownsCredential ? (allowRemovedCredential && next.token === null) || Boolean(next.token) && (subject === null ? next.token === origin.token : accountTokenSubject(next.token) === subject) : next.token === origin.token);
		};
		const check = (allowRemovedCredential = false) => {
			if (lifetime.signal.aborted) throw aborted(lifetime.signal);
			if (!current(allowRemovedCredential)) throw new ApiRequestSessionChangedError();
		};
		try {
			while (true) {
				check();
				const attempt = new AbortController();
				const retire = () => attempt.abort(lifetime.signal.reason);
				lifetime.signal.addEventListener('abort', retire, { once: true });
				const timeoutError = new Error(`Request timed out after ${timeoutMs}ms`);
				const timeout = setTimeout(() => attempt.abort(timeoutError), timeoutMs);
				// Native composition also keeps caller cancellation connected to a
				// streaming response after headers have been returned. Older webviews
				// retain the explicit in-flight forwarding above.
				const signal = external && typeof AbortSignal.any === 'function' ? AbortSignal.any([attempt.signal, external]) : attempt.signal;
				let retry = false;
				try {
					const response = await untilAborted(dependencies.fetch(destination.url, {
						...init, headers: new Headers(headers), credentials: init.credentials ?? 'include', signal,
					}), attempt.signal);
					check();
					if (attempt.signal.aborted) throw aborted(attempt.signal);
					if (response.status !== 401 || !/\bjson\b/i.test(response.headers.get('Content-Type') ?? '') ||
						!destination.refreshablePath || !destination.server || !ownsCredential || refreshed || !replayable) return response;
					refreshed = true;
					// A sibling request may already have rotated the same account's
					// token. Use that result without burning a second refresh token.
					let next = dependencies.session(destination.server).token;
					if (next === origin!.token) {
						const accepted = await untilAborted(dependencies.refresh(destination.server), attempt.signal);
						// Real refresh denial removes expired credentials. Preserve the
						// original 401 for login recovery, but never a replacement account
						// or a new same-account generation. No retry follows this branch.
						check(!accepted);
						if (attempt.signal.aborted) throw aborted(attempt.signal);
						if (!accepted) return response;
						next = dependencies.session(destination.server).token;
					}
					check();
					if (!next || (subject !== null && accountTokenSubject(next) !== subject)) return response;
					headers.set('Authorization', `Bearer ${next}`);
					void response.body?.cancel().catch(() => {});
					// Auth retry consumes its single separate budget, never resets
					// configured network retries or recursively refreshes again.
				} catch (error) {
					check();
					if (attempt.signal.aborted) throw aborted(attempt.signal);
					if (error instanceof ApiRequestSessionChangedError || !replayable || retries === 0) throw error;
					retries--; failures++; retry = true;
				} finally {
					clearTimeout(timeout);
					lifetime.signal.removeEventListener('abort', retire);
				}
				if (retry) {
					const delays = dependencies.retryDelays ?? RETRY_DELAYS_MS;
					await delay(delays[Math.min(failures - 1, delays.length - 1)] ?? 0, lifetime.signal);
				}
			}
		} finally {
			external?.removeEventListener('abort', cancel);
			unsubscribe?.();
		}
	};
}
