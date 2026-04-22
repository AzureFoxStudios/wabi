import { IncomingMessage, ServerResponse } from 'http';
import {
	themeRepository,
	type CustomTheme,
	type ThemePreferences
} from '../db/repositories/themeRepository.js';
import { getAuthenticatedUserIdFromRequest } from '../auth/requestAuth.js';
import {
	isInvalidJsonBodyError as isInvalidJsonError,
	isRequestBodyTooLargeError as isPayloadTooLargeError,
	readJsonObjectBody
} from '../utils/requestBodies.js';

const MAX_THEME_BODY_BYTES = Math.max(
	1024,
	Math.min(256 * 1024, Number(process.env.THEME_MAX_BODY_BYTES || 32 * 1024))
);

const VALID_THEME_IDS = [
	'dark',
	'light',
	'midnight-blue',
	'vscode-high-contrast',
	'professional',
	'minimal',
	'custom',
	'slate-signal',
	'catppuccin-mocha',
	'dracula',
	'nord',
	'tokyo-night',
	'forest',
	'ember'
] as const;

type ThemePreferenceUpdate = Partial<Omit<ThemePreferences, 'user_id' | 'created_at' | 'updated_at'>>;
type ThemeRequestBody = Record<string, unknown>;

function writeJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(payload));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function parseBody(req: IncomingMessage): Promise<ThemeRequestBody> {
	return await readJsonObjectBody(req, MAX_THEME_BODY_BYTES);
}

function parseStoredCustomTheme(raw: string | null): CustomTheme | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		return isRecord(parsed) ? (parsed as CustomTheme) : null;
	} catch (error) {
		console.error('[Theme] Failed to parse custom theme:', error);
		return null;
	}
}

function normalizeBooleanFlag(value: unknown): 0 | 1 | null {
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'number') {
		if (value === 1) return 1;
		if (value === 0) return 0;
		return null;
	}
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase();
		if (['1', 'true', 'yes', 'on'].includes(normalized)) return 1;
		if (['0', 'false', 'no', 'off'].includes(normalized)) return 0;
	}
	return null;
}

function normalizeOptionalString(value: unknown, maxLength: number): string | null {
	if (typeof value !== 'string') return null;
	return value.trim().slice(0, maxLength);
}

function isValidCustomTheme(value: unknown): value is CustomTheme {
	if (!isRecord(value)) return false;
	if (value.colors !== undefined && !isRecord(value.colors)) return false;
	if (value.gradients !== undefined && !isRecord(value.gradients)) return false;
	return true;
}

function buildThemeSavePayload(body: ThemeRequestBody): ThemePreferenceUpdate | { error: string } {
	const prefsToSave: ThemePreferenceUpdate = {};

	if (Object.prototype.hasOwnProperty.call(body, 'theme_id')) {
		if (typeof body.theme_id !== 'string') {
			return { error: 'theme_id must be a string' };
		}
		const themeId = body.theme_id.trim();
		if (!themeId || !VALID_THEME_IDS.includes(themeId as (typeof VALID_THEME_IDS)[number])) {
			return {
				error: `Invalid theme ID. Valid values: ${VALID_THEME_IDS.join(', ')}`
			};
		}
		prefsToSave.theme_id = themeId;
	}

	if (Object.prototype.hasOwnProperty.call(body, 'custom_theme')) {
		const customTheme = body.custom_theme;
		if (customTheme !== null && !isValidCustomTheme(customTheme)) {
			return { error: 'Custom theme must be an object with object-valued colors/gradients when provided' };
		}
		prefsToSave.custom_theme = customTheme ? JSON.stringify(customTheme) : null;
	}

	if (Object.prototype.hasOwnProperty.call(body, 'uniform_font_enabled')) {
		const uniformFontEnabled = normalizeBooleanFlag(body.uniform_font_enabled);
		if (uniformFontEnabled == null) {
			return { error: 'uniform_font_enabled must be a boolean-like value' };
		}
		prefsToSave.uniform_font_enabled = uniformFontEnabled;
	}

	if (Object.prototype.hasOwnProperty.call(body, 'uniform_font_family')) {
		const value = normalizeOptionalString(body.uniform_font_family, 120);
		if (value == null) {
			return { error: 'uniform_font_family must be a string' };
		}
		prefsToSave.uniform_font_family = value;
	}

	if (Object.prototype.hasOwnProperty.call(body, 'uniform_font_size')) {
		const value = normalizeOptionalString(body.uniform_font_size, 40);
		if (value == null) {
			return { error: 'uniform_font_size must be a string' };
		}
		prefsToSave.uniform_font_size = value;
	}

	if (Object.prototype.hasOwnProperty.call(body, 'uniform_font_weight')) {
		const value = normalizeOptionalString(body.uniform_font_weight, 40);
		if (value == null) {
			return { error: 'uniform_font_weight must be a string' };
		}
		prefsToSave.uniform_font_weight = value;
	}

	if (Object.prototype.hasOwnProperty.call(body, 'uniform_font_style')) {
		const value = normalizeOptionalString(body.uniform_font_style, 40);
		if (value == null) {
			return { error: 'uniform_font_style must be a string' };
		}
		prefsToSave.uniform_font_style = value;
	}

	return prefsToSave;
}

export async function handleGetThemePreferences(
	req: IncomingMessage,
	res: ServerResponse
): Promise<void> {
	try {
		const userId = getAuthenticatedUserIdFromRequest(req);
		if (!userId) {
			writeJson(res, 401, { error: 'User not authenticated' });
			return;
		}

		const prefs = themeRepository.get(userId);
		writeJson(res, 200, {
			theme_id: prefs.theme_id,
			custom_theme: parseStoredCustomTheme(prefs.custom_theme),
			uniform_font_enabled: prefs.uniform_font_enabled,
			uniform_font_family: prefs.uniform_font_family,
			uniform_font_size: prefs.uniform_font_size,
			uniform_font_weight: prefs.uniform_font_weight,
			uniform_font_style: prefs.uniform_font_style,
			updated_at: prefs.updated_at
		});
	} catch (error) {
		console.error('[Theme] Get preferences error:', error);
		writeJson(res, 500, { error: 'Failed to load theme preferences' });
	}
}

export async function handleSaveThemePreferences(
	req: IncomingMessage,
	res: ServerResponse
): Promise<void> {
	try {
		const userId = getAuthenticatedUserIdFromRequest(req);
		if (!userId) {
			writeJson(res, 401, { error: 'User not authenticated' });
			return;
		}

		const body = await parseBody(req);
		const prefsToSave = buildThemeSavePayload(body);
		if ('error' in prefsToSave) {
			writeJson(res, 400, { error: prefsToSave.error });
			return;
		}

		themeRepository.set(userId, prefsToSave);
		const updated = themeRepository.get(userId);
		writeJson(res, 200, {
			success: true,
			theme_id: updated.theme_id,
			uniform_font_enabled: updated.uniform_font_enabled,
			uniform_font_family: updated.uniform_font_family,
			uniform_font_size: updated.uniform_font_size,
			uniform_font_weight: updated.uniform_font_weight,
			uniform_font_style: updated.uniform_font_style,
			updated_at: updated.updated_at
		});
	} catch (error) {
		if (isPayloadTooLargeError(error)) {
			writeJson(res, 413, { error: 'Theme payload too large' });
			return;
		}
		if (isInvalidJsonError(error)) {
			writeJson(res, 400, { error: 'Invalid JSON in request body' });
			return;
		}
		console.error('[Theme] Save preferences error:', error);
		writeJson(res, 500, { error: 'Failed to save theme preferences' });
	}
}

export async function handleResetThemePreferences(
	req: IncomingMessage,
	res: ServerResponse
): Promise<void> {
	try {
		const userId = getAuthenticatedUserIdFromRequest(req);
		if (!userId) {
			writeJson(res, 401, { error: 'User not authenticated' });
			return;
		}

		themeRepository.set(userId, {
			theme_id: 'midnight-blue',
			custom_theme: null,
			uniform_font_enabled: 0,
			uniform_font_family: 'inherit',
			uniform_font_size: 'inherit',
			uniform_font_weight: '600',
			uniform_font_style: 'normal'
		});

		writeJson(res, 200, {
			success: true,
			theme_id: 'midnight-blue'
		});
	} catch (error) {
		console.error('[Theme] Reset preferences error:', error);
		writeJson(res, 500, { error: 'Failed to reset theme preferences' });
	}
}
