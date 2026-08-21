import { browser } from '$app/environment';
import { getAuthToken, setAuthToken } from '../authSession';
import { getApiBase } from './utils';

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
	const base = (() => {
		try {
			const raw = serverUrl || '';
			const trimmed = raw.trim();
			if (trimmed) return trimmed.replace(/\/+$/, '').toLowerCase();
		} catch {
			/* ignore */
		}
		return 'default';
	})();
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
let inFlight: Promise<boolean> | null = null;

/**
 * Exchange the stored refresh token for a fresh access+refresh pair.
 * Returns true on success. Never throws — a false means "re-authenticate".
 */
export async function tryRefresh(serverUrl?: string | null): Promise<boolean> {
	if (inFlight) return inFlight;

	inFlight = (async () => {
		const refreshToken = getRefreshToken(serverUrl);
		if (!refreshToken) return false;

		try {
			const res = await fetch(`${getApiBase()}/api/auth/refresh`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ refreshToken })
			});

			// 401 here means the refresh token itself is expired/revoked/reused.
			// Surface as "needs login" — do NOT recurse into another refresh.
			if (!res.ok) {
				clearRefreshToken(serverUrl);
				setAuthToken(null, serverUrl);
				return false;
			}

			const data = (await res.json()) as {
				accessToken?: string;
				refreshToken?: string;
				token?: string;
			} | null;

			if (!data) return false;

			const newAccess = data.accessToken || data.token;
			if (!newAccess) return false;

			setAuthToken(newAccess, serverUrl);
			// Rotate: a fresh refresh token comes back; if absent, keep the old.
			if (data.refreshToken) setRefreshToken(data.refreshToken, serverUrl);
			return true;
		} catch {
			// Network failure — don't clear tokens; caller can retry later.
			return false;
		} finally {
			inFlight = null;
		}
	})();

	return inFlight;
}
