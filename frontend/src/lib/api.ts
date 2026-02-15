import { getServerUrl } from './serverUrl';
import { authStore } from './authStore';

const SERVER_URL = getServerUrl();

export interface AuthResponse {
	token: string;
	notice?: string;
	user: {
		id: number;
		username: string;
		handle?: string;
		color: string;
		profilePicture?: string;
		isRegistered: boolean;
	};
}

export interface BanAppeal {
	id: number;
	user_id: number;
	status: 'pending' | 'approved' | 'denied';
	message: string;
	created_at: number;
	reviewed_by?: number | null;
	reviewed_at?: number | null;
	decision_note?: string | null;
	user?: {
		user_id: number;
		username: string;
		handle?: string;
	} | null;
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

export async function submitBanAppeal(username: string, password: string, message: string): Promise<{ success: boolean; appeal: BanAppeal }> {
	const res = await fetch(`${SERVER_URL}/api/ban-appeals/submit`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password, message })
	});

	if (!res.ok) {
		const error = await res.json();
		throw new Error(error.error || 'Failed to submit appeal');
	}

	return res.json();
}

export async function getPendingBanAppeals(token: string): Promise<BanAppeal[]> {
	const res = await fetch(`${SERVER_URL}/api/ban-appeals`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});

	if (!res.ok) {
		const error = await res.json();
		throw new Error(error.error || 'Failed to load ban appeals');
	}

	const data = await res.json();
	return data.appeals || [];
}

export async function reviewBanAppeal(
	token: string,
	payload: { appealId: number; decision: 'approved' | 'denied'; decisionNote?: string; cooldownSeconds?: number }
): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/ban-appeals/review`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(payload)
	});

	if (!res.ok) {
		const error = await res.json();
		throw new Error(error.error || 'Failed to review appeal');
	}
}
