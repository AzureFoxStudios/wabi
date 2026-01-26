import db from '../database.js';

export interface UserSettings {
	user_id: number;
	offline_message_retention: string;
	allow_temp_user_messages: number;
	business_private_mode?: number;
}

export class SettingsRepository {
	// Get settings for a user (create defaults if not exists)
	get(userId: number): UserSettings {
		let settings = this.findById(userId);

		if (!settings) {
			// Create default settings
			this.set(userId, {
				offline_message_retention: '7d',
				allow_temp_user_messages: 1
			});
			settings = this.findById(userId)!;
		}

		return settings;
	}

	// Find settings by user ID
	private findById(userId: number): UserSettings | null {
		const stmt = db.prepare('SELECT * FROM user_settings WHERE user_id = ?');
		return (stmt.get(userId) as UserSettings) || null;
	}

	// Set settings for a user
	set(userId: number, settings: Partial<Omit<UserSettings, 'user_id'>>): void {
		const existing = this.findById(userId);

		if (!existing) {
			// Create new settings
			const stmt = db.prepare(`
				INSERT INTO user_settings (user_id, offline_message_retention, allow_temp_user_messages, business_private_mode)
				VALUES (?, ?, ?, ?)
			`);

			stmt.run(
				userId,
				settings.offline_message_retention || '7d',
				settings.allow_temp_user_messages !== undefined ? settings.allow_temp_user_messages : 1,
				settings.business_private_mode !== undefined ? settings.business_private_mode : 0
			);
		} else {
			// Update existing settings
			const fields = Object.keys(settings).filter((key) => key !== 'user_id');
			if (fields.length === 0) return;

			const setClause = fields.map((field) => `${field} = ?`).join(', ');
			const values = fields.map((field) => settings[field as keyof Omit<UserSettings, 'user_id'>]);

			const stmt = db.prepare(`UPDATE user_settings SET ${setClause} WHERE user_id = ?`);
			stmt.run(...values, userId);
		}
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
