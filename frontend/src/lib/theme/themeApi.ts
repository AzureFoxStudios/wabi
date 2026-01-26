/**
 * Theme API Client
 * Handles communication with backend theme endpoints
 */

import type { ThemePreferences } from '../../types/theme';

// Use relative URL so it works on both localhost and production
const API_BASE = import.meta.env.VITE_SOCKET_URL || (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');

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
		console.warn('[ThemeApi] No auth token found - cannot fetch from server');
		throw new Error('Not authenticated - no token');
	}

	console.log('[ThemeApi] Fetching theme preferences from', `${API_BASE}/api/user/theme`);
	console.log('[ThemeApi] Using auth token:', token.substring(0, 20) + '...');

	let response;
	try {
		response = await fetch(`${API_BASE}/api/user/theme`, {
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/json'
			}
		});
	} catch (networkError) {
		console.error('[ThemeApi] Network error:', networkError);
		throw new Error(`Network error: ${networkError instanceof Error ? networkError.message : 'Failed to reach server'}`);
	}

	console.log('[ThemeApi] Fetch response status:', response.status);

	if (!response.ok) {
		let errorText = '';
		try {
			errorText = await response.text();
		} catch (e) {
			errorText = 'Could not read error response';
		}

		console.error('[ThemeApi] Fetch failed with status', response.status, ':', errorText);

		if (response.status === 401) {
			throw new Error('Unauthorized - invalid or expired token');
		} else if (response.status === 404) {
			throw new Error('Theme endpoint not found on server');
		} else if (response.status >= 500) {
			throw new Error('Server error - theme service unavailable');
		}
		throw new Error(`Failed to fetch theme preferences (${response.status}): ${errorText}`);
	}

	let data;
	try {
		data = await response.json();
	} catch (parseError) {
		console.error('[ThemeApi] Failed to parse response JSON:', parseError);
		throw new Error('Server returned invalid JSON');
	}

	console.log('[ThemeApi] Successfully fetched preferences:', {
		theme_id: data.theme_id,
		uniform_font_enabled: data.uniform_font_enabled
	});

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
		throw new Error('Not authenticated - cannot save to server');
	}

	console.log('[ThemeApi] Saving theme preferences to', `${API_BASE}/api/user/theme`);
	console.log('[ThemeApi] Preferences to save:', prefs);

	let response;
	try {
		response = await fetch(`${API_BASE}/api/user/theme`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(prefs)
		});
	} catch (networkError) {
		console.error('[ThemeApi] Network error during save:', networkError);
		throw new Error(`Network error: ${networkError instanceof Error ? networkError.message : 'Failed to reach server'}`);
	}

	console.log('[ThemeApi] Save response status:', response.status);

	if (!response.ok) {
		let errorText = '';
		try {
			errorText = await response.text();
		} catch (e) {
			errorText = 'Could not read error response';
		}

		console.error('[ThemeApi] Save failed with status', response.status, ':', errorText);

		if (response.status === 401) {
			throw new Error('Unauthorized - invalid or expired token');
		} else if (response.status === 404) {
			throw new Error('Theme endpoint not found on server');
		} else if (response.status >= 500) {
			throw new Error('Server error - theme service unavailable');
		}

		// Try to parse JSON error response
		let errorData;
		try {
			errorData = JSON.parse(errorText);
		} catch (e) {
			errorData = { error: errorText };
		}

		throw new Error(errorData.error || `Failed to save theme preferences (${response.status})`);
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
