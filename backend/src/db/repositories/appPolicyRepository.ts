import db from '../database.js';

export class AppPolicyRepository {
	getRaw(key: string): string | null {
		const row = db
			.prepare('SELECT value FROM app_settings WHERE key = ? LIMIT 1')
			.get(key) as { value?: string } | undefined;
		return typeof row?.value === 'string' ? row.value : null;
	}

	setRaw(key: string, value: string): void {
		const now = Date.now();
		db.prepare(
			`INSERT INTO app_settings (key, value, updated_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		).run(key, value, now);
	}
}

export const appPolicyRepository = new AppPolicyRepository();
