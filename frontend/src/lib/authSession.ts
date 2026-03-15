import { browser } from '$app/environment';
import { normalizeServerUrl, resolveServerUrl } from './serverUrl';

const LEGACY_AUTH_TOKEN_KEY = 'authToken';
const LEGACY_SESSION_ID_KEY = 'sessionId';
const LEGACY_USERNAME_KEY = 'username';
const LEGACY_DB_USER_ID_KEY = 'dbUserId';
const LEGACY_SCOPED_SESSION_AUTH_TOKEN_KEY = 'wabi_auth_token';
const LEGACY_SCOPED_SESSION_GUEST_SESSION_ID_KEY = 'wabi_guest_session_id';
const SESSION_AUTH_TOKEN_KEY_PREFIX = 'wabi_auth_token:';
const SESSION_GUEST_SESSION_ID_KEY_PREFIX = 'wabi_guest_session_id:';
const STORED_USERNAME_KEY_PREFIX = 'wabi_username:';
const STORED_DB_USER_ID_KEY_PREFIX = 'wabi_db_user_id:';

const hydratedServerScopes = new Set<string>();

function normalizeSecret(value: string | null | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function resolveServerScope(serverUrl?: string | null): string {
	const normalized = normalizeServerUrl(serverUrl || '');
	if (normalized) return normalized;
	if (!browser) return 'ssr_default';
	return normalizeServerUrl(resolveServerUrl().url) || 'browser_default';
}

function scopedKey(prefix: string, serverScope: string): string {
	return `${prefix}${encodeURIComponent(serverScope)}`;
}

function safeSessionGet(key: string): string | null {
	try {
		return sessionStorage.getItem(key);
	} catch {
		return null;
	}
}

function safeSessionSet(key: string, value: string | null): void {
	try {
		if (value) {
			sessionStorage.setItem(key, value);
		} else {
			sessionStorage.removeItem(key);
		}
	} catch {
		// Ignore storage failures.
	}
}

function safeLocalGet(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function safeLocalSet(key: string, value: string | null): void {
	try {
		if (value) {
			localStorage.setItem(key, value);
		} else {
			localStorage.removeItem(key);
		}
	} catch {
		// Ignore storage failures.
	}
}

function hydrateLegacyAuthSecrets(serverUrl?: string | null): void {
	if (!browser) return;
	const serverScope = resolveServerScope(serverUrl);
	if (hydratedServerScopes.has(serverScope)) return;
	hydratedServerScopes.add(serverScope);

	const scopedAuthTokenKey = scopedKey(SESSION_AUTH_TOKEN_KEY_PREFIX, serverScope);
	const scopedGuestSessionKey = scopedKey(SESSION_GUEST_SESSION_ID_KEY_PREFIX, serverScope);
	const scopedUsernameKey = scopedKey(STORED_USERNAME_KEY_PREFIX, serverScope);
	const scopedDbUserIdKey = scopedKey(STORED_DB_USER_ID_KEY_PREFIX, serverScope);
	try {
		const authToken =
			normalizeSecret(safeSessionGet(scopedAuthTokenKey)) ||
			normalizeSecret(safeSessionGet(LEGACY_SCOPED_SESSION_AUTH_TOKEN_KEY)) ||
			normalizeSecret(safeLocalGet(LEGACY_AUTH_TOKEN_KEY));
		const guestSessionId =
			normalizeSecret(safeSessionGet(scopedGuestSessionKey)) ||
			normalizeSecret(safeSessionGet(LEGACY_SCOPED_SESSION_GUEST_SESSION_ID_KEY)) ||
			normalizeSecret(safeLocalGet(LEGACY_SESSION_ID_KEY));
		const username =
			normalizeSecret(safeLocalGet(scopedUsernameKey)) ||
			normalizeSecret(safeLocalGet(LEGACY_USERNAME_KEY));
		const dbUserId = normalizeSecret(safeLocalGet(scopedDbUserIdKey)) || normalizeSecret(safeLocalGet(LEGACY_DB_USER_ID_KEY));

		safeSessionSet(scopedAuthTokenKey, authToken);
		safeSessionSet(scopedGuestSessionKey, guestSessionId);
		safeLocalSet(scopedUsernameKey, username);
		safeLocalSet(scopedDbUserIdKey, dbUserId);
	} catch {
		// Ignore storage failures.
	} finally {
		try {
			sessionStorage.removeItem(LEGACY_SCOPED_SESSION_AUTH_TOKEN_KEY);
			sessionStorage.removeItem(LEGACY_SCOPED_SESSION_GUEST_SESSION_ID_KEY);
			localStorage.removeItem(LEGACY_AUTH_TOKEN_KEY);
			localStorage.removeItem(LEGACY_SESSION_ID_KEY);
			localStorage.removeItem(LEGACY_USERNAME_KEY);
			localStorage.removeItem(LEGACY_DB_USER_ID_KEY);
		} catch {
			// Ignore storage failures.
		}
	}
}

export function getAuthToken(serverUrl?: string | null): string | null {
	hydrateLegacyAuthSecrets(serverUrl);
	if (!browser) return null;
	return normalizeSecret(safeSessionGet(scopedKey(SESSION_AUTH_TOKEN_KEY_PREFIX, resolveServerScope(serverUrl))));
}

export function setAuthToken(token: string | null | undefined, serverUrl?: string | null): void {
	if (!browser) return;
	const normalized = normalizeSecret(token);
	safeSessionSet(scopedKey(SESSION_AUTH_TOKEN_KEY_PREFIX, resolveServerScope(serverUrl)), normalized);
	safeLocalSet(LEGACY_AUTH_TOKEN_KEY, null);
}

export function clearAuthToken(serverUrl?: string | null): void {
	setAuthToken(null, serverUrl);
}

export function getGuestSessionId(serverUrl?: string | null): string | null {
	hydrateLegacyAuthSecrets(serverUrl);
	if (!browser) return null;
	return normalizeSecret(safeSessionGet(scopedKey(SESSION_GUEST_SESSION_ID_KEY_PREFIX, resolveServerScope(serverUrl))));
}

export function setGuestSessionId(sessionId: string | null | undefined, serverUrl?: string | null): void {
	if (!browser) return;
	const normalized = normalizeSecret(sessionId);
	safeSessionSet(scopedKey(SESSION_GUEST_SESSION_ID_KEY_PREFIX, resolveServerScope(serverUrl)), normalized);
	safeLocalSet(LEGACY_SESSION_ID_KEY, null);
}

export function clearGuestSessionId(serverUrl?: string | null): void {
	setGuestSessionId(null, serverUrl);
}

export function getStoredUsername(serverUrl?: string | null): string | null {
	hydrateLegacyAuthSecrets(serverUrl);
	if (!browser) return null;
	return normalizeSecret(safeLocalGet(scopedKey(STORED_USERNAME_KEY_PREFIX, resolveServerScope(serverUrl))));
}

export function setStoredUsername(username: string | null | undefined, serverUrl?: string | null): void {
	if (!browser) return;
	safeLocalSet(scopedKey(STORED_USERNAME_KEY_PREFIX, resolveServerScope(serverUrl)), normalizeSecret(username));
}

export function clearStoredUsername(serverUrl?: string | null): void {
	setStoredUsername(null, serverUrl);
}

export function getStoredDbUserId(serverUrl?: string | null): number | null {
	hydrateLegacyAuthSecrets(serverUrl);
	const raw = browser ? normalizeSecret(safeLocalGet(scopedKey(STORED_DB_USER_ID_KEY_PREFIX, resolveServerScope(serverUrl)))) : null;
	if (!raw) return null;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function setStoredDbUserId(dbUserId: number | string | null | undefined, serverUrl?: string | null): void {
	if (!browser) return;
	const normalized = typeof dbUserId === 'number' ? String(dbUserId) : normalizeSecret(dbUserId);
	safeLocalSet(scopedKey(STORED_DB_USER_ID_KEY_PREFIX, resolveServerScope(serverUrl)), normalized);
}

export function clearStoredDbUserId(serverUrl?: string | null): void {
	setStoredDbUserId(null, serverUrl);
}

export function clearStoredIdentity(serverUrl?: string | null): void {
	clearStoredUsername(serverUrl);
	clearStoredDbUserId(serverUrl);
}

export function clearAuthSession(serverUrl?: string | null): void {
	clearAuthToken(serverUrl);
	clearGuestSessionId(serverUrl);
}
