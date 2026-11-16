/**
 * "Failed to fetch" is all a browser reports when a request never completes.
 * These probes separate the usual causes (no network path, a blocked
 * cross-origin request, the page's own content security policy) so the sign-in
 * screen can show something a person can act on or send to support.
 */
const PROBE_TIMEOUT_MS = 6000;
const blockedByPolicy: string[] = [];

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
	document.addEventListener('securitypolicyviolation', (event) => {
		if (blockedByPolicy.length < 5) blockedByPolicy.push(`${event.violatedDirective} blocked ${event.blockedURI}`);
	});
}

/** True for the error fetch throws when no response arrived at all. */
export function isNetworkFailure(error: unknown): boolean {
	return error instanceof TypeError;
}

async function probe(url: string, init: RequestInit): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		const response = await fetch(url, { cache: 'no-store', ...init, signal: controller.signal });
		// An opaque response still proves the server answered.
		return response.type === 'opaque' ? 'answered' : `HTTP ${response.status}`;
	} catch (error) {
		if (controller.signal.aborted) return `no answer in ${PROBE_TIMEOUT_MS / 1000}s`;
		return `failed (${error instanceof Error ? error.message : String(error)})`;
	} finally {
		clearTimeout(timer);
	}
}

/** Plain-text lines describing why requests to `server` are failing. */
export async function describeConnectionFailure(server: string): Promise<string> {
	const health = `${server.replace(/\/+$/, '')}/health`;
	const [reach, read, withCookies, preflight] = await Promise.all([
		probe(health, { mode: 'no-cors', credentials: 'omit' }),
		probe(health, { credentials: 'omit' }),
		probe(health, { credentials: 'include' }),
		probe(health, { credentials: 'include', headers: { 'Content-Type': 'application/json' } }),
	]);
	return [
		`Server: ${server}`,
		`App origin: ${typeof location !== 'undefined' ? location.origin : 'unknown'}`,
		`Device online: ${typeof navigator !== 'undefined' && 'onLine' in navigator ? navigator.onLine : 'unknown'}`,
		`Reach server: ${reach}`,
		`Read response: ${read}`,
		`With sign-in cookies: ${withCookies}`,
		`With JSON request: ${preflight}`,
		`Blocked by app policy: ${blockedByPolicy.length ? blockedByPolicy.join('; ') : 'nothing'}`,
		`Browser: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'}`,
	].join('\n');
}
