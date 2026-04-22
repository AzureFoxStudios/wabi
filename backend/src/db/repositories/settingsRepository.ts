import {
	stdbPreferenceIngest,
	stdbPreferenceIngestAsync,
	stdbPreferenceRows
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

	private findById(userId: number): UserSettings | null {
		const rows = stdbPreferenceRows(
			'user_settings.read',
			`SELECT row_json FROM state_user_settings WHERE user_id = ${Math.floor(userId)} LIMIT 1`
		);
		if (rows.length === 0) return null;
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

	// Get settings for a user (create defaults if not exists)
	get(userId: number): UserSettings {
		let settings = this.findById(userId);

		if (!settings) {
			settings = this.normalizeRow(userId, {
				offline_message_retention: '7d',
				allow_temp_user_messages: 1,
				home_experience: 'community',
				require_password_change: 0,
				payment_preferred_route: null
			});
			this.upsertStdb(settings);
		}

		return settings;
	}

	// Set settings for a user
	set(userId: number, settings: Partial<Omit<UserSettings, 'user_id'>>): void {
		const existing = this.findById(userId);
		const next = this.normalizeRow(userId, {
			...(existing || {}),
			...settings
		});

		this.upsertStdb(next);
	}

	async setAsync(userId: number, settings: Partial<Omit<UserSettings, 'user_id'>>): Promise<void> {
		const existing = this.findById(userId);
		const next = this.normalizeRow(userId, {
			...(existing || {}),
			...settings
		});

		await this.upsertStdbAsync(next);
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
