/**
 * Theme API Client
 * Handles communication with backend theme endpoints
 */

import type { ThemePreferences } from '../../types/theme';

const API_BASE = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3000';

/**
 * Get auth token from localStorage
 */
function getAuthToken(): string | null {
	return localStorage.getItem('token');
}

/**
 * Fetch theme preferences from server
 */
export async function fetchThemePreferences(): Promise<ThemePreferences> {
	const token = getAuthToken();
	if (!token) {
		throw new Error('Not authenticated');
	}

	const response = await fetch(`${API_BASE}/api/user/theme`, {
		method: 'GET',
		headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json'
		}
	});

	if (!response.ok) {
		if (response.status === 401) {
			throw new Error('Unauthorized');
		}
		throw new Error('Failed to fetch theme preferences');
	}

	const data = await response.json();
	return {
		theme_id: data.theme_id,
		custom_theme: data.custom_theme,
		updated_at: data.updated_at
	};
}

/**
 * Save theme preferences to server
 */
export async function saveThemePreferences(prefs: Partial<ThemePreferences>): Promise<void> {
	const token = getAuthToken();
	if (!token) {
		throw new Error('Not authenticated');
	}

	const response = await fetch(`${API_BASE}/api/user/theme`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(prefs)
	});

	if (!response.ok) {
		if (response.status === 401) {
			throw new Error('Unauthorized');
		}
		const errorData = await response.json().catch(() => ({}));
		throw new Error(errorData.error || 'Failed to save theme preferences');
	}
}

/**
 * Reset theme preferences to default
 */
export async function resetThemePreferences(): Promise<void> {
	const token = getAuthToken();
	if (!token) {
		throw new Error('Not authenticated');
	}

	const response = await fetch(`${API_BASE}/api/user/theme/reset`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json'
		}
	});

	if (!response.ok) {
		if (response.status === 401) {
			throw new Error('Unauthorized');
		}
		throw new Error('Failed to reset theme preferences');
	}
}
