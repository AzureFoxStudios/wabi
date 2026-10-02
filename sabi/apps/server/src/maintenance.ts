/**
 * Integrity, backup and restore. Because every projection table is derived
 * from the journal, "verify" can rebuild the whole database from events and
 * compare it with what is on disk, and "restore" can rebuild from an export.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { JournalEvent } from '@sabi/core';
import { all, openDb, PROJECTION_TABLES, run, tx } from './db.ts';
import { hashEvent, readAll, verifyChain, GENESIS, type ChainReport } from './journal.ts';
import { project } from './projector.ts';

function insertRaw(db: DatabaseSync, e: JournalEvent) {
  run(db, 'INSERT INTO events (seq, id, at, actor_id, type, subject_type, subject_id, data, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?)',
    e.seq, e.id, e.at, e.actorId, e.type, e.subjectType, e.subjectId, JSON.stringify(e.data), e.prevHash, e.hash);
}

/** Rebuild projections from the journal into `target`. */
export function replayInto(target: DatabaseSync, events: Iterable<JournalEvent>): number {
  let n = 0;
  let prev = GENESIS;
  tx(target, () => {
    for (const e of events) {
      if (e.prevHash !== prev || hashEvent(prev, e) !== e.hash) throw new Error(`Journal broken at seq ${e.seq}`);
      insertRaw(target, e);
      project(target, e);
      prev = e.hash;
      n++;
    }
  });
  return n;
}

function dump(db: DatabaseSync, table: string): string[] {
  return all<Record<string, unknown>>(db, `SELECT * FROM ${table}`).map((r) => JSON.stringify(r)).sort();
}

export interface VerifyReport {
  chain: ChainReport;
  projections: { table: string; ok: boolean; live: number; replayed: number }[];
  ok: boolean;
}

export function verify(db: DatabaseSync): VerifyReport {
  const chain = verifyChain(db);
  const projections: VerifyReport['projections'] = [];
  if (chain.ok) {
    const scratch = openDb(':memory:');
    replayInto(scratch, readAll(db));
    for (const t of PROJECTION_TABLES) {
      const a = dump(db, t);
      const b = dump(scratch, t);
      projections.push({ table: t, ok: a.length === b.length && a.every((x, i) => x === b[i]), live: a.length, replayed: b.length });
    }
    scratch.close();
  }
  return { chain, projections, ok: chain.ok && projections.every((p) => p.ok) };
}

/** Consistent online backup: SQLite snapshot + journal JSONL + file blobs. */
export function backup(db: DatabaseSync, dataDir: string, outDir: string): { dir: string; events: number } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = join(outDir, `sabi-backup-${stamp}`);
  mkdirSync(dir, { recursive: true });
  db.exec(`VACUUM INTO '${join(dir, 'sabi.db').replace(/'/g, "''")}'`);
  const lines: string[] = [];
  for (const e of readAll(db)) lines.push(JSON.stringify(e));
  writeFileSync(join(dir, 'journal.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''));
  if (existsSync(join(dataDir, 'files'))) cpSync(join(dataDir, 'files'), join(dir, 'files'), { recursive: true });
  writeFileSync(join(dir, 'README.txt'),
    'Sabi backup.\n- sabi.db: SQLite snapshot (open with any SQLite tool).\n- journal.jsonl: every business event, hash-chained; `sabi restore <this dir>` rebuilds a database from it.\n- files/: attachments, named by SHA-256.\n');
  return { dir, events: lines.length };
}

/** Rebuild a fresh database from a journal export (restore / migrate to a new server). */
export function restoreFromJournal(jsonlPath: string, targetDbPath: string): number {
  if (existsSync(targetDbPath)) throw new Error(`${targetDbPath} already exists; restore into an empty data directory`);
  const db = openDb(targetDbPath);
  const text = readFileSync(jsonlPath, 'utf8');
  const events = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as JournalEvent);
  const n = replayInto(db, events);
  db.close();
  return n;
}
