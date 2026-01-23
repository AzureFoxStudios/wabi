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
	return localStorage.getItem('authToken');
}

/**
 * Fetch theme preferences from server
 */
export async function fetchThemePreferences(): Promise<ThemePreferences> {
	const token = getAuthToken();
	if (!token) {
		console.warn('[ThemeApi] No auth token found');
		throw new Error('Not authenticated');
	}

	console.log('[ThemeApi] Fetching theme preferences from', `${API_BASE}/api/user/theme`);
	const response = await fetch(`${API_BASE}/api/user/theme`, {
		method: 'GET',
		headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json'
		}
	});

	console.log('[ThemeApi] Fetch response status:', response.status);
	if (!response.ok) {
		const errorText = await response.text();
		console.error('[ThemeApi] Fetch failed:', errorText);
		if (response.status === 401) {
			throw new Error('Unauthorized');
		}
		throw new Error('Failed to fetch theme preferences');
	}

	const data = await response.json();
	return {
		theme_id: data.theme_id,
		custom_theme: data.custom_theme,
		uniform_font_enabled: data.uniform_font_enabled,
		uniform_font_family: data.uniform_font_family,
		uniform_font_size: data.uniform_font_size,
		uniform_font_weight: data.uniform_font_weight,
		uniform_font_style: data.uniform_font_style,
		updated_at: data.updated_at
	};
}

/**
 * Save theme preferences to server
 */
export async function saveThemePreferences(prefs: Partial<ThemePreferences>): Promise<void> {
	const token = getAuthToken();
	if (!token) {
		console.warn('[ThemeApi] No auth token found for save');
		throw new Error('Not authenticated');
	}

	console.log('[ThemeApi] Saving theme preferences to', `${API_BASE}/api/user/theme`, prefs);
	const response = await fetch(`${API_BASE}/api/user/theme`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(prefs)
	});

	console.log('[ThemeApi] Save response status:', response.status);
	if (!response.ok) {
		const errorText = await response.text();
		console.error('[ThemeApi] Save failed:', errorText);
		if (response.status === 401) {
			throw new Error('Unauthorized');
		}
		const errorData = await response.json().catch(() => ({ error: errorText }));
		throw new Error(errorData.error || 'Failed to save theme preferences');
	}
	console.log('[ThemeApi] Save successful');
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

/**
 * Theme API object for convenience imports
 */
export const themeApi = {
	fetchThemePreferences,
	saveThemePreferences,
	resetThemePreferences
};
