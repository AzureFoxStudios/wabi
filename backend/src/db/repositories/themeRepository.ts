import { stdbPreferenceIngest, stdbPreferenceRows } from './stdbPreferenceRuntime.js';

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

	private findById(userId: number): ThemePreferences | null {
		const rows = stdbPreferenceRows(
			'theme_preferences.read',
			`SELECT row_json FROM state_theme_preferences WHERE user_id = ${Math.floor(userId)} LIMIT 1`
		);
		if (rows.length === 0) return null;
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

	// Get theme preferences for a user (create defaults if not exists)
	get(userId: number): ThemePreferences {
		let prefs = this.findById(userId);

		if (!prefs) {
			const now = Math.floor(Date.now() / 1000);
			prefs = this.normalizeRow(userId, {
				theme_id: 'midnight-blue',
				created_at: now,
				updated_at: now
			});
			this.upsertStdb(prefs);
		}

		return prefs;
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

		this.upsertStdb(next);
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
		const now = Math.floor(Date.now() / 1000);
		this.upsertStdb(
			this.normalizeRow(userId, {
				theme_id: 'midnight-blue',
				custom_theme: null,
				created_at: now,
				updated_at: now,
				uniform_font_enabled: 0,
				uniform_font_family: 'inherit',
				uniform_font_size: 'inherit',
				uniform_font_weight: '600',
				uniform_font_style: 'normal'
			})
		);
	}
}

export const themeRepository = new ThemeRepository();
