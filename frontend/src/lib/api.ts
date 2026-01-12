import { browser } from '$app/environment';

let SERVER_URL = 'http://localhost:3000';

if (browser) {
	if (window.location.origin.includes(':5173') || window.location.origin.includes('tauri.localhost')) {
		SERVER_URL = 'http://localhost:3000';
	} else if (window.location.origin.includes(':3000')) {
		SERVER_URL = window.location.origin.replace(':3000', ':8080');
	} else {
		SERVER_URL = window.location.origin;
	}
}

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
	const res = await fetch(`${SERVER_URL}/api/auth/register`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password })
	});

	if (!res.ok) {
		const error = await res.json();
		throw new Error(error.error || 'Registration failed');
	}

	return res.json();
}

export async function login(username: string, password: string): Promise<AuthResponse> {
	const res = await fetch(`${SERVER_URL}/api/auth/login`, {
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
	const res = await fetch(`${SERVER_URL}/api/auth/upgrade`, {
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

export async function getUserSettings(token: string): Promise<any> {
	const res = await fetch(`${SERVER_URL}/api/user/settings`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});

	if (!res.ok) {
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
	const res = await fetch(`${SERVER_URL}/api/user/settings`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(settings)
	});

	if (!res.ok) {
		throw new Error('Failed to save settings');
	}
}
