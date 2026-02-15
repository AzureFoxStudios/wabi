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

export interface PaginatedResponse<T> {
	items: T[];
	page: number;
	limit: number;
	total: number;
	hasMore: boolean;
}

export interface AdminChannelListItem {
	channel_id: string;
	channel_type: 'public' | 'dm' | 'group';
	name: string;
	description: string;
	created_at: number;
	created_by?: string;
	persist_messages: number;
	avatar?: string | null;
}

export interface AdminRoleListItem {
	role_name: string;
	workspace_id: string;
	priority: number;
	color: string | null;
	is_hoisted: number;
	assigned_users: number;
}

export async function getAdminChannels(token: string, page = 1, limit = 50): Promise<PaginatedResponse<AdminChannelListItem>> {
	const res = await fetch(`${SERVER_URL}/api/admin/channels?page=${page}&limit=${limit}`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});

	if (!res.ok) {
		throw new Error('Failed to load admin channels');
	}

	return res.json();
}

export async function getAdminRoles(token: string, page = 1, limit = 50): Promise<PaginatedResponse<AdminRoleListItem>> {
	const res = await fetch(`${SERVER_URL}/api/admin/roles?page=${page}&limit=${limit}`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});

	if (!res.ok) {
		throw new Error('Failed to load admin roles');
	}

	return res.json();
}
