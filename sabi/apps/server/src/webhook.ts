/**
 * Outgoing webhook: after each committed command, POST a summary of its events
 * to the configured URL. Fire-and-forget with a short timeout — the journal is
 * the source of truth, so a receiver that misses a call can catch up from
 * `GET /api/export` or the `seq` numbers. Bodies are signed with HMAC-SHA256
 * when a secret is set (header `x-sabi-signature: sha256=<hex>`).
 */
import { createHmac } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { JournalEvent } from '@sabi/core';
import { one } from './db.ts';

export function webhookListener(db: DatabaseSync, post: typeof fetch = fetch) {
  return (events: JournalEvent[]) => {
    const row = one<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'webhook'");
    const cfg = row ? (JSON.parse(row.value) as { url?: string; secret?: string } | null) : null;
    if (!cfg?.url || !events.length) return;
    const body = JSON.stringify({
      head: events[events.length - 1].seq,
      events: events.filter((e) => e.type !== 'ledger.posted').map((e) => ({ seq: e.seq, at: e.at, type: e.type, subjectType: e.subjectType, subjectId: e.subjectId, actorId: e.actorId })),
    });
    const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'Sabi-Webhook/1' };
    if (cfg.secret) headers['x-sabi-signature'] = `sha256=${createHmac('sha256', cfg.secret).update(body).digest('hex')}`;
    post(cfg.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) })
      .then((r) => { if (!r.ok) console.warn(`webhook: ${cfg.url} answered ${r.status}`); })
      .catch((e) => console.warn(`webhook: ${cfg.url} failed: ${(e as Error).message}`));
  };
}
