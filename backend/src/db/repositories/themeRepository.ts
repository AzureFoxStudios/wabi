import db from '../database.js';

export interface ThemePreferences {
	user_id: number;
	theme_id: string;
	custom_theme: string | null;
	created_at: number;
	updated_at: number;
}

export interface CustomTheme {
	colors?: {
		bgPrimary?: string;
		bgSecondary?: string;
		bgTertiary?: string;
		textPrimary?: string;
		textSecondary?: string;
		accent?: string;
	};
	gradients?: {
		primary?: string;
		accent?: string;
	};
	[key: string]: any; // Allow additional properties
}

export class ThemeRepository {
	// Get theme preferences for a user (create defaults if not exists)
	get(userId: number): ThemePreferences {
		let prefs = this.findById(userId);

		if (!prefs) {
			// Create default preferences
			this.set(userId, {
				theme_id: 'dark'
			});
			prefs = this.findById(userId)!;
		}

		return prefs;
	}

	// Find theme preferences by user ID
	private findById(userId: number): ThemePreferences | null {
		const stmt = db.prepare('SELECT * FROM theme_preferences WHERE user_id = ?');
		return (stmt.get(userId) as ThemePreferences) || null;
	}

	// Set theme preferences for a user
	set(userId: number, prefs: Partial<Omit<ThemePreferences, 'user_id' | 'created_at' | 'updated_at'>>): void {
		const existing = this.findById(userId);
		const now = Math.floor(Date.now() / 1000); // Unix timestamp in seconds

		if (!existing) {
			// Create new preferences
			const stmt = db.prepare(`
				INSERT INTO theme_preferences (user_id, theme_id, custom_theme, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?)
			`);

			stmt.run(
				userId,
				prefs.theme_id || 'dark',
				prefs.custom_theme || null,
				now,
				now
			);
		} else {
			// Update existing preferences
			const fields: string[] = [];
			const values: any[] = [];

			if (prefs.theme_id !== undefined) {
				fields.push('theme_id = ?');
				values.push(prefs.theme_id);
			}

			if (prefs.custom_theme !== undefined) {
				fields.push('custom_theme = ?');
				values.push(prefs.custom_theme);
			}

			if (fields.length === 0) return;

			// Always update the updated_at timestamp
			fields.push('updated_at = ?');
			values.push(now);

			const stmt = db.prepare(`UPDATE theme_preferences SET ${fields.join(', ')} WHERE user_id = ?`);
			stmt.run(...values, userId);
		}
	}

	// Set custom theme JSON
	setCustomTheme(userId: number, customTheme: CustomTheme): void {
		this.set(userId, {
			theme_id: 'custom',
			custom_theme: JSON.stringify(customTheme)
		});
	}

	// Get custom theme (parsed)
	getCustomTheme(userId: number): CustomTheme | null {
		const prefs = this.get(userId);
		if (!prefs.custom_theme) return null;

		try {
			return JSON.parse(prefs.custom_theme);
		} catch (error) {
			console.error('[ThemeRepository] Failed to parse custom theme:', error);
			return null;
		}
	}

	// Delete theme preferences (resets to default)
	delete(userId: number): void {
		const stmt = db.prepare('DELETE FROM theme_preferences WHERE user_id = ?');
		stmt.run(userId);
	}
}

export const themeRepository = new ThemeRepository();
