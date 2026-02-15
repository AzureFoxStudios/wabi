import db from '../database.js';

export interface ModerationTrigger {
  id?: number;
  phrase: string;
  action: 'timeout' | 'ban';
  duration_minutes?: number;
  severity?: 'low' | 'medium' | 'high';
  is_active?: number;
  created_by?: number;
  created_at?: number;
  updated_at?: number;
}

export class ModerationTriggerRepository {
  listActive(): ModerationTrigger[] {
    return db.prepare('SELECT * FROM moderation_triggers WHERE is_active = 1 ORDER BY id DESC').all() as ModerationTrigger[];
  }

  add(trigger: Omit<ModerationTrigger, 'id' | 'created_at' | 'updated_at'>): void {
    db.prepare(
      `INSERT INTO moderation_triggers (phrase, action, duration_minutes, severity, is_active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, strftime('%s', 'now'), strftime('%s', 'now'))`
    ).run(
      trigger.phrase.trim().toLowerCase(),
      trigger.action,
      trigger.duration_minutes ?? 30,
      trigger.severity ?? 'medium',
      trigger.is_active ?? 1,
      trigger.created_by ?? null
    );
  }

  disable(id: number): void {
    db.prepare("UPDATE moderation_triggers SET is_active = 0, updated_at = strftime('%s', 'now') WHERE id = ?").run(id);
  }
}

export const moderationTriggerRepository = new ModerationTriggerRepository();
