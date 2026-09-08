/** TURN configuration parsing and session ownership, independent of media lifecycles. */
export interface TurnEndpoint { server: string; port: string; useTurns: boolean }
export interface TurnCredential extends TurnEndpoint { username: string; credential: string; expiresAt: number }
export interface TurnCredentialScope {
	server: string;
	account: string;
	generation: number;
	token: string;
	preferredRelayId: number | null;
}

const REFRESH_SKEW_SECONDS = 30;

export function readTurnEndpoint(server: unknown, port: unknown, useTurns: unknown): TurnEndpoint | null {
	if (typeof server !== 'string' || !server.trim() || typeof useTurns !== 'boolean') return null;
	const raw = server.trim();
	if (/[\s\\/?#@]/.test(raw) || (raw.startsWith('[') && !raw.endsWith(']'))) return null;
	const host = raw.includes(':') && !raw.startsWith('[') ? `[${raw}]` : raw;
	try {
		const parsed = new URL(`http://${host}`);
		if (parsed.port || parsed.pathname !== '/' || parsed.username || parsed.password) return null;
		const number = typeof port === 'number' ? port : typeof port === 'string' && /^\d+$/.test(port) ? Number(port) : 0;
		if (!Number.isInteger(number) || number <= 0 || number > 65535) return null;
		return { server: parsed.hostname, port: String(number), useTurns };
	} catch { return null; }
}

export function turnUrls(endpoint: TurnEndpoint): string[] {
	const address = `${endpoint.server}:${endpoint.port}`;
	// TURN over TLS uses TCP. turns:?transport=udp is not a browser TURN URI.
	return endpoint.useTurns ? [`turns:${address}?transport=tcp`]
		: [`turn:${address}?transport=udp`, `turn:${address}?transport=tcp`];
}

export function stunUrl(endpoint: TurnEndpoint): string | null {
	// A TLS listener is not also a plaintext STUN listener on the same port.
	return endpoint.useTurns ? null : `stun:${endpoint.server}:${endpoint.port}`;
}

export function readTurnCredentials(payload: unknown, nowSeconds: number): TurnCredential | null {
	const turn = (payload as { turn?: Partial<TurnCredential> } | null)?.turn;
	if (!turn) return null;
	const endpoint = readTurnEndpoint(turn.server, turn.port, turn.useTurns);
	if (!endpoint || typeof turn.username !== 'string' || !turn.username.trim() ||
		typeof turn.credential !== 'string' || !turn.credential.trim() ||
		typeof turn.expiresAt !== 'number' || !Number.isFinite(turn.expiresAt) ||
		turn.expiresAt - nowSeconds <= REFRESH_SKEW_SECONDS) return null;
	return { ...endpoint, username: turn.username, credential: turn.credential, expiresAt: turn.expiresAt };
}

function scopeKey(scope: TurnCredentialScope | null): string | null {
	return scope?.token ? JSON.stringify([scope.server, scope.account, scope.generation, scope.preferredRelayId]) : null;
}

/** One cache belongs to one observed server/account/session/relay selection.
 * A→B→A selection invalidates old A work too; it cannot publish into the new visit.
 * Refreshing an access token for the same account does not discard valid TURN credentials. */
export function createTurnCredentialSource(deps: {
	context: () => TurnCredentialScope | null;
	request: (url: string, token: string, signal: AbortSignal) => Promise<Response>;
	now?: () => number;
	timeoutMs?: number;
}) {
	const now = deps.now ?? (() => Date.now() / 1000);
	let selectedKey: string | null = null;
	let revision = 0;
	let cached: TurnCredential | null = null;
	let flight: { revision: number; controller: AbortController; promise: Promise<void> } | null = null;
	function reset() {
		revision++;
		cached = null;
		flight?.controller.abort();
		flight = null;
	}
	function reconcile() {
		const scope = deps.context();
		const nextKey = scopeKey(scope);
		if (nextKey !== selectedKey) { selectedKey = nextKey; reset(); }
		return scope;
	}
	function get(): TurnCredential | null {
		reconcile();
		return cached && cached.expiresAt - now() > REFRESH_SKEW_SECONDS ? { ...cached } : null;
	}
	function prefetch(): Promise<void> {
		const current = reconcile();
		if (!current || !selectedKey || get()) return Promise.resolve();
		if (flight) return flight.promise;
		const scope = { ...current };
		const capturedRevision = revision;
		const controller = new AbortController();
		const url = new URL(`${scope.server}/api/media/turn-credentials`);
		if (scope.preferredRelayId !== null) url.searchParams.set('relayId', String(scope.preferredRelayId));
		let timer: ReturnType<typeof setTimeout>;
		let removeAbort = () => {};
		const cancelled = new Promise<never>((_, reject) => {
			const cancel = () => reject(controller.signal.reason);
			controller.signal.addEventListener('abort', cancel, { once: true });
			removeAbort = () => controller.signal.removeEventListener('abort', cancel);
			timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 5000);
		});
		// The deadline includes JSON body consumption and refresh, not just headers.
		// Promise.race also bounds transports/fixtures that ignore AbortSignal.
		const work = Promise.resolve().then(async () => {
			if (controller.signal.aborted) return null;
			const response = await deps.request(url.href, scope.token, controller.signal);
			return response.ok ? readTurnCredentials(await response.json(), now()) : null;
		});
		const promise = Promise.race([work, cancelled]).then(credential => {
			reconcile();
			if (!controller.signal.aborted && revision === capturedRevision && credential) cached = credential;
		}).catch(() => {
			// Disabled TURN, denied credentials and outages retain the explicit static
			// fallback, never another session's credential or a fabricated success.
		}).finally(() => {
			clearTimeout(timer);
			removeAbort();
			if (flight?.revision === capturedRevision) flight = null;
		});
		flight = { revision: capturedRevision, controller, promise };
		return promise;
	}
	return { get, prefetch, reconcile, invalidate: reset };
}
