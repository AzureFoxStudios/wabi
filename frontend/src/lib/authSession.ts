import { normalizeServerUrl, resolveServerUrl } from './serverUrl';
import { clearRefreshToken } from './api/authRefresh';

// This module is imported transitively by bun:test suites, so keep it free of
// SvelteKit virtual-module imports. Runtime detection below uses only browser
// globals and dynamically imports native helpers when needed.
const browser: boolean = typeof window !== 'undefined' && typeof document !== 'undefined';

const LEGACY_AUTH_TOKEN_KEY = 'authToken';
const LEGACY_SESSION_ID_KEY = 'sessionId';
const LEGACY_USERNAME_KEY = 'username';
const LEGACY_DB_USER_ID_KEY = 'dbUserId';
const LEGACY_SCOPED_SESSION_AUTH_TOKEN_KEY = 'wabi_auth_token';
const LEGACY_SCOPED_SESSION_GUEST_SESSION_ID_KEY = 'wabi_guest_session_id';
const SESSION_AUTH_TOKEN_KEY_PREFIX = 'wabi_auth_token:';
const SESSION_GUEST_SESSION_ID_KEY_PREFIX = 'wabi_guest_session_id:';
const PERSISTED_AUTH_TOKEN_KEY_PREFIX = 'wabi_persisted_auth_token:';
const STORED_USERNAME_KEY_PREFIX = 'wabi_username:';
const STORED_DB_USER_ID_KEY_PREFIX = 'wabi_db_user_id:';

const hydratedServerScopes = new Set<string>();
const sessionClearListeners = new Set<(server: string) => void>();
const sessionGenerations = new Map<string, number>();

/** Distinguish logout/re-login to the same account from the previous session. */
export function authSessionGeneration(serverUrl?: string | null): number {
	return sessionGenerations.get(resolveServerScope(serverUrl)) ?? 0;
}

/** Explicit session boundaries also retire memory owned by unmounted surfaces. */
export function onAuthSessionCleared(listener: (server: string) => void): () => void {
	sessionClearListeners.add(listener);
	return () => { sessionClearListeners.delete(listener); };
}

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

function isTauriLikeRuntime(): boolean {
	if (!browser) return false;
	const runtime = window as Window & {
		__TAURI__?: unknown;
		__TAURI_CORE__?: unknown;
		__TAURI_INTERNALS__?: unknown;
	};
	if (runtime.__TAURI__ || runtime.__TAURI_CORE__ || runtime.__TAURI_INTERNALS__) return true;
	const { protocol, hostname } = window.location;
	if (protocol === 'tauri:' || protocol === 'asset:' || hostname === 'tauri.localhost') return true;
	return typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('tauri');
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
		if (value) sessionStorage.setItem(key, value);
		else sessionStorage.removeItem(key);
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
		if (value) localStorage.setItem(key, value);
		else localStorage.removeItem(key);
	} catch {
		// Ignore storage failures.
	}
}

function persistentTokenKey(serverUrl?: string | null): string {
	return scopedKey(PERSISTED_AUTH_TOKEN_KEY_PREFIX, resolveServerScope(serverUrl));
}

/** Native bootstrap uses this only to migrate old plaintext remember-me state. */
export function getPlaintextPersistentAuthTokenForMigration(serverUrl?: string | null): string | null {
	if (!browser) return null;
	return normalizeSecret(safeLocalGet(persistentTokenKey(serverUrl)));
}

/** Remove a migrated plaintext remember-me token after native persistence succeeds. */
export function clearPlaintextPersistentAuthTokenForMigration(serverUrl?: string | null): void {
	if (!browser) return;
	safeLocalSet(persistentTokenKey(serverUrl), null);
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
	const scope = resolveServerScope(serverUrl);
	const sessionToken = normalizeSecret(safeSessionGet(scopedKey(SESSION_AUTH_TOKEN_KEY_PREFIX, scope)));
	if (sessionToken) return sessionToken;

	// Browser/PWA remember-me remains web storage. Installed Tauri clients are
	// hydrated from the OS credential store by hooks.client.ts before page
	// hydration. The localStorage read here exists only for migration from older
	// installed builds and normal web clients.
	const persistedToken = normalizeSecret(safeLocalGet(scopedKey(PERSISTED_AUTH_TOKEN_KEY_PREFIX, scope)));
	if (persistedToken) {
		safeSessionSet(scopedKey(SESSION_AUTH_TOKEN_KEY_PREFIX, scope), persistedToken);
		return persistedToken;
	}
	return null;
}

export function setAuthToken(token: string | null | undefined, serverUrl?: string | null): void {
	if (!browser) return;
	const normalized = normalizeSecret(token);
	safeSessionSet(scopedKey(SESSION_AUTH_TOKEN_KEY_PREFIX, resolveServerScope(serverUrl)), normalized);
	safeLocalSet(LEGACY_AUTH_TOKEN_KEY, null);
}

export function setPersistentAuthToken(token: string | null | undefined, serverUrl?: string | null): void {
	if (!browser) return;
	const normalized = normalizeSecret(token);
	const scope = resolveServerScope(serverUrl);

	if (isTauriLikeRuntime()) {
		// Installed apps never create a new plaintext persistent auth token.
		// The native helper fails closed: if the OS credential store is missing,
		// remember-me simply will not survive process death.
		safeLocalSet(scopedKey(PERSISTED_AUTH_TOKEN_KEY_PREFIX, scope), null);
		void import('./nativeAuthPersistence')
			.then(({ persistNativeAuthToken }) => persistNativeAuthToken(normalized, scope))
			.catch((error) => console.warn('[auth] Native remember-me storage unavailable:', error));
		return;
	}

	safeLocalSet(scopedKey(PERSISTED_AUTH_TOKEN_KEY_PREFIX, scope), normalized);
}

export function clearAuthToken(serverUrl?: string | null): void {
	setAuthToken(null, serverUrl);
	if (browser) setPersistentAuthToken(null, serverUrl);
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
	clearRefreshToken(serverUrl);
	const server = resolveServerScope(serverUrl);
	sessionGenerations.set(server, authSessionGeneration(server) + 1);
	for (const listener of sessionClearListeners) {
		try { listener(server); }
		catch { console.error('Session memory cleanup failed'); }
	}
}

export function copyScopedAuthState(fromServerUrl: string, toServerUrl: string): void {
	if (!browser) return;
	const fromScope = resolveServerScope(fromServerUrl);
	const toScope = resolveServerScope(toServerUrl);
	if (fromScope === toScope) return;

	setAuthToken(getAuthToken(fromServerUrl), toServerUrl);
	setGuestSessionId(getGuestSessionId(fromServerUrl), toServerUrl);
	setStoredUsername(getStoredUsername(fromServerUrl), toServerUrl);
	setStoredDbUserId(getStoredDbUserId(fromServerUrl), toServerUrl);
}
