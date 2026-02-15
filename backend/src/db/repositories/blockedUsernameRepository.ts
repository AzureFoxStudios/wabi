import db from '../database.js';

export interface BlockedUsername {
  id?: number;
  value: string;
  reason?: string;
  is_active?: number;
  created_by?: number;
  created_at?: number;
}

function normalize(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase();
}

export class BlockedUsernameRepository {
  isBlocked(value: string): boolean {
    const normalized = normalize(value);
    if (!normalized) return false;
    const row = db.prepare('SELECT 1 FROM blocked_usernames WHERE value = ? COLLATE NOCASE AND is_active = 1 LIMIT 1').get(normalized);
    return !!row;
  }

  add(value: string, reason?: string, createdBy?: number): void {
    const normalized = normalize(value);
    db.prepare('INSERT OR REPLACE INTO blocked_usernames (value, reason, is_active, created_by, created_at) VALUES (?, ?, 1, ?, strftime(\'%s\', \'now\'))')
      .run(normalized, reason || null, createdBy || null);
  }

  list(): BlockedUsername[] {
    return db.prepare('SELECT * FROM blocked_usernames WHERE is_active = 1 ORDER BY created_at DESC').all() as BlockedUsername[];
  }

  remove(value: string): void {
    const normalized = normalize(value);
    db.prepare('UPDATE blocked_usernames SET is_active = 0 WHERE value = ? COLLATE NOCASE').run(normalized);
  }
}

export const blockedUsernameRepository = new BlockedUsernameRepository();
