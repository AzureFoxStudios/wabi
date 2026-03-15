import db from '../database.js';
import { stdbPreferenceIngest, stdbPreferenceRows, stdbPreferencesEnabled } from './stdbPreferenceRuntime.js';

export interface ThemePreferences {
	user_id: number;
	theme_id: string;
	custom_theme: string | null;
	created_at: number;
	updated_at: number;
	uniform_font_enabled?: number;
	uniform_font_family?: string;
	uniform_font_size?: string;
	uniform_font_weight?: string;
	uniform_font_style?: string;
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
	private normalizeRow(userId: number, row: Partial<ThemePreferences> | null | undefined): ThemePreferences {
		const now = Math.floor(Date.now() / 1000);
		return {
			user_id: userId,
			theme_id: row?.theme_id || 'midnight-blue',
			custom_theme: row?.custom_theme ?? null,
			created_at: row?.created_at !== undefined ? Number(row.created_at) : now,
			updated_at: row?.updated_at !== undefined ? Number(row.updated_at) : now,
			uniform_font_enabled:
				row?.uniform_font_enabled !== undefined ? Number(row.uniform_font_enabled) : 0,
			uniform_font_family: row?.uniform_font_family || 'inherit',
			uniform_font_size: row?.uniform_font_size || 'inherit',
			uniform_font_weight: row?.uniform_font_weight || '600',
			uniform_font_style: row?.uniform_font_style || 'normal'
		};
	}

	private findByIdLegacy(userId: number): ThemePreferences | null {
		const stmt = db.prepare('SELECT * FROM theme_preferences WHERE user_id = ?');
		const row = stmt.get(userId) as ThemePreferences | undefined;
		return row ? this.normalizeRow(userId, row) : null;
	}

	private findByIdStdb(userId: number): ThemePreferences | null {
		const rows = stdbPreferenceRows(
			'theme_preferences.read',
			`SELECT row_json FROM state_theme_preferences WHERE user_id = ${Math.floor(userId)} LIMIT 1`
		);
		if (!rows || rows.length === 0) return null;
		try {
			const parsed = JSON.parse(String(rows[0].row_json || '')) as Partial<ThemePreferences>;
			return this.normalizeRow(userId, parsed);
		} catch {
			return null;
		}
	}

	private upsertStdb(prefs: ThemePreferences): void {
		stdbPreferenceIngest('theme_preferences.write', 'theme', 'upsert_theme_preferences', {
			userId: prefs.user_id,
			row: prefs
		});
	}

	private setLegacy(userId: number, prefs: Partial<Omit<ThemePreferences, 'user_id' | 'created_at' | 'updated_at'>>): void {
		const existing = this.findByIdLegacy(userId);
		const now = Math.floor(Date.now() / 1000);

		if (!existing) {
			const stmt = db.prepare(`
				INSERT INTO theme_preferences (user_id, theme_id, custom_theme, created_at, updated_at, uniform_font_enabled, uniform_font_family, uniform_font_size, uniform_font_weight, uniform_font_style)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`);

			stmt.run(
				userId,
				prefs.theme_id || 'midnight-blue',
				prefs.custom_theme || null,
				now,
				now,
				prefs.uniform_font_enabled ?? 0,
				prefs.uniform_font_family || 'inherit',
				prefs.uniform_font_size || 'inherit',
				prefs.uniform_font_weight || '600',
				prefs.uniform_font_style || 'normal'
			);
			return;
		}

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

		if (prefs.uniform_font_enabled !== undefined) {
			fields.push('uniform_font_enabled = ?');
			values.push(prefs.uniform_font_enabled);
		}

		if (prefs.uniform_font_family !== undefined) {
			fields.push('uniform_font_family = ?');
			values.push(prefs.uniform_font_family);
		}

		if (prefs.uniform_font_size !== undefined) {
			fields.push('uniform_font_size = ?');
			values.push(prefs.uniform_font_size);
		}

		if (prefs.uniform_font_weight !== undefined) {
			fields.push('uniform_font_weight = ?');
			values.push(prefs.uniform_font_weight);
		}

		if (prefs.uniform_font_style !== undefined) {
			fields.push('uniform_font_style = ?');
			values.push(prefs.uniform_font_style);
		}

		if (fields.length === 0) return;

		fields.push('updated_at = ?');
		values.push(now);

		const stmt = db.prepare(`UPDATE theme_preferences SET ${fields.join(', ')} WHERE user_id = ?`);
		stmt.run(...values, userId);
	}

	// Get theme preferences for a user (create defaults if not exists)
	get(userId: number): ThemePreferences {
		let prefs = this.findById(userId);

		if (!prefs) {
			// Create default preferences
			this.set(userId, {
				theme_id: 'midnight-blue'
			});
			prefs = this.findById(userId)!;
		}

		return prefs;
	}

	// Find theme preferences by user ID
	private findById(userId: number): ThemePreferences | null {
		if (stdbPreferencesEnabled()) {
			const legacy = this.findByIdLegacy(userId);
			if (legacy) return legacy;
			return this.findByIdStdb(userId);
		}

		return this.findByIdLegacy(userId);
	}

	// Set theme preferences for a user
	set(userId: number, prefs: Partial<Omit<ThemePreferences, 'user_id' | 'created_at' | 'updated_at'>>): void {
		const existing = this.findById(userId);
		const now = Math.floor(Date.now() / 1000);
		const next = this.normalizeRow(userId, {
			...(existing || { created_at: now }),
			...prefs,
			updated_at: now
		});

		if (stdbPreferencesEnabled()) {
			this.upsertStdb(next);
		}

		this.setLegacy(userId, {
			theme_id: next.theme_id,
			custom_theme: next.custom_theme,
			uniform_font_enabled: next.uniform_font_enabled,
			uniform_font_family: next.uniform_font_family,
			uniform_font_size: next.uniform_font_size,
			uniform_font_weight: next.uniform_font_weight,
			uniform_font_style: next.uniform_font_style
		});
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
