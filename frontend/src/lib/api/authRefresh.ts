const browser: boolean = typeof window !== 'undefined' && typeof document !== 'undefined';
import { getAuthToken, setAuthToken, clearAuthToken, authSessionGeneration } from '../authSession';
import { getServerUrl, normalizeServerUrl } from '../serverUrl';

// Refresh tokens are stored server-scoped, session-scoped (cleared when the
// tab closes), mirroring the access-token storage convention in authSession.ts.
const REFRESH_TOKEN_KEY_PREFIX = 'wabi_refresh_token:';

function normalize(value: string | null | undefined): string | null {
	if (!value) return null;
	const t = value.trim();
	return t.length > 0 ? t : null;
}

function scopeKey(serverUrl?: string | null): string {
	// Reuse the same scope derivation as authSession so the refresh token
	// lives next to its sibling access token.
	const base = normalizeServerUrl(serverUrl || getServerUrl()) || 'ssr_default';
	return `${REFRESH_TOKEN_KEY_PREFIX}${encodeURIComponent(base)}`;
}

function safeGet(key: string): string | null {
	try {
		return sessionStorage.getItem(key);
	} catch {
		return null;
	}
}

function safeSet(key: string, value: string | null): void {
	try {
		if (value) sessionStorage.setItem(key, value);
		else sessionStorage.removeItem(key);
	} catch {
		/* ignore */
	}
}

export function getRefreshToken(serverUrl?: string | null): string | null {
	if (!browser) return null;
	return normalize(safeGet(scopeKey(serverUrl)));
}

export function setRefreshToken(token: string | null, serverUrl?: string | null): void {
	if (!browser) return;
	safeSet(scopeKey(serverUrl), normalize(token) ?? null);
}

export function clearRefreshToken(serverUrl?: string | null): void {
	setRefreshToken(null, serverUrl);
}

/**
 * Stampede guard: a single in-flight refresh promise shared across all 401
 * handlers. Concurrent expired requests wait on this instead of each firing
 * their own refresh (which would burn the single-use refresh token N times).
 */
const inFlight = new Map<string, Promise<boolean>>();

/**
 * Exchange the stored refresh token for a fresh access+refresh pair.
 * Returns true on success. Never throws — a false means "re-authenticate".
 */
export async function tryRefresh(serverUrl?: string | null): Promise<boolean> {
	const base = normalizeServerUrl(serverUrl || getServerUrl());
	if (!browser || !base) return false;
	const generation = authSessionGeneration(base);
	const key = JSON.stringify([base, generation]);
	const existing = inFlight.get(key);
	if (existing) return existing;
	// Resolve and capture the server/account before yielding. Never send a token
	// to whichever server happens to be selected when the request resumes.
	const refreshToken = getRefreshToken(base);
	const accessBefore = getAuthToken(base);
	if (!refreshToken || !accessBefore) return false;
	const stillCurrent = () => authSessionGeneration(base) === generation && getAuthToken(base) === accessBefore && getRefreshToken(base) === refreshToken;
	const pending = Promise.resolve().then(async () => {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15000);
		try {
			if (!stillCurrent()) return false;
			const res = await fetch(`${base}/api/auth/refresh`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				signal: controller.signal,
				body: JSON.stringify({ refreshToken })
			});

			// 401 here means the refresh token itself is expired/revoked/reused.
			// Surface as "needs login" — do NOT recurse into another refresh.
			if (!res.ok) {
				if ((res.status === 401 || res.status === 403) && stillCurrent()) {
					clearRefreshToken(base);
					clearAuthToken(base);
				}
				return false;
			}

			const data = (await res.json()) as {
				accessToken?: string;
				refreshToken?: string;
				token?: string;
			} | null;

			if (!data) return false;

			const newAccess = data.accessToken || data.token;
			if (!newAccess || !stillCurrent()) return false;

			setAuthToken(newAccess, base);
			// Rotate: a fresh refresh token comes back; if absent, keep the old.
			if (data.refreshToken) setRefreshToken(data.refreshToken, base);
			return true;
		} catch {
			// Network failure — don't clear tokens; caller can retry later.
			return false;
		} finally {
			clearTimeout(timeout);
			if (inFlight.get(key) === pending) inFlight.delete(key);
		}
	});
	inFlight.set(key, pending);
	return pending;
}
