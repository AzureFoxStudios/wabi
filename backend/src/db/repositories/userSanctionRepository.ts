import db from '../database.js';

export interface UserSanction {
	user_id: number;
	is_sanctioned: number;
	evasion_count: number;
	appeal_required: number;
	updated_at: number;
}

export class UserSanctionRepository {
	findByUserId(userId: number): UserSanction | null {
		const stmt = db.prepare('SELECT * FROM user_sanctions WHERE user_id = ?');
		return (stmt.get(userId) as UserSanction) || null;
	}

	recordEvasionAttempt(userId: number): UserSanction {
		const now = Date.now();
		db.prepare(`
			INSERT INTO user_sanctions (user_id, is_sanctioned, evasion_count, appeal_required, updated_at)
			VALUES (?, 1, 0, 0, ?)
			ON CONFLICT(user_id) DO UPDATE SET
				is_sanctioned = 1,
				updated_at = excluded.updated_at
		`).run(userId, now);

		db.prepare(`
			UPDATE user_sanctions
			SET
				evasion_count = evasion_count + 1,
				appeal_required = CASE WHEN evasion_count + 1 >= 2 THEN 1 ELSE appeal_required END,
				updated_at = ?
			WHERE user_id = ?
		`).run(now, userId);

		const sanction = this.findByUserId(userId);
		if (!sanction) {
			throw new Error(`Failed to load sanctions for user ${userId}`);
		}
		return sanction;
	}
}

export const userSanctionRepository = new UserSanctionRepository();
