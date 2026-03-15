import db from '../database.js';
import { escapeSqlLiteral } from '../../state-plane/stdbSyncClient.js';
import {
	stdbAppPolicyEnabled,
	stdbAppPolicyIngest,
	stdbAppPolicyRows
} from './stdbAppPolicyRuntime.js';

interface AppSettingRow {
	key: string;
	value: string;
	updated_at: number;
}

function isStdbEligibleKey(key: string): boolean {
	return key === 'message_purge_version' || key.startsWith('policy:');
}

export class AppPolicyRepository {
	private getRawLegacy(key: string): string | null {
		const row = db
			.prepare('SELECT value FROM app_settings WHERE key = ? LIMIT 1')
			.get(key) as { value?: string } | undefined;
		return typeof row?.value === 'string' ? row.value : null;
	}

	private upsertLegacy(key: string, value: string): void {
		const now = Date.now();
		db.prepare(
			`INSERT INTO app_settings (key, value, updated_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		).run(key, value, now);
	}

	private getRawStdb(key: string): string | null {
		const rows = stdbAppPolicyRows(
			`app_settings.read.${key}`,
			`SELECT row_json FROM state_app_setting WHERE setting_key = ${escapeSqlLiteral(key)} LIMIT 1`
		);
		if (!rows || rows.length === 0) return null;
		try {
			const parsed = JSON.parse(String(rows[0].row_json || '{}')) as Partial<AppSettingRow>;
			return typeof parsed.value === 'string' ? parsed.value : null;
		} catch {
			return null;
		}
	}

	private upsertStdb(key: string, value: string): void {
		stdbAppPolicyIngest(`app_settings.write.${key}`, 'upsert_app_setting', {
			settingKey: key,
			value,
			updatedAt: Date.now(),
			row: {
				key,
				value,
				updated_at: Date.now()
			}
		});
	}

	getRaw(key: string): string | null {
		if (stdbAppPolicyEnabled() && isStdbEligibleKey(key)) {
			const legacy = this.getRawLegacy(key);
			if (legacy !== null) return legacy;
			return this.getRawStdb(key);
		}

		return this.getRawLegacy(key);
	}

	setRaw(key: string, value: string): void {
		if (stdbAppPolicyEnabled() && isStdbEligibleKey(key)) {
			this.upsertStdb(key, value);
		}
		this.upsertLegacy(key, value);
	}
}

export const appPolicyRepository = new AppPolicyRepository();
