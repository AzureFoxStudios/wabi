import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Schema. `events` is the source of truth (append-only, hash-chained).
 * Every other table in PROJECTION_TABLES is a projection rebuilt by replay.
 * `credentials`, `sessions` and `reads` are local auth/UI state, not projected.
 */
export const SCHEMA_VERSION = 2;

export const PROJECTION_TABLES = [
  'event_links', 'settings', 'users', 'parties', 'items', 'jobs', 'documents', 'document_lines',
  'stock_moves', 'payments', 'payment_allocations', 'journal_entries', 'ledger_lines', 'tasks',
  'messages', 'files', 'approvals', 'sequences',
] as const;

const DDL = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  type TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  data TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_subject ON events(subject_type, subject_id);
CREATE TRIGGER IF NOT EXISTS events_append_only_u BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_append_only_d BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;

CREATE TABLE IF NOT EXISTS event_links (
  seq INTEGER NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
  PRIMARY KEY (subject_type, subject_id, seq)
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'th', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS credentials (user_id TEXT PRIMARY KEY, password_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS local_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reads (
  user_id TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, seq INTEGER NOT NULL,
  PRIMARY KEY (user_id, subject_type, subject_id)
);

CREATE TABLE IF NOT EXISTS parties (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, roles TEXT NOT NULL, tax_id TEXT,
  phone TEXT, email TEXT, address TEXT, parent_id TEXT, payment_terms_days INTEGER, credit_limit INTEGER,
  fields TEXT NOT NULL DEFAULT '{}', archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS parties_parent ON parties(parent_id);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT NOT NULL, uom TEXT NOT NULL,
  sale_price INTEGER NOT NULL, cost_price INTEGER NOT NULL, tax_code TEXT NOT NULL, wht_category TEXT,
  measure_template TEXT, fields TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, type TEXT NOT NULL, title TEXT NOT NULL,
  party_id TEXT NOT NULL, contact_id TEXT, owner_id TEXT, state TEXT NOT NULL, phase TEXT NOT NULL,
  due_date TEXT, fields TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_party ON jobs(party_id);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, number TEXT, state TEXT NOT NULL, phase TEXT NOT NULL,
  party_id TEXT NOT NULL, job_id TEXT, source_id TEXT, date TEXT NOT NULL, due_date TEXT,
  price_mode TEXT NOT NULL, notes TEXT, fields TEXT NOT NULL DEFAULT '{}', totals TEXT NOT NULL,
  total INTEGER NOT NULL, party_snapshot TEXT, seller_snapshot TEXT, issued_at TEXT, issued_by TEXT,
  void_reason TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS documents_number ON documents(type, number) WHERE number IS NOT NULL;
CREATE INDEX IF NOT EXISTS documents_job ON documents(job_id);
CREATE INDEX IF NOT EXISTS documents_party ON documents(party_id);
CREATE INDEX IF NOT EXISTS documents_source ON documents(source_id);

CREATE TABLE IF NOT EXISTS document_lines (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL, position INTEGER NOT NULL, item_id TEXT,
  description TEXT NOT NULL, measures TEXT, qty REAL NOT NULL, uom TEXT NOT NULL, unit_price INTEGER NOT NULL,
  discount_pct REAL NOT NULL DEFAULT 0, tax_code TEXT NOT NULL, wht_category TEXT, item_kind TEXT, source_line_id TEXT
);
CREATE INDEX IF NOT EXISTS lines_doc ON document_lines(document_id);
CREATE INDEX IF NOT EXISTS lines_source ON document_lines(source_line_id);

CREATE TABLE IF NOT EXISTS stock_moves (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL, qty REAL NOT NULL, from_loc TEXT NOT NULL, to_loc TEXT NOT NULL,
  document_id TEXT, job_id TEXT, line_id TEXT, note TEXT, at TEXT NOT NULL, by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS moves_item ON stock_moves(item_id);
CREATE INDEX IF NOT EXISTS moves_job ON stock_moves(job_id);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, number TEXT NOT NULL, direction TEXT NOT NULL, party_id TEXT NOT NULL, date TEXT NOT NULL,
  method TEXT NOT NULL, amount INTEGER NOT NULL, wht_amount INTEGER NOT NULL DEFAULT 0, wht_category TEXT,
  wht_certificate TEXT, reference TEXT, voided INTEGER NOT NULL DEFAULT 0, void_reason TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_allocations (
  payment_id TEXT NOT NULL, document_id TEXT NOT NULL, amount INTEGER NOT NULL,
  PRIMARY KEY (payment_id, document_id)
);
CREATE INDEX IF NOT EXISTS alloc_doc ON payment_allocations(document_id);

CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY, date TEXT NOT NULL, memo TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
  reversal_of TEXT, reversed_by TEXT
);
CREATE TABLE IF NOT EXISTS ledger_lines (
  entry_id TEXT NOT NULL, idx INTEGER NOT NULL, date TEXT NOT NULL, account TEXT NOT NULL,
  debit INTEGER NOT NULL, credit INTEGER NOT NULL, party_id TEXT, PRIMARY KEY (entry_id, idx)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, title TEXT NOT NULL,
  assignee_id TEXT, role TEXT, due TEXT, done_at TEXT, done_by TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_subject ON tasks(subject_type, subject_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
  author_id TEXT NOT NULL, body TEXT NOT NULL, mentions TEXT NOT NULL, file_ids TEXT NOT NULL, meta TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_subject ON messages(subject_type, subject_id);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, uploaded_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS files_subject ON files(subject_type, subject_id);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, transition_id TEXT NOT NULL,
  role TEXT NOT NULL, reason TEXT, state TEXT NOT NULL, requested_by TEXT NOT NULL, requested_at TEXT NOT NULL,
  decided_by TEXT, decided_at TEXT, comment TEXT
);

CREATE TABLE IF NOT EXISTS sequences (key TEXT PRIMARY KEY, last INTEGER NOT NULL);

-- Credit/debit notes applied to the invoice or bill they correct (+ lowers its balance, − raises it).
CREATE TABLE IF NOT EXISTS doc_adjustments (
  by_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, amount INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS adjustments_source ON doc_adjustments(source_id);

-- Accounts added by the business on top of the jurisdiction's chart.
CREATE TABLE IF NOT EXISTS accounts (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, created_at TEXT NOT NULL
);

-- Use of passwords (not in the journal, like credentials): sign-ins, failed sign-ins, corrections.
CREATE TABLE IF NOT EXISTS auth_log (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, username TEXT NOT NULL, user_id TEXT, ip TEXT, detail TEXT
);
`;

/** Columns added after the first release. Projections are rebuildable, so ADD COLUMN is enough. */
const ADDED_COLUMNS: [table: string, column: string, ddl: string][] = [
  ['items', 'reorder_point', 'REAL'],
  ['documents', 'retention', 'INTEGER'],
  ['documents', 'retention_released_at', 'TEXT'],
  ['payment_allocations', 'refund', 'INTEGER NOT NULL DEFAULT 0'],
];

function ensureColumns(db: DatabaseSync) {
  for (const [table, column, ddl] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;');
  db.exec(DDL);
  ensureColumns(db);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

/** Run `fn` inside one IMMEDIATE transaction (single writer). */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export type Row = Record<string, unknown>;

/** node:sqlite rejects `undefined`/booleans; normalise parameters. */
function bind(params: unknown[]): never[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p)) as never[];
}

const stmtCache = new WeakMap<DatabaseSync, Map<string, ReturnType<DatabaseSync['prepare']>>>();
function prep(db: DatabaseSync, sql: string) {
  let m = stmtCache.get(db);
  if (!m) stmtCache.set(db, (m = new Map()));
  let s = m.get(sql);
  if (!s) m.set(sql, (s = db.prepare(sql)));
  return s;
}

export function all<T = Row>(db: DatabaseSync, sql: string, ...params: unknown[]): T[] {
  return prep(db, sql).all(...bind(params)) as T[];
}

export function one<T = Row>(db: DatabaseSync, sql: string, ...params: unknown[]): T | undefined {
  return prep(db, sql).get(...bind(params)) as T | undefined;
}

export function run(db: DatabaseSync, sql: string, ...params: unknown[]): void {
  prep(db, sql).run(...bind(params));
}
