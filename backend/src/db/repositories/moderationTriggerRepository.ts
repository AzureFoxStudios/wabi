import db from '../database.js';

export type ModerationAction = 'timeout' | 'ban';

export interface ModerationTrigger {
  id: number;
  pattern: string;
  action: ModerationAction;
  duration: string | null;
  severity: number;
  enabled: number;
  created_by: number | null;
  created_at: number;
  updated_at: number;
}

export class ModerationTriggerRepository {
  listAll(includeDisabled = true): ModerationTrigger[] {
    const stmt = db.prepare(`
      SELECT id, pattern, action, duration, severity, enabled, created_by, created_at, updated_at
      FROM moderation_triggers
      ${includeDisabled ? '' : 'WHERE enabled = 1'}
      ORDER BY severity DESC, created_at DESC
    `);
    return stmt.all() as ModerationTrigger[];
  }

  listEnabled(): ModerationTrigger[] {
    return this.listAll(false);
  }

  create(data: { pattern: string; action: ModerationAction; duration?: string | null; severity: number; enabled?: number; created_by?: number | null }): number {
    const stmt = db.prepare(`
      INSERT INTO moderation_triggers (pattern, action, duration, severity, enabled, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    const info = stmt.run(
      data.pattern,
      data.action,
      data.duration ?? null,
      data.severity,
      data.enabled ?? 1,
      data.created_by ?? null,
      now,
      now
    );
    return info.lastInsertRowid as number;
  }

  update(id: number, updates: { pattern?: string; action?: ModerationAction; duration?: string | null; severity?: number; enabled?: number }): boolean {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.pattern !== undefined) {
      fields.push('pattern = ?');
      values.push(updates.pattern);
    }
    if (updates.action !== undefined) {
      fields.push('action = ?');
      values.push(updates.action);
    }
    if (updates.duration !== undefined) {
      fields.push('duration = ?');
      values.push(updates.duration);
    }
    if (updates.severity !== undefined) {
      fields.push('severity = ?');
      values.push(updates.severity);
    }
    if (updates.enabled !== undefined) {
      fields.push('enabled = ?');
      values.push(updates.enabled);
    }

    if (fields.length === 0) return false;

    fields.push('updated_at = ?');
    values.push(Date.now());

    const stmt = db.prepare(`UPDATE moderation_triggers SET ${fields.join(', ')} WHERE id = ?`);
    const info = stmt.run(...values, id);
    return info.changes > 0;
  }

  delete(id: number): boolean {
    const stmt = db.prepare('DELETE FROM moderation_triggers WHERE id = ?');
    const info = stmt.run(id);
    return info.changes > 0;
  }
}

export const moderationTriggerRepository = new ModerationTriggerRepository();
