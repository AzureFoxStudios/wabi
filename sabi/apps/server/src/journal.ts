import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { JournalEvent } from '@sabi/core';
import { all, one, run } from './db.ts';

/**
 * Append-only, hash-chained event journal.
 *
 * hash = sha256(prev_hash + "\n" + canonicalJSON([seq, id, at, actorId, type, subjectType, subjectId, data]))
 *
 * This is the seam where another store (e.g. WabiDB via the Wabi Authority)
 * could be substituted: callers only use `append`, `readAll` and `verifyChain`.
 */

export const GENESIS = '0'.repeat(64);

export type EventDraft = Pick<JournalEvent, 'type' | 'subjectType' | 'subjectId' | 'data'>;

/** JSON with recursively sorted object keys (stable hashing). */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
}

export function hashEvent(prevHash: string, e: Omit<JournalEvent, 'hash' | 'prevHash'>): string {
  const body = canonical([e.seq, e.id, e.at, e.actorId, e.type, e.subjectType, e.subjectId, e.data]);
  return createHash('sha256').update(prevHash + '\n' + body).digest('hex');
}

export function head(db: DatabaseSync): { seq: number; hash: string } {
  const r = one<{ seq: number; hash: string }>(db, 'SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1');
  return r ?? { seq: 0, hash: GENESIS };
}

export function append(db: DatabaseSync, draft: EventDraft, actorId: string, at: string): JournalEvent {
  const h = head(db);
  // Strip undefined so the stored JSON and the hashed canonical form agree.
  const data = JSON.parse(JSON.stringify(draft.data ?? {}));
  const base = {
    seq: h.seq + 1,
    id: randomUUID(),
    at,
    actorId,
    type: draft.type,
    subjectType: draft.subjectType,
    subjectId: draft.subjectId,
    data,
  };
  const hash = hashEvent(h.hash, base);
  run(db,
    'INSERT INTO events (seq, id, at, actor_id, type, subject_type, subject_id, data, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?)',
    base.seq, base.id, base.at, base.actorId, base.type, base.subjectType, base.subjectId, JSON.stringify(data), h.hash, hash);
  return { ...base, prevHash: h.hash, hash };
}

type EventRow = {
  seq: number; id: string; at: string; actor_id: string; type: string; subject_type: string;
  subject_id: string; data: string; prev_hash: string; hash: string;
};

export function rowToEvent(r: EventRow): JournalEvent {
  return {
    seq: r.seq, id: r.id, at: r.at, actorId: r.actor_id, type: r.type,
    subjectType: r.subject_type as JournalEvent['subjectType'], subjectId: r.subject_id,
    data: JSON.parse(r.data), prevHash: r.prev_hash, hash: r.hash,
  };
}

export function* readAll(db: DatabaseSync, batch = 1000): Generator<JournalEvent> {
  let after = 0;
  for (;;) {
    const rows = all<EventRow>(db, 'SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?', after, batch);
    if (rows.length === 0) return;
    for (const r of rows) yield rowToEvent(r);
    after = rows[rows.length - 1].seq;
  }
}

export interface ChainReport {
  ok: boolean;
  events: number;
  head: string;
  firstBadSeq?: number;
  problem?: string;
}

export function verifyChain(db: DatabaseSync): ChainReport {
  let prev = GENESIS;
  let expectSeq = 1;
  let n = 0;
  for (const e of readAll(db)) {
    if (e.seq !== expectSeq) return { ok: false, events: n, head: prev, firstBadSeq: e.seq, problem: `gap: expected seq ${expectSeq}` };
    if (e.prevHash !== prev) return { ok: false, events: n, head: prev, firstBadSeq: e.seq, problem: 'prev_hash mismatch' };
    const h = hashEvent(prev, e);
    if (h !== e.hash) return { ok: false, events: n, head: prev, firstBadSeq: e.seq, problem: 'hash mismatch (event altered)' };
    prev = h;
    expectSeq++;
    n++;
  }
  return { ok: true, events: n, head: prev };
}
