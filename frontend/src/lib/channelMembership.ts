/** In-flight coordination only, never a cache of authorization. Server checks
 * remain authoritative for every operation, including after membership loss. */
export function createChannelMembership(deps: {
	server: () => string;
	token: () => string | null;
	fetch: (url: string, options: RequestInit) => Promise<Response>;
	access?: (channelId: string) => () => boolean;
}) {
	const pending = new Map<string, Promise<{ server: string; token: string }>>();
	function subject(token: string): string | null {
		try {
			const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
			return typeof payload.sub === 'string' ? payload.sub : null;
		} catch { return null; }
	}
	function current(server: string, token: string): string {
		const next = deps.token();
		// This comparison only cancels stale client work; it never authenticates
		// a JWT. Permit a same-account access-token refresh during the join.
		if (deps.server() !== server || !next ||
			(next !== token && (!subject(token) || subject(token) !== subject(next)))) {
			throw new Error('Session changed while opening the channel');
		}
		return next;
	}
	function ensure(channelId: string): Promise<{ server: string; token: string }> {
		let hasAccess: () => boolean;
		try { hasAccess = deps.access?.(channelId) ?? (() => true); }
		catch (error) { return Promise.reject(error); }
		const server = deps.server();
		const token = deps.token();
		if (!channelId || !token) return Promise.reject(new Error('Sign in to open this channel'));
		const key = JSON.stringify([server, token, channelId]);
		const existing = pending.get(key);
		if (existing) return existing;
		const work = (async () => {
			const response = await deps.fetch(`${server}/api/channels/${encodeURIComponent(channelId)}/join`, {
				method: 'POST', headers: { Authorization: `Bearer ${token}` }
			});
			const body = await response.json().catch(() => null);
			if (!response.ok) throw new Error(body?.error || `Cannot open channel (${response.status})`);
			if (body?.joined !== true || body?.channelId !== channelId) {
				throw new Error('Server did not confirm channel membership');
			}
			if (!hasAccess()) throw new Error('Group access changed while opening the channel');
			return { server, token: current(server, token) };
		})().finally(() => { pending.delete(key); });
		pending.set(key, work);
		return work;
	}
	async function fetchChannel(channelId: string, url: string, options: RequestInit = {}): Promise<Response> {
		const hasAccess = deps.access?.(channelId) ?? (() => true);
		const session = await ensure(channelId);
		if (!hasAccess()) throw new Error('Group access changed while opening the channel');
		if (!url.startsWith(`${session.server}/api/`)) throw new Error('Channel request belongs to another server');
		const headers = new Headers(options.headers);
		headers.set('Authorization', `Bearer ${current(session.server, session.token)}`);
		const response = await deps.fetch(url, { ...options, headers });
		current(session.server, session.token);
		if (!hasAccess()) throw new Error('Group access changed during the request');
		return response;
	}
	return { ensure, fetchChannel };
}
