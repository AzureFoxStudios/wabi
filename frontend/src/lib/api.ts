import { getServerUrl } from './serverUrl';
import { authStore } from './authStore';

const SERVER_URL = getServerUrl();

export interface AuthResponse {
	token: string;
	user: {
		id: number;
		username: string;
		color: string;
		profilePicture?: string;
		isRegistered: boolean;
	};
}

export async function register(username: string, password: string): Promise<AuthResponse> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8000);
	try {
		const res = await fetch(`${SERVER_URL}/api/auth/register`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username, password }),
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
