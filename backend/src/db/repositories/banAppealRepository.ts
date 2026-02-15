import db from '../database.js';

export type BanAppealStatus = 'pending' | 'approved' | 'denied';

export interface BanAppeal {
	id?: number;
	user_id: number;
	status: BanAppealStatus;
	message: string;
	created_at: number;
	reviewed_by?: number | null;
	reviewed_at?: number | null;
	decision_note?: string | null;
}

export class BanAppealRepository {
	create(data: { user_id: number; message: string }): BanAppeal {
		const createdAt = Date.now();
		const stmt = db.prepare(`
			INSERT INTO ban_appeals (user_id, status, message, created_at)
			VALUES (?, 'pending', ?, ?)
		`);

		const info = stmt.run(data.user_id, data.message.trim(), createdAt);
		return {
			id: info.lastInsertRowid as number,
			user_id: data.user_id,
			status: 'pending',
			message: data.message.trim(),
			created_at: createdAt
		};
	}

	getLatestForUser(userId: number): BanAppeal | null {
		const stmt = db.prepare('SELECT * FROM ban_appeals WHERE user_id = ? ORDER BY created_at DESC LIMIT 1');
		return (stmt.get(userId) as BanAppeal) || null;
	}

	getPending(): BanAppeal[] {
		const stmt = db.prepare('SELECT * FROM ban_appeals WHERE status = ? ORDER BY created_at ASC');
		return stmt.all('pending') as BanAppeal[];
	}

	getAllByUser(userId: number): BanAppeal[] {
		const stmt = db.prepare('SELECT * FROM ban_appeals WHERE user_id = ? ORDER BY created_at DESC');
		return stmt.all(userId) as BanAppeal[];
	}

	findById(id: number): BanAppeal | null {
		const stmt = db.prepare('SELECT * FROM ban_appeals WHERE id = ?');
		return (stmt.get(id) as BanAppeal) || null;
	}

	updateDecision(id: number, decision: { status: 'approved' | 'denied'; reviewed_by: number; decision_note?: string; reviewed_at?: number }): void {
		const reviewedAt = decision.reviewed_at ?? Date.now();
		const stmt = db.prepare(`
			UPDATE ban_appeals
			SET status = ?, reviewed_by = ?, reviewed_at = ?, decision_note = ?
			WHERE id = ?
		`);
		stmt.run(decision.status, decision.reviewed_by, reviewedAt, decision.decision_note?.trim() || null, id);
	}

	clearPendingForUser(userId: number): void {
		const stmt = db.prepare(`
			UPDATE ban_appeals
			SET status = 'denied', reviewed_at = ?, decision_note = COALESCE(decision_note, 'Superseded by newer appeal')
			WHERE user_id = ? AND status = 'pending'
		`);
		stmt.run(Date.now(), userId);
	}
}

export const banAppealRepository = new BanAppealRepository();
