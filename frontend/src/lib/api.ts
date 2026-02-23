import { getServerUrl } from './serverUrl';
import { authStore } from './authStore';

const SERVER_URL = getServerUrl();

/** Default timeout for all API requests (ms). */
const API_TIMEOUT_MS = 8000;

/**
 * Wraps `fetch` with an AbortController timeout.
 * All API calls in this module go through here so the timeout is
 * defined in exactly one place.
 */
async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
	try {
		return await fetch(url, { ...options, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

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
	const res = await fetchWithTimeout(`${SERVER_URL}/api/auth/register`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password, handle })
	});

	if (!res.ok) {
		const error = await res.json();
		throw new Error(error.error || 'Registration failed');
	}

	return res.json();
}

export async function login(username: string, password: string): Promise<AuthResponse> {
	const res = await fetchWithTimeout(`${SERVER_URL}/api/auth/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password })
	});

	if (!res.ok) {
		const error = await res.json();
		throw new Error(error.error || 'Login failed');
	}

	return res.json();
}

export async function upgradeToRegistered(sessionId: string, password: string): Promise<AuthResponse> {
	const res = await fetchWithTimeout(`${SERVER_URL}/api/auth/upgrade`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ sessionId, password })
	});

	if (!res.ok) {
		const error = await res.json();
		throw new Error(error.error || 'Upgrade failed');
	}

	return res.json();
}

export async function storeEncryptionKeys(token: string, publicKey: string, privateKeyEncrypted: string): Promise<void> {
	const res = await fetchWithTimeout(`${SERVER_URL}/api/user/encryption-keys`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ publicKey, privateKeyEncrypted })
	});

	if (!res.ok && res.status !== 409) {
		// Include HTTP status in error for proper session validation
		const error = new Error(`Failed to store encryption keys (${res.status})`);
		(error as any).status = res.status;
		throw error;
	}
}

export async function getPublicKey(token: string, userId: number): Promise<string | null> {
	const res = await fetchWithTimeout(`${SERVER_URL}/api/users/${userId}/public-key`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});

	if (!res.ok) {
		return null;
	}

	const data = await res.json();
	return data.publicKey || null;
}

export async function getUserSettings(token: string): Promise<any> {
	const res = await fetchWithTimeout(`${SERVER_URL}/api/user/settings`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});

	if (!res.ok) {
		if (res.status === 401) {
			authStore.setAuthError('Your session has expired. Please log in again.', 'session_expired');
		}
		throw new Error('Failed to load settings');
	}

	return res.json();
}

export async function saveUserSettings(
	token: string,
	settings: {
		offline_message_retention?: string;
		allow_temp_user_messages?: boolean;
	}
): Promise<void> {
	const res = await fetchWithTimeout(`${SERVER_URL}/api/user/settings`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
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

export type UploadRoleTier = 'new' | 'trusted' | 'moderator' | 'admin' | 'owner';

export interface UploadLimitConfig {
	perRoleBytes: Record<UploadRoleTier, number | null>;
	globalUploadCapBytes: number | null;
}

export interface DownloadLimitConfig {
	perRoleBytes: Record<UploadRoleTier, number | null>;
	globalDownloadCapBytes: number | null;
}

export type AdminPolicyKey = 'upload_limits' | 'download_limits';

export interface AdminCompressionConfig {
	httpTextCompression: {
		enabled: boolean;
		minBytes: number;
		brotliQuality: number;
		gzipLevel: number;
	};
	uploadCompression: {
		enabled: boolean;
		minBytes: number;
		gzipLevel: number;
	};
}

export interface AdminCompressionMetrics {
	counters: {
		uploadCount: number;
		downloadCount: number;
		uploadOriginalBytes: number;
		uploadStoredBytes: number;
		downloadStoredBytes: number;
		downloadResponseBytes: number;
		uploadStoredToOriginalRatio: number | null;
		downloadResponseToStoredRatio: number | null;
	};
	summaryByExt: {
		uploads: Array<{
			fileExt: string;
			count: number;
			originalBytes: number;
			storedBytes: number;
			responseBytes: number;
		}>;
		downloads: Array<{
			fileExt: string;
			count: number;
			originalBytes: number;
			storedBytes: number;
			responseBytes: number;
		}>;
	};
	recentSamples: {
		uploads: Array<Record<string, unknown>>;
		downloads: Array<Record<string, unknown>>;
	};
}

export async function getAdminPolicy<T>(token: string, key: AdminPolicyKey): Promise<{
	key: AdminPolicyKey;
	config: T;
	defaults: T;
}> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8000);
	try {
		const res = await fetch(`${SERVER_URL}/api/admin/policies/${encodeURIComponent(key)}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${token}` },
			signal: controller.signal
		});
		if (!res.ok) {
			const error = await res.json().catch(() => ({}));
			throw new Error(error.error || `Failed to load policy: ${key}`);
		}
		return res.json();
	} finally {
		clearTimeout(timeout);
	}
}

export async function saveAdminPolicy<T>(token: string, key: AdminPolicyKey, config: T): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8000);
	try {
		const res = await fetch(`${SERVER_URL}/api/admin/policies/${encodeURIComponent(key)}`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(config),
			signal: controller.signal
		});
		if (!res.ok) {
			const error = await res.json().catch(() => ({}));
			throw new Error(error.error || `Failed to save policy: ${key}`);
		}
		const data = await res.json();
		return data.config;
	} finally {
		clearTimeout(timeout);
	}
}

export async function getAdminUploadLimits(token: string): Promise<{
	config: UploadLimitConfig;
	defaults: UploadLimitConfig;
}> {
	const data = await getAdminPolicy<UploadLimitConfig>(token, 'upload_limits');
	return { config: data.config, defaults: data.defaults };
}

export async function saveAdminUploadLimits(token: string, config: UploadLimitConfig): Promise<UploadLimitConfig> {
	return saveAdminPolicy<UploadLimitConfig>(token, 'upload_limits', config);
}

export async function getAdminCompressionConfig(token: string): Promise<AdminCompressionConfig> {
	const res = await fetchWithTimeout(`${SERVER_URL}/api/admin/compression-config`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to load compression config');
	}
	const data = await res.json();
	return data.config as AdminCompressionConfig;
}

export async function getAdminCompressionMetrics(token: string): Promise<AdminCompressionMetrics> {
	const res = await fetchWithTimeout(`${SERVER_URL}/api/admin/compression-metrics`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to load compression metrics');
	}
	const data = await res.json();
	return data.metrics as AdminCompressionMetrics;
}

export async function resetAdminCompressionMetrics(token: string): Promise<void> {
	const res = await fetchWithTimeout(`${SERVER_URL}/api/admin/compression-metrics/reset`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || 'Failed to reset compression metrics');
	}
}
