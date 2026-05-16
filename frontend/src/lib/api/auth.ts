import type { Message } from '../socket-types';
import type { AuthResponse, FollowedChannelPollChannelResult as SharedFollowedChannelPollChannelResult, FollowedChannelPollRequest, FollowedChannelPollResponse as SharedFollowedChannelPollResponse, UserSettingsPayload, UserSettingsResponse } from '../../../../shared/userContracts';
import { authStore } from '../authStore';
import { getApiBase, getApiBaseFor, fetchWithTimeout, safeJsonParse } from './utils';

export type FollowedChannelPollChannelResult = SharedFollowedChannelPollChannelResult<Message>;
export type FollowedChannelPollResponse = SharedFollowedChannelPollResponse<Message>;

export async function register(username: string, password: string, handle?: string): Promise<AuthResponse> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/auth/register`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password, handle })
	});

	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Registration failed');
	}

	try {
		return await res.json();
	} catch {
		throw new Error('Invalid response from server during registration');
	}
}

export async function login(username: string, password: string): Promise<AuthResponse> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/auth/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password })
	});

	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Login failed');
	}

	try {
		return await res.json();
	} catch {
		throw new Error('Invalid response from server during login');
	}
}

export async function upgradeToRegistered(sessionId: string, password: string): Promise<AuthResponse> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/auth/upgrade`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ sessionId, password })
	});

	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Upgrade failed');
	}

	try {
		return await res.json();
	} catch {
		throw new Error('Invalid response from server during upgrade');
	}
}

export async function changePassword(
	token: string | null | undefined,
	currentPassword: string,
	newPassword: string
): Promise<void> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/auth/change-password`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ currentPassword, newPassword })
	});

	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Failed to change password');
	}
}

export async function adminResetUserPassword(
	token: string | null | undefined,
	targetUserId: number,
	newPassword: string,
	temporary = false
): Promise<void> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/admin/users/reset-password`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ targetUserId, newPassword, temporary })
	});

	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Failed to reset user password');
	}
}

export async function adminClearUserLoginLockout(token: string | null | undefined, targetUserId: number): Promise<void> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/admin/users/clear-login-lockout`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ targetUserId })
	});

	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || 'Failed to clear login lockout');
	}
}

export async function storeEncryptionKeys(
	token: string | null | undefined,
	publicKey: string,
	privateKeyEncrypted: string
): Promise<void> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/user/encryption-keys`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ publicKey, privateKeyEncrypted })
	});

	if (!res.ok && res.status !== 409) {
		const error = new Error(`Failed to store encryption keys (${res.status})`);
		(error as any).status = res.status;
		throw error;
	}
}

export async function getPublicKey(token: string | null | undefined, userId: number): Promise<string | null> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/users/${userId}/public-key`, {
		method: 'GET',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});

	if (!res.ok) {
		return null;
	}

	const data = await res.json();
	return data.publicKey || null;
}

export async function getUserSettings(token: string | null | undefined): Promise<UserSettingsResponse> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/user/settings`, {
		method: 'GET',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});

	if (!res.ok) {
		if (res.status === 401) {
			authStore.setAuthError('Your session has expired. Please log in again.', 'session_expired');
		}
		throw new Error('Failed to load settings');
	}

	try {
		return await res.json();
	} catch {
		throw new Error('Invalid response from server while loading settings');
	}
}

export async function pollFollowedChannelActivity(
	baseUrl: string,
	token: string | null | undefined,
	sessionId: string | null | undefined,
	channels: FollowedChannelPollRequest[]
): Promise<FollowedChannelPollResponse> {
	const res = await fetchWithTimeout(`${getApiBaseFor(baseUrl)}/api/following/poll`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(!token && sessionId ? { 'X-Session-Id': sessionId } : {}),
			'Content-Type': 'application/json'
		},
		credentials: 'omit',
		body: JSON.stringify({ channels }),
		timeoutMs: 10000
	});

	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		const error = new Error(
			typeof data.error === 'string' ? data.error : 'Failed to poll followed channel activity'
		) as Error & { status?: number };
		error.status = res.status;
		throw error;
	}

	return {
		success: Boolean(data.success),
		serverTime: typeof data.serverTime === 'number' ? data.serverTime : Date.now(),
		channels: Array.isArray(data.channels) ? (data.channels as FollowedChannelPollChannelResult[]) : []
	};
}

export async function saveUserSettings(token: string | null | undefined, settings: UserSettingsPayload): Promise<void> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/user/settings`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(settings)
	});

	if (!res.ok) {
		if (res.status === 401) {
			authStore.setAuthError('Your session has expired. Please log in again.', 'session_expired');
		}
		throw new Error('Failed to save settings');
	}
}
