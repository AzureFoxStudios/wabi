import { getServerUrl } from './serverUrl';
import { authStore } from './authStore';

const SERVER_URL = getServerUrl();

export interface AuthResponse {
	token: string;
	user: {
		id: number;
		username: string;
		handle?: string;
		color: string;
		profilePicture?: string;
		isRegistered: boolean;
	};
}

export async function register(username: string, password: string, handle?: string): Promise<AuthResponse> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8000);
	try {
		const res = await fetch(`${SERVER_URL}/api/auth/register`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username, password, handle }),
			signal: controller.signal
		});

		if (!res.ok) {
			const error = await res.json();
			throw new Error(error.error || 'Registration failed');
		}

		return res.json();
	} finally {
		clearTimeout(timeout);
	}
}

export async function login(username: string, password: string): Promise<AuthResponse> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8000);
	try {
		const res = await fetch(`${SERVER_URL}/api/auth/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username, password }),
			signal: controller.signal
		});

		if (!res.ok) {
			const error = await res.json();
			throw new Error(error.error || 'Login failed');
		}

		return res.json();
	} finally {
		clearTimeout(timeout);
	}
}

export async function upgradeToRegistered(sessionId: string, password: string): Promise<AuthResponse> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8000);
	try {
		const res = await fetch(`${SERVER_URL}/api/auth/upgrade`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sessionId, password }),
			signal: controller.signal
		});

		if (!res.ok) {
			const error = await res.json();
			throw new Error(error.error || 'Upgrade failed');
		}

		return res.json();
	} finally {
		clearTimeout(timeout);
	}
}

export async function storeEncryptionKeys(token: string, publicKey: string, privateKeyEncrypted: string): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8000);
	try {
		const res = await fetch(`${SERVER_URL}/api/user/encryption-keys`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ publicKey, privateKeyEncrypted }),
			signal: controller.signal
		});

		if (!res.ok && res.status !== 409) {
			// Include HTTP status in error for proper session validation
			const error = new Error(`Failed to store encryption keys (${res.status})`);
			(error as any).status = res.status;
			throw error;
		}
	} finally {
		clearTimeout(timeout);
	}
}

export async function getPublicKey(token: string, userId: number): Promise<string | null> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8000);
	try {
		const res = await fetch(`${SERVER_URL}/api/users/${userId}/public-key`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${token}` },
			signal: controller.signal
		});

		if (!res.ok) {
			return null;
		}

		const data = await res.json();
		return data.publicKey || null;
	} finally {
		clearTimeout(timeout);
	}
}

export async function getUserSettings(token: string): Promise<any> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8000);
	try {
		const res = await fetch(`${SERVER_URL}/api/user/settings`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${token}` },
			signal: controller.signal
		});

		if (!res.ok) {
			if (res.status === 401) {
				authStore.setAuthError('Your session has expired. Please log in again.', 'session_expired');
			}
			throw new Error('Failed to load settings');
		}

		return res.json();
	} finally {
		clearTimeout(timeout);
	}
}

export async function saveUserSettings(
	token: string,
	settings: {
		offline_message_retention?: string;
		allow_temp_user_messages?: boolean;
	}
): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8000);
	try {
		const res = await fetch(`${SERVER_URL}/api/user/settings`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(settings),
			signal: controller.signal
		});

		if (!res.ok) {
			if (res.status === 401) {
				authStore.setAuthError('Your session has expired. Please log in again.', 'session_expired');
			}
			throw new Error('Failed to save settings');
		}
	} finally {
		clearTimeout(timeout);
	}
}


export interface ServerModerationSettings {
	registrationOpen: boolean;
	raidModeEnabled: boolean;
	raidModeExpiresAt: number | null;
}

export async function getServerModerationSettings(token: string): Promise<ServerModerationSettings> {
	const res = await fetch(`${SERVER_URL}/api/server-settings`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to load server settings');
	}
	const data = await res.json();
	return {
		registrationOpen: !!data.registrationOpen,
		raidModeEnabled: !!data.raidModeEnabled,
		raidModeExpiresAt: data.raidModeExpiresAt ?? null
	};
}

export async function saveServerModerationSettings(token: string, updates: Partial<ServerModerationSettings>): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/server-settings`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(updates)
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to save server settings');
	}
}

export async function getBlockedUsernames(token: string): Promise<Array<{ value: string; reason?: string }>> {
	const res = await fetch(`${SERVER_URL}/api/blocked-usernames`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to load blocked usernames');
	}
	const data = await res.json();
	return (data.items || []).map((item: any) => ({ value: item.value, reason: item.reason }));
}

export async function addBlockedUsername(token: string, value: string, reason?: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/blocked-usernames`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ value, reason })
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to add blocked username');
	}
}

export async function removeBlockedUsername(token: string, value: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/blocked-usernames?value=${encodeURIComponent(value)}`, {
		method: 'DELETE',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to remove blocked username');
	}
}

export async function getModerationTriggers(token: string): Promise<any[]> {
	const res = await fetch(`${SERVER_URL}/api/moderation-triggers`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to load moderation triggers');
	}
	const data = await res.json();
	return data.items || [];
}

export async function addModerationTrigger(token: string, trigger: { phrase: string; action: 'timeout' | 'ban'; duration_minutes?: number; severity?: 'low' | 'medium' | 'high' }): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/moderation-triggers`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(trigger)
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to add moderation trigger');
	}
}
