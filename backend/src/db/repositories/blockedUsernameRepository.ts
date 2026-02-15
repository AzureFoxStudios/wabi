import db from '../database.js';

export interface BlockedUsername {
	id?: number;
	normalized_name: string;
	reason?: string | null;
	created_at: number;
	created_by?: number | null;
	active: number;
}

export function normalizeUsernameForBlocklist(value: string): string {
	return value
		.normalize('NFKC')
		.trim()
		.toLowerCase()
		.replace(/^@+/, '')
		.replace(/\s+/g, '')
		.replace(/[^a-z0-9_]/g, '');
}

export class BlockedUsernameRepository {
	create(name: string, reason?: string, createdBy?: number): BlockedUsername {
		const normalizedName = normalizeUsernameForBlocklist(name);
		const now = Date.now();
		const stmt = db.prepare(`
			INSERT INTO blocked_usernames (normalized_name, reason, created_at, created_by, active)
			VALUES (?, ?, ?, ?, 1)
		`);
		const info = stmt.run(normalizedName, reason || null, now, createdBy || null);
		return {
			id: info.lastInsertRowid as number,
			normalized_name: normalizedName,
			reason: reason || null,
			created_at: now,
			created_by: createdBy || null,
			active: 1
		};
	}

	upsert(name: string, reason?: string, createdBy?: number): BlockedUsername {
		const normalizedName = normalizeUsernameForBlocklist(name);
		const now = Date.now();
		const stmt = db.prepare(`
			INSERT INTO blocked_usernames (normalized_name, reason, created_at, created_by, active)
			VALUES (?, ?, ?, ?, 1)
			ON CONFLICT(normalized_name)
			DO UPDATE SET reason = excluded.reason, created_by = excluded.created_by, active = 1
		`);
		stmt.run(normalizedName, reason || null, now, createdBy || null);
		const row = this.findByNormalizedName(normalizedName);
		if (!row) {
			throw new Error('Failed to upsert blocked username');
		}
		return row;
	}

	findByNormalizedName(normalizedName: string): BlockedUsername | null {
		const stmt = db.prepare('SELECT * FROM blocked_usernames WHERE normalized_name = ?');
		return (stmt.get(normalizedName) as BlockedUsername) || null;
	}

	listActive(): BlockedUsername[] {
		const stmt = db.prepare('SELECT * FROM blocked_usernames WHERE active = 1 ORDER BY created_at DESC');
		return stmt.all() as BlockedUsername[];
	}

	update(id: number, updates: { reason?: string; active?: number }): void {
		const fields: string[] = [];
		const values: Array<string | number | null> = [];

		if (updates.reason !== undefined) {
			fields.push('reason = ?');
			values.push(updates.reason || null);
		}
		if (updates.active !== undefined) {
			fields.push('active = ?');
			values.push(updates.active);
		}
		if (fields.length === 0) return;

		const stmt = db.prepare(`UPDATE blocked_usernames SET ${fields.join(', ')} WHERE id = ?`);
		stmt.run(...values, id);
	}

	deactivateByName(name: string): void {
		const normalizedName = normalizeUsernameForBlocklist(name);
		const stmt = db.prepare('UPDATE blocked_usernames SET active = 0 WHERE normalized_name = ?');
		stmt.run(normalizedName);
	}

	deleteByName(name: string): void {
		const normalizedName = normalizeUsernameForBlocklist(name);
		const stmt = db.prepare('DELETE FROM blocked_usernames WHERE normalized_name = ?');
		stmt.run(normalizedName);
	}

	isBlocked(name: string): { blocked: boolean; entry: BlockedUsername | null; normalizedName: string } {
		const normalizedName = normalizeUsernameForBlocklist(name);
		if (!normalizedName) {
			return { blocked: false, entry: null, normalizedName };
		}
		const stmt = db.prepare('SELECT * FROM blocked_usernames WHERE normalized_name = ? AND active = 1');
		const entry = (stmt.get(normalizedName) as BlockedUsername) || null;
		return { blocked: !!entry, entry, normalizedName };
	}
}

export const blockedUsernameRepository = new BlockedUsernameRepository();
