import { browser } from '$app/environment';

const LEGACY_AUTH_TOKEN_KEY = 'authToken';
const LEGACY_SESSION_ID_KEY = 'sessionId';
const SESSION_AUTH_TOKEN_KEY = 'wabi_auth_token';
const SESSION_GUEST_SESSION_ID_KEY = 'wabi_guest_session_id';

let authToken: string | null = null;
let guestSessionId: string | null = null;
let hydratedLegacySecrets = false;

function normalizeSecret(value: string | null | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function hydrateLegacyAuthSecrets(): void {
	if (!browser || hydratedLegacySecrets) return;
	hydratedLegacySecrets = true;
	try {
		authToken = normalizeSecret(sessionStorage.getItem(SESSION_AUTH_TOKEN_KEY));
		guestSessionId = normalizeSecret(sessionStorage.getItem(SESSION_GUEST_SESSION_ID_KEY));

		if (!authToken) {
			authToken = normalizeSecret(localStorage.getItem(LEGACY_AUTH_TOKEN_KEY));
		}
		if (!guestSessionId) {
			guestSessionId = normalizeSecret(localStorage.getItem(LEGACY_SESSION_ID_KEY));
		}
	} catch {
		authToken = null;
		guestSessionId = null;
	} finally {
		try {
			if (authToken) {
				sessionStorage.setItem(SESSION_AUTH_TOKEN_KEY, authToken);
			} else {
				sessionStorage.removeItem(SESSION_AUTH_TOKEN_KEY);
			}
			if (guestSessionId) {
				sessionStorage.setItem(SESSION_GUEST_SESSION_ID_KEY, guestSessionId);
			} else {
				sessionStorage.removeItem(SESSION_GUEST_SESSION_ID_KEY);
			}
			localStorage.removeItem(LEGACY_AUTH_TOKEN_KEY);
			localStorage.removeItem(LEGACY_SESSION_ID_KEY);
		} catch {
			// Ignore storage failures.
		}
	}
}

export function getAuthToken(): string | null {
	hydrateLegacyAuthSecrets();
	return authToken;
}

export function setAuthToken(token: string | null | undefined): void {
	authToken = normalizeSecret(token);
	if (browser) {
		try {
			if (authToken) {
				sessionStorage.setItem(SESSION_AUTH_TOKEN_KEY, authToken);
			} else {
				sessionStorage.removeItem(SESSION_AUTH_TOKEN_KEY);
			}
			localStorage.removeItem(LEGACY_AUTH_TOKEN_KEY);
		} catch {
			// Ignore storage failures.
		}
	}
}

export function clearAuthToken(): void {
	setAuthToken(null);
}

export function getGuestSessionId(): string | null {
	hydrateLegacyAuthSecrets();
	return guestSessionId;
}

export function setGuestSessionId(sessionId: string | null | undefined): void {
	guestSessionId = normalizeSecret(sessionId);
	if (browser) {
		try {
			if (guestSessionId) {
				sessionStorage.setItem(SESSION_GUEST_SESSION_ID_KEY, guestSessionId);
			} else {
				sessionStorage.removeItem(SESSION_GUEST_SESSION_ID_KEY);
			}
			localStorage.removeItem(LEGACY_SESSION_ID_KEY);
		} catch {
			// Ignore storage failures.
		}
	}
}

export function clearGuestSessionId(): void {
	setGuestSessionId(null);
}

export function clearAuthSession(): void {
	clearAuthToken();
	clearGuestSessionId();
}
