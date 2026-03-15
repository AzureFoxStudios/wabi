import db from '../database.js';
import {
	stdbPreferenceIngest,
	stdbPreferenceIngestAsync,
	stdbPreferenceRows,
	stdbPreferencesEnabled
} from './stdbPreferenceRuntime.js';

export interface UserSettings {
	user_id: number;
	offline_message_retention: string;
	allow_temp_user_messages: number;
	business_private_mode?: number;
	home_experience?: string;
	require_password_change?: number;
	payment_preferred_route?: string | null;
}

export class SettingsRepository {
	private normalizeRow(userId: number, row: Partial<UserSettings> | null | undefined): UserSettings {
		return {
			user_id: userId,
			offline_message_retention: row?.offline_message_retention || '7d',
			allow_temp_user_messages:
				row?.allow_temp_user_messages !== undefined ? Number(row.allow_temp_user_messages) : 1,
			business_private_mode:
				row?.business_private_mode !== undefined ? Number(row.business_private_mode) : 0,
			home_experience: row?.home_experience || 'community',
			require_password_change:
				row?.require_password_change !== undefined ? Number(row.require_password_change) : 0,
			payment_preferred_route:
				typeof row?.payment_preferred_route === 'string' && row.payment_preferred_route.trim()
					? row.payment_preferred_route.trim().toUpperCase()
					: null
		};
	}

	private findByIdLegacy(userId: number): UserSettings | null {
		const stmt = db.prepare('SELECT * FROM user_settings WHERE user_id = ?');
		const row = stmt.get(userId) as UserSettings | undefined;
		return row ? this.normalizeRow(userId, row) : null;
	}

	private findByIdStdb(userId: number): UserSettings | null {
		const rows = stdbPreferenceRows(
			'user_settings.read',
			`SELECT row_json FROM state_user_settings WHERE user_id = ${Math.floor(userId)} LIMIT 1`
		);
		if (!rows || rows.length === 0) return null;
		try {
			const parsed = JSON.parse(String(rows[0].row_json || '')) as Partial<UserSettings>;
			return this.normalizeRow(userId, parsed);
		} catch {
			return null;
		}
	}

	private upsertStdb(settings: UserSettings): void {
		stdbPreferenceIngest('user_settings.write', 'settings', 'upsert_user_settings', {
			userId: settings.user_id,
			row: settings
		});
	}

	private async upsertStdbAsync(settings: UserSettings): Promise<void> {
		await stdbPreferenceIngestAsync('user_settings.write', 'settings', 'upsert_user_settings', {
			userId: settings.user_id,
			row: settings
		});
	}

	private setLegacy(userId: number, settings: Partial<Omit<UserSettings, 'user_id'>>): void {
		const existing = this.findByIdLegacy(userId);

		if (!existing) {
			const stmt = db.prepare(`
				INSERT INTO user_settings (user_id, offline_message_retention, allow_temp_user_messages, business_private_mode, home_experience, require_password_change, payment_preferred_route)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`);

			stmt.run(
				userId,
				settings.offline_message_retention || '7d',
				settings.allow_temp_user_messages !== undefined ? settings.allow_temp_user_messages : 1,
				settings.business_private_mode !== undefined ? settings.business_private_mode : 0,
				settings.home_experience || 'community',
				settings.require_password_change !== undefined ? settings.require_password_change : 0,
				typeof settings.payment_preferred_route === 'string' && settings.payment_preferred_route.trim()
					? settings.payment_preferred_route.trim().toUpperCase()
					: null
			);
			return;
		}

		const fields = Object.keys(settings).filter((key) => key !== 'user_id');
		if (fields.length === 0) return;

		const setClause = fields.map((field) => `${field} = ?`).join(', ');
		const values = fields.map((field) => settings[field as keyof Omit<UserSettings, 'user_id'>]);

		const stmt = db.prepare(`UPDATE user_settings SET ${setClause} WHERE user_id = ?`);
		stmt.run(...values, userId);
	}

	// Get settings for a user (create defaults if not exists)
	get(userId: number): UserSettings {
		let settings = this.findById(userId);

		if (!settings) {
			// Create default settings
			this.set(userId, {
				offline_message_retention: '7d',
				allow_temp_user_messages: 1,
				home_experience: 'community',
				require_password_change: 0,
				payment_preferred_route: null
			});
			settings = this.findById(userId)!;
		}

		return settings;
	}

	// Find settings by user ID
	private findById(userId: number): UserSettings | null {
		if (stdbPreferencesEnabled()) {
			const legacy = this.findByIdLegacy(userId);
			if (legacy) return legacy;
			return this.findByIdStdb(userId);
		}

		return this.findByIdLegacy(userId);
	}

	// Set settings for a user
	set(userId: number, settings: Partial<Omit<UserSettings, 'user_id'>>): void {
		const existing = this.findById(userId);
		const next = this.normalizeRow(userId, {
			...(existing || {}),
			...settings
		});

		if (stdbPreferencesEnabled()) {
			this.upsertStdb(next);
		}

		this.setLegacy(userId, {
			offline_message_retention: next.offline_message_retention,
			allow_temp_user_messages: next.allow_temp_user_messages,
			business_private_mode: next.business_private_mode,
			home_experience: next.home_experience,
			require_password_change: next.require_password_change,
			payment_preferred_route: next.payment_preferred_route
		});
	}

	async setAsync(userId: number, settings: Partial<Omit<UserSettings, 'user_id'>>): Promise<void> {
		const existing = this.findById(userId);
		const next = this.normalizeRow(userId, {
			...(existing || {}),
			...settings
		});

		if (stdbPreferencesEnabled()) {
			await this.upsertStdbAsync(next);
		}

		this.setLegacy(userId, {
			offline_message_retention: next.offline_message_retention,
			allow_temp_user_messages: next.allow_temp_user_messages,
			business_private_mode: next.business_private_mode,
			home_experience: next.home_experience,
			require_password_change: next.require_password_change,
			payment_preferred_route: next.payment_preferred_route
		});
	}

	// Get message retention period in milliseconds
	getRetentionMs(userId: number): number {
		const settings = this.get(userId);
		const retention = settings.offline_message_retention;

		const map: Record<string, number> = {
			'1d': 1 * 24 * 60 * 60 * 1000,
			'7d': 7 * 24 * 60 * 60 * 1000,
			'30d': 30 * 24 * 60 * 60 * 1000,
			'forever': Number.MAX_SAFE_INTEGER
		};

		return map[retention] || map['7d'];
	}

	// Check if user allows temp user messages
	allowsTempMessages(userId: number): boolean {
		const settings = this.get(userId);
		return settings.allow_temp_user_messages === 1;
	}
}

export const settingsRepository = new SettingsRepository();
