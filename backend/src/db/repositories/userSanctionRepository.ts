import db from '../database.js';

export type SanctionType = 'ban' | 'timeout';

export interface UserSanction {
  id?: number;
  user_id: number;
  sanction_type: SanctionType;
  reason?: string;
  is_active?: number;
  expires_at?: number | null;
  created_by?: number | null;
  created_at?: number;
  updated_at?: number;
}

export class UserSanctionRepository {
  getActive(userId: number): UserSanction[] {
    const nowSec = Math.floor(Date.now() / 1000);
    db.prepare(
      `UPDATE user_sanctions
       SET is_active = 0, updated_at = strftime('%s', 'now')
       WHERE user_id = ? AND is_active = 1 AND expires_at IS NOT NULL AND expires_at <= ?`
    ).run(userId, nowSec);

    return db.prepare('SELECT * FROM user_sanctions WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC')
      .all(userId) as UserSanction[];
  }

  hasActiveType(userId: number, sanctionType: SanctionType): boolean {
    const nowSec = Math.floor(Date.now() / 1000);
    const row = db.prepare(
      `SELECT 1 FROM user_sanctions
       WHERE user_id = ? AND sanction_type = ? AND is_active = 1
       AND (expires_at IS NULL OR expires_at > ?)
       LIMIT 1`
    ).get(userId, sanctionType, nowSec);
    return !!row;
  }

  add(userId: number, sanctionType: SanctionType, reason?: string, createdBy?: number | null, durationMinutes?: number): void {
    const expiresAt = durationMinutes ? Math.floor(Date.now() / 1000) + (durationMinutes * 60) : null;
    db.prepare(
      `INSERT INTO user_sanctions (user_id, sanction_type, reason, is_active, expires_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, strftime('%s', 'now'), strftime('%s', 'now'))`
    ).run(userId, sanctionType, reason || null, expiresAt, createdBy || null);
  }

  clearType(userId: number, sanctionType: SanctionType): void {
    db.prepare(
      `UPDATE user_sanctions
       SET is_active = 0, updated_at = strftime('%s', 'now')
       WHERE user_id = ? AND sanction_type = ? AND is_active = 1`
    ).run(userId, sanctionType);
  }
}

export const userSanctionRepository = new UserSanctionRepository();
