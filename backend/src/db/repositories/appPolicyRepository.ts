import { escapeSqlLiteral } from '../../state-plane/stdbSyncClient.js';
import { stdbAppPolicyIngest, stdbAppPolicyRows } from './stdbAppPolicyRuntime.js';

interface AppSettingRow {
	key: string;
	value: string;
	updated_at: number;
}

export class AppPolicyRepository {
	private getRawStdb(key: string): string | null {
		const rows = stdbAppPolicyRows(
			`app_settings.read.${key}`,
			`SELECT row_json FROM state_app_setting WHERE setting_key = ${escapeSqlLiteral(key)} LIMIT 1`
		);
		if (rows.length === 0) return null;
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
		return this.getRawStdb(key);
	}

	setRaw(key: string, value: string): void {
		this.upsertStdb(key, value);
	}
}

export const appPolicyRepository = new AppPolicyRepository();
