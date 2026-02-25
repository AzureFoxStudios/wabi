import { IncomingMessage, ServerResponse } from 'http';
import { themeRepository } from '../db/repositories/themeRepository.js';
import { verifyToken } from '../auth/jwt.js';
import { sessionRepository } from '../db/repositories/sessionRepository.js';

// Parse JSON body
function parseBody(req: IncomingMessage): Promise<Record<string, any>> {
	return new Promise((resolve, reject) => {
		let body = '';

		req.on('data', (chunk) => {
			body += chunk.toString();
		});

		req.on('end', () => {
			try {
				resolve(JSON.parse(body));
			} catch (error) {
				reject(new Error('Invalid JSON'));
			}
		});

		req.on('error', reject);
	});
}

// Get authenticated user ID from request
function getAuthenticatedUserId(req: IncomingMessage): number | null {
	const authHeader = req.headers.authorization;
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return null;
	}

	try {
		const token = authHeader.slice(7);
		const payload = verifyToken(token);
		const dbSession = sessionRepository.findById(payload.sessionId);
		if (!dbSession || (dbSession.expires_at && dbSession.expires_at < Date.now())) {
			return null;
		}
		return payload.userId;
	} catch {
		return null;
	}
}

// Predefined theme IDs (validation)
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
];

// Get user theme preferences
export async function handleGetThemePreferences(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		// Extract and verify user ID from Authorization header
		const userId = getAuthenticatedUserId(req);
		if (!userId) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'User not authenticated' }));
			return;
		}

		// Get theme preferences from database
		const prefs = themeRepository.get(userId);

		// Parse custom theme if it exists
		let customTheme = null;
		if (prefs.custom_theme) {
			try {
				customTheme = JSON.parse(prefs.custom_theme);
			} catch (error) {
				console.error('[Theme] Failed to parse custom theme:', error);
			}
		}

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			theme_id: prefs.theme_id,
			custom_theme: customTheme,
			uniform_font_enabled: prefs.uniform_font_enabled,
			uniform_font_family: prefs.uniform_font_family,
			uniform_font_size: prefs.uniform_font_size,
			uniform_font_weight: prefs.uniform_font_weight,
			uniform_font_style: prefs.uniform_font_style,
			updated_at: prefs.updated_at
		}));
	} catch (error) {
		console.error('[Theme] Get preferences error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to load theme preferences' }));
	}
}

// Save user theme preferences
export async function handleSaveThemePreferences(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		// Extract and verify user ID from Authorization header
		const userId = getAuthenticatedUserId(req);
		if (!userId) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'User not authenticated' }));
			return;
		}

		// Parse request body
		let body: any;
		try {
			body = await parseBody(req);
		} catch (parseError) {
			console.error('[Theme] JSON parse error:', parseError);
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid JSON in request body' }));
			return;
		}

		const { theme_id, custom_theme, uniform_font_enabled, uniform_font_family, uniform_font_size, uniform_font_weight, uniform_font_style } = body;
		console.log('[Theme] Save request body:', { theme_id, custom_theme, uniform_font_enabled, uniform_font_family, uniform_font_size, uniform_font_weight, uniform_font_style });

		// Validate theme_id if provided
		if (theme_id && !VALID_THEME_IDS.includes(theme_id)) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				error: 'Invalid theme ID',
				valid_themes: VALID_THEME_IDS
			}));
			return;
		}

		// Validate custom_theme if provided
		if (custom_theme !== undefined && custom_theme !== null) {
			// Ensure it's an object or null
			if (typeof custom_theme !== 'object') {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Custom theme must be an object or null' }));
				return;
			}

			// Validate custom theme structure (basic validation)
			if (custom_theme.colors && typeof custom_theme.colors !== 'object') {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Custom theme colors must be an object' }));
				return;
			}
		}

		// Save theme preferences
		const prefsToSave: any = {};

		if (theme_id !== undefined) {
			prefsToSave.theme_id = theme_id;
		}

		if (custom_theme !== undefined) {
			prefsToSave.custom_theme = custom_theme ? JSON.stringify(custom_theme) : null;
		}

		// Save uniform font settings
		if (uniform_font_enabled !== undefined) {
			prefsToSave.uniform_font_enabled = uniform_font_enabled;
		}

		if (uniform_font_family !== undefined) {
			prefsToSave.uniform_font_family = uniform_font_family;
		}

		if (uniform_font_size !== undefined) {
			prefsToSave.uniform_font_size = uniform_font_size;
		}

		if (uniform_font_weight !== undefined) {
			prefsToSave.uniform_font_weight = uniform_font_weight;
		}

		if (uniform_font_style !== undefined) {
			prefsToSave.uniform_font_style = uniform_font_style;
		}

		themeRepository.set(userId, prefsToSave);

		// Return updated preferences
		const updated = themeRepository.get(userId);

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			success: true,
			theme_id: updated.theme_id,
			uniform_font_enabled: updated.uniform_font_enabled,
			uniform_font_family: updated.uniform_font_family,
			uniform_font_size: updated.uniform_font_size,
			uniform_font_weight: updated.uniform_font_weight,
			uniform_font_style: updated.uniform_font_style,
			updated_at: updated.updated_at
		}));
	} catch (error) {
		console.error('[Theme] Save preferences error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to save theme preferences' }));
	}
}

// Reset theme preferences to default
export async function handleResetThemePreferences(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		// Extract and verify user ID from Authorization header
		const userId = getAuthenticatedUserId(req);
		if (!userId) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'User not authenticated' }));
			return;
		}

		// Reset to default (midnight-blue theme, no custom theme, no uniform font)
		themeRepository.set(userId, {
			theme_id: 'midnight-blue',
			custom_theme: null,
			uniform_font_enabled: 0,
			uniform_font_family: 'inherit',
			uniform_font_size: 'inherit',
			uniform_font_weight: '600',
			uniform_font_style: 'normal'
		});

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			success: true,
			theme_id: 'midnight-blue'
		}));
	} catch (error) {
		console.error('[Theme] Reset preferences error:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to reset theme preferences' }));
	}
}
