import db from '../database.js';

export interface Webhook {
  id: number;
  user_id: number;
  name: string;
  target_url: string;
  secret: string;
  event_filters: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface WebhookDelivery {
  id: number;
  webhook_id: number;
  event_type: string;
  payload_json: string;
  status: 'pending' | 'success' | 'failed';
  attempt_count: number;
  last_error: string | null;
  response_code: number | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
}

export class WebhookRepository {
  create(userId: number, data: { name: string; target_url: string; secret: string; event_filters: string[]; enabled?: number }): number {
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO webhooks (user_id, name, target_url, secret, event_filters, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      userId,
      data.name,
      data.target_url,
      data.secret,
      JSON.stringify(data.event_filters),
      data.enabled ?? 1,
      now,
      now
    );

    return result.lastInsertRowid as number;
  }

  findById(id: number): Webhook | null {
    const stmt = db.prepare('SELECT * FROM webhooks WHERE id = ?');
    return (stmt.get(id) as Webhook) || null;
  }

  findByIdForUser(id: number, userId: number): Webhook | null {
    const stmt = db.prepare('SELECT * FROM webhooks WHERE id = ? AND user_id = ?');
    return (stmt.get(id, userId) as Webhook) || null;
  }

  listByUser(userId: number): Webhook[] {
    const stmt = db.prepare('SELECT * FROM webhooks WHERE user_id = ? ORDER BY created_at DESC');
    return stmt.all(userId) as Webhook[];
  }
  listEnabled(): Webhook[] {
    const stmt = db.prepare(`
      SELECT * FROM webhooks
      WHERE enabled = 1
      ORDER BY created_at DESC
    `);

    return stmt.all() as Webhook[];
  }

  delete(id: number, userId: number): boolean {
    const stmt = db.prepare('DELETE FROM webhooks WHERE id = ? AND user_id = ?');
    const result = stmt.run(id, userId);
    return result.changes > 0;
  }

  update(
    id: number,
    userId: number,
    updates: {
      name?: string;
      target_url?: string;
      event_filters?: string[];
      enabled?: number;
    }
  ): boolean {
    const fields: string[] = [];
    const values: any[] = [];

    if (typeof updates.name === 'string') {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (typeof updates.target_url === 'string') {
      fields.push('target_url = ?');
      values.push(updates.target_url);
    }
    if (Array.isArray(updates.event_filters)) {
      fields.push('event_filters = ?');
      values.push(JSON.stringify(updates.event_filters));
    }
    if (typeof updates.enabled === 'number') {
      fields.push('enabled = ?');
      values.push(updates.enabled ? 1 : 0);
    }

    if (fields.length === 0) return false;
    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(id, userId);

    const stmt = db.prepare(`UPDATE webhooks SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`);
    const result = stmt.run(...values);
    return result.changes > 0;
  }

  rotateSecret(id: number, userId: number, secret: string): boolean {
    const stmt = db.prepare(`
      UPDATE webhooks
      SET secret = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `);
    const result = stmt.run(secret, Date.now(), id, userId);
    return result.changes > 0;
  }

  createDelivery(data: { webhook_id: number; event_type: string; payload_json: string }): number {
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO webhook_deliveries (webhook_id, event_type, payload_json, status, attempt_count, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0, ?, ?)
    `);

    const result = stmt.run(data.webhook_id, data.event_type, data.payload_json, now, now);
    return result.lastInsertRowid as number;
  }

  markDeliveryAttempt(deliveryId: number, attemptCount: number): void {
    const now = Date.now();
    const stmt = db.prepare(`
      UPDATE webhook_deliveries
      SET attempt_count = ?,
          updated_at = ?
      WHERE id = ?
    `);
    stmt.run(attemptCount, now, deliveryId);
  }

  markDeliverySuccess(deliveryId: number, responseCode: number, attemptCount: number = 1): void {
    const now = Date.now();
    const stmt = db.prepare(`
      UPDATE webhook_deliveries
      SET status = 'success',
          attempt_count = ?,
          response_code = ?,
          last_error = NULL,
          updated_at = ?,
          delivered_at = ?
      WHERE id = ?
    `);
    stmt.run(attemptCount, responseCode, now, now, deliveryId);
  }

  markDeliveryFailure(deliveryId: number, attemptCount: number, error: string, responseCode?: number): void {
    const now = Date.now();
    const stmt = db.prepare(`
      UPDATE webhook_deliveries
      SET status = 'failed',
          attempt_count = ?,
          response_code = ?,
          last_error = ?,
          updated_at = ?
      WHERE id = ?
    `);
    stmt.run(attemptCount, responseCode ?? null, error.slice(0, 1000), now, deliveryId);
  }

  listDeliveriesForUser(userId: number, limit: number = 50): Array<WebhookDelivery & { webhook_name: string }> {
    const stmt = db.prepare(`
      SELECT d.*, w.name as webhook_name
      FROM webhook_deliveries d
      JOIN webhooks w ON d.webhook_id = w.id
      WHERE w.user_id = ?
      ORDER BY d.created_at DESC
      LIMIT ?
    `);
    return stmt.all(userId, limit) as Array<WebhookDelivery & { webhook_name: string }>;
  }

  findDeliveryForUser(deliveryId: number, userId: number): (WebhookDelivery & { webhook_name: string; target_url: string; secret: string }) | null {
    const stmt = db.prepare(`
      SELECT d.*, w.name as webhook_name, w.target_url, w.secret
      FROM webhook_deliveries d
      JOIN webhooks w ON d.webhook_id = w.id
      WHERE d.id = ? AND w.user_id = ?
      LIMIT 1
    `);
    return (stmt.get(deliveryId, userId) as (WebhookDelivery & { webhook_name: string; target_url: string; secret: string })) || null;
  }
}

export const webhookRepository = new WebhookRepository();
