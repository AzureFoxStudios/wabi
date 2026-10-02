/**
 * Accounting corrections, retention, business settings and bulk import.
 *
 * Corrections (voiding issued documents or payments, manual and reversing
 * journal entries) can be protected by a separate "corrections password",
 * held outside the journal like login credentials. Its use is logged in
 * `auth_log`; what was corrected is in the journal itself with the actor.
 */
import type { AccountDef, JournalLine } from '@sabi/core';
import { docType, manualEntry, postRetentionRelease, reverse } from '@sabi/core';
import { verifyPassword } from '../auth.ts';
import { all, one, run } from '../db.ts';
import { fail, newId, type Handler, type Scope } from '../engine.ts';
import { getDocument } from '../repo.ts';
import { date, mustDocument, obj, oneOf, optStr, str } from './util.ts';

// ───────────────────────────── Corrections password ─────────────────────────────

export const CORRECTIONS_KEY = 'corrections_password';

export function correctionsProtected(s: { db: Scope['db'] }): boolean {
  return !!one(s.db, 'SELECT 1 FROM local_state WHERE key = ?', CORRECTIONS_KEY);
}

/** Demand the corrections password when one is set; record that it was used. */
export function requireCorrection(s: Scope, input: Record<string, unknown>, what: string): void {
  if (s.actor.system) return;
  const row = one<{ value: string }>(s.db, 'SELECT value FROM local_state WHERE key = ?', CORRECTIONS_KEY);
  if (!row) return;
  const given = typeof input.correctionsPassword === 'string' ? input.correctionsPassword : '';
  if (!given || !verifyPassword(given, row.value)) {
    fail('corrections_password', 'This is a correction. Enter the corrections password.', { field: 'correctionsPassword' }, 403);
  }
  run(s.db, 'INSERT INTO auth_log (at, kind, username, user_id, ip, detail) VALUES (?,?,?,?,?,?)',
    s.at, 'correction', s.actor.name, s.actor.id, null, what);
}

// ───────────────────────────── Chart of accounts ─────────────────────────────

export function allAccounts(s: { db: Scope['db']; jur: Scope['jur'] }): AccountDef[] {
  const custom = all<{ code: string; name: string; type: AccountDef['type'] }>(s.db, 'SELECT code, name, type FROM accounts ORDER BY code')
    .map((r) => ({ code: r.code, name: JSON.parse(r.name), type: r.type }));
  return [...s.jur.chartOfAccounts, ...custom].sort((a, b) => a.code.localeCompare(b.code));
}

const accountCreate: Handler = (s, input) => {
  s.require('ledger.write');
  const code = str(input.code, 'code', { max: 12 });
  if (!/^[0-9A-Za-z.-]{1,12}$/.test(code)) fail('invalid', 'Use digits and letters for the code', { field: 'code' });
  if (allAccounts(s).some((a) => a.code === code)) fail('conflict', 'That code is already in the chart', { field: 'code' }, 409);
  const type = oneOf(input.type, 'type', ['asset', 'liability', 'equity', 'income', 'expense'] as const);
  const en = str(input.nameEn ?? input.name, 'name', { max: 120 });
  const th = optStr(input.nameTh, 'nameTh', 120);
  const account: AccountDef = { code, type, name: th ? { en, th } : { en } };
  s.emit({ type: 'account.created', subjectType: 'settings', subjectId: 'accounts', data: { account } });
  return { code };
};

// ───────────────────────────── Manual journal entries ─────────────────────────────

const journalPost: Handler = (s, input) => {
  s.require('ledger.write');
  const entryDate = date(input.date ?? s.today(), 'date');
  const memo = str(input.memo, 'memo', { max: 300 });
  const codes = new Set(allAccounts(s).map((a) => a.code));
  const raw = (Array.isArray(input.lines) ? input.lines : []).map((l: unknown, i: number): JournalLine => {
    const o = obj(l);
    const account = str(o.account, `line ${i + 1} account`);
    if (!codes.has(account)) fail('invalid', `Line ${i + 1}: unknown account ${account}`);
    const partyId = optStr(o.partyId, 'partyId');
    if (partyId && !one(s.db, 'SELECT 1 FROM parties WHERE id = ?', partyId)) fail('invalid', `Line ${i + 1}: unknown party`);
    return { account, debit: Math.round(Number(o.debit) || 0), credit: Math.round(Number(o.credit) || 0), ...(partyId ? { partyId } : {}) };
  });
  requireCorrection(s, input, `journal entry: ${memo}`);
  const id = newId('je');
  let entry;
  try {
    entry = manualEntry(id, entryDate, memo, raw);
  } catch (e) {
    fail('unbalanced', (e as Error).message, undefined, 422);
  }
  s.emit({ type: 'ledger.posted', subjectType: 'system', subjectId: id, data: { entry } });
  return { id };
};

const journalReverse: Handler = (s, input) => {
  s.require('ledger.write');
  const id = str(input.id, 'id');
  const e = one<{ id: string; date: string; memo: string; source_type: string; source_id: string; reversal_of: string | null; reversed_by: string | null }>(
    s.db, 'SELECT * FROM journal_entries WHERE id = ?', id);
  if (!e) fail('not_found', 'Entry not found', undefined, 404);
  if (e!.source_type !== 'manual') fail('invalid', 'Entries from documents and payments are reversed by voiding the document or payment');
  if (e!.reversal_of || e!.reversed_by) fail('invalid_state', 'This entry is already a reversal or reversed', undefined, 409);
  const reason = str(input.reason, 'reason', { max: 300 });
  requireCorrection(s, input, `reverse ${e!.memo}: ${reason}`);
  const lines = all<{ account: string; debit: number; credit: number; party_id: string | null }>(s.db,
    'SELECT account, debit, credit, party_id FROM ledger_lines WHERE entry_id = ? ORDER BY idx', id)
    .map((l) => ({ account: l.account, debit: l.debit, credit: l.credit, ...(l.party_id ? { partyId: l.party_id } : {}) }));
  const rev = reverse({ id, date: e!.date, memo: e!.memo, source: { type: 'manual', id: e!.source_id }, lines }, newId('je'), s.today());
  rev.memo = `${rev.memo} — ${reason}`;
  s.emit({ type: 'ledger.posted', subjectType: 'system', subjectId: rev.id, data: { entry: rev } });
  return { id: rev.id };
};

// ───────────────────────────── Retention ─────────────────────────────

const releaseRetention: Handler = (s, input) => {
  s.require('money.write');
  const doc = mustDocument(s, input.id);
  const dt = docType(s.pack, doc.type);
  if (!doc.retention) fail('invalid', 'No retention is held on this document');
  if (doc.retentionReleasedAt) fail('invalid_state', 'Retention was already released', undefined, 409);
  if (doc.phase !== 'issued' && doc.phase !== 'closed') fail('invalid_state', 'The document is not issued', undefined, 409);
  const when = date(input.date ?? s.today(), 'date');
  s.emit({ type: 'document.retention_released', subjectType: 'document', subjectId: doc.id, data: { id: doc.id, amount: doc.retention, date: when } });
  s.emit({ type: 'ledger.posted', subjectType: 'document', subjectId: doc.id, data: { entry: postRetentionRelease(getDocument(s.db, doc.id)!, dt, s.jur.postingAccounts, newId('je'), when) } });
  return { id: doc.id };
};

// ───────────────────────────── Settings ─────────────────────────────

/** Business settings that live in the journal (so they replicate and export). */
const SETTINGS: Record<string, (v: unknown) => unknown> = {
  // Outgoing webhook: POST of committed event summaries. The secret signs the body (HMAC-SHA256).
  webhook: (v) => {
    const o = obj(v);
    const url = optStr(o.url, 'url', 500);
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) fail('invalid', 'Enter an http(s) URL', { field: 'url' });
    return url ? { url, secret: optStr(o.secret, 'secret', 200) } : null;
  },
  // Text shown on the sign-in screen, e.g. a software statement required by a tax authority.
  signInNotice: (v) => optStr(v, 'signInNotice', 1000) ?? null,
};

const settingsUpdate: Handler = (s, input) => {
  s.require('settings.write');
  const key = oneOf(input.key, 'key', Object.keys(SETTINGS));
  const value = SETTINGS[key](input.value);
  s.emit({ type: 'settings.updated', subjectType: 'settings', subjectId: key, data: { key, value } });
  return { key };
};

// ───────────────────────────── Import ─────────────────────────────

/**
 * Import many rows through the ordinary create command, all-or-nothing:
 * every row is validated exactly as a hand-entered record would be, and a
 * single bad row rolls back the batch with a per-row error list.
 */
function importVia(handler: Handler, cap: 'parties.write' | 'items.write', max = 2000): Handler {
  return (s, input) => {
    s.require(cap);
    const rows = Array.isArray(input.rows) ? input.rows : [];
    if (!rows.length) fail('invalid', 'Nothing to import');
    if (rows.length > max) fail('invalid', `At most ${max} rows at a time`);
    const errors: { row: number; message: string }[] = [];
    let created = 0;
    rows.forEach((r: unknown, i: number) => {
      try {
        handler(s, obj(r));
        created += 1;
      } catch (e) {
        errors.push({ row: i + 1, message: (e as Error).message });
      }
    });
    if (errors.length) fail('import_failed', `${errors.length} row(s) have problems; nothing was imported`, { errors: errors.slice(0, 50) }, 422);
    return { created };
  };
}

export function booksCommands(create: { party: Handler; item: Handler }): Record<string, Handler> {
  return {
    'account.create': accountCreate,
    'journal.post': journalPost,
    'journal.reverse': journalReverse,
    'document.releaseRetention': releaseRetention,
    'settings.update': settingsUpdate,
    'import.parties': importVia(create.party, 'parties.write'),
    'import.items': importVia(create.item, 'items.write'),
  };
}
