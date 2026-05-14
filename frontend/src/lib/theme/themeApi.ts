/**
 * Theme API Client
 * Handles communication with backend theme endpoints
 */

import type { ThemePreferences } from '../../types/theme';
import { getServerUrl } from '../serverUrl';
import { authStore } from '../authStore';
import { getAuthToken } from '../authSession';

const THEME_API_TIMEOUT_MS = 15000;
const THEME_API_RETRY_DELAY_MS = 250;

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch theme preferences from server
 */
export async function fetchThemePreferences(): Promise<ThemePreferences> {
	const token = getAuthToken();

	let response;
	let lastError: unknown = null;
	for (let attempt = 1; attempt <= 2; attempt++) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), THEME_API_TIMEOUT_MS);
		try {
			response = await fetch(`${getServerUrl()}/api/user/theme`, {
				method: 'GET',
				headers: {
					...(token ? { 'Authorization': `Bearer ${token}` } : {}),
					'Content-Type': 'application/json'
				},
				credentials: 'include',
				signal: controller.signal
			});
			break;
		} catch (networkError) {
			lastError = networkError;
			if (attempt < 2 && isAbortError(networkError)) {
				await sleep(THEME_API_RETRY_DELAY_MS);
				continue;
			}
			console.error('[ThemeApi] Network error:', networkError);
			throw new Error(
				`Network error: ${isAbortError(networkError) ? `request timed out after ${THEME_API_TIMEOUT_MS}ms` : networkError instanceof Error ? networkError.message : 'Failed to reach server'}`
			);
		} finally {
			clearTimeout(timeout);
		}
	}

	if (!response) {
		throw new Error(
			`Network error: ${isAbortError(lastError) ? `request timed out after ${THEME_API_TIMEOUT_MS}ms` : 'Failed to reach server'}`
		);
	}

	if (!response.ok) {
		let errorText = '';
		try {
			errorText = await response.text();
		} catch (e) {
			errorText = 'Could not read error response';
		}

		console.error('[ThemeApi] Fetch failed with status', response.status, ':', errorText);

		if (response.status === 401) {
			authStore.setAuthError('Your session has expired. Please log in again.', 'session_expired');
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

	let response;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), THEME_API_TIMEOUT_MS);
	try {
		response = await fetch(`${getServerUrl()}/api/user/theme`, {
			method: 'POST',
			headers: {
				...(token ? { 'Authorization': `Bearer ${token}` } : {}),
				'Content-Type': 'application/json'
			},
			credentials: 'include',
			body: JSON.stringify(prefs),
			signal: controller.signal
		});
	} catch (networkError) {
		console.error('[ThemeApi] Network error during save:', networkError);
		throw new Error(
			`Network error: ${isAbortError(networkError) ? `request timed out after ${THEME_API_TIMEOUT_MS}ms` : networkError instanceof Error ? networkError.message : 'Failed to reach server'}`
		);
	} finally {
		clearTimeout(timeout);
	}

	if (!response.ok) {
		let errorText = '';
		try {
			errorText = await response.text();
		} catch (e) {
			errorText = 'Could not read error response';
		}

		console.error('[ThemeApi] Save failed with status', response.status, ':', errorText);

		if (response.status === 401) {
			authStore.setAuthError('Your session has expired. Please log in again.', 'session_expired');
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
}

/**
 * Reset theme preferences to default
 */
export async function resetThemePreferences(): Promise<void> {
	const token = getAuthToken();

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), THEME_API_TIMEOUT_MS);
	let response;
	try {
		response = await fetch(`${getServerUrl()}/api/user/theme/reset`, {
			method: 'POST',
			headers: {
				...(token ? { 'Authorization': `Bearer ${token}` } : {}),
				'Content-Type': 'application/json'
			},
			credentials: 'include',
			signal: controller.signal
		});
	} finally {
		clearTimeout(timeout);
	}

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
