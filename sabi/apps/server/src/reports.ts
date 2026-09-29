/**
 * Read models for books and controls: receipts, withholding certificates,
 * general-ledger detail, the adjustment (corrections) report, stock cards,
 * the sign-in log and a system description (flow, roles, counts).
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Label } from '@sabi/core';
import { docType } from '@sabi/core';
import { all, one, SCHEMA_VERSION } from './db.ts';
import type { Ctx } from './engine.ts';
import { rowToEvent } from './journal.ts';
import { getCompany, getDocument, getParty, getPayment, listUsers } from './repo.ts';
import { allAccounts, correctionsProtected } from './commands/books.ts';

type R = Record<string, any>;

function partyBlock(p: { name: string; taxId?: string; address?: R; phone?: string; fields?: R } | undefined) {
  if (!p) return null;
  return { name: p.name, taxId: p.taxId ?? '', branch: (p.fields?.branch_code as string) ?? '', address: p.address ?? {}, phone: p.phone ?? '' };
}

/** A payment with everything a receipt / payment voucher and a WHT certificate need. */
export function paymentView(ctx: Ctx, id: string) {
  const { db, jur, pack } = ctx;
  const p = getPayment(db, id);
  if (!p) return null;
  const party = getParty(db, p.partyId);
  const company = getCompany(db);
  const allocations = p.allocations.map((a) => {
    const d = getDocument(db, a.documentId);
    const dt = d ? docType(pack, d.type) : undefined;
    return { ...a, number: d?.number ?? null, type: d?.type ?? null, typeLabel: dt?.label ?? null, date: d?.date ?? null, total: d?.totals.total ?? 0, net: d?.totals.net ?? 0 };
  });
  const cat = jur.whtCategories.find((c) => c.id === p.whtCategory);
  // Whoever pays withholds and issues the certificate: us for money out, the customer for money in.
  const us = partyBlock({ ...company, fields: company.fields });
  const them = partyBlock(party);
  const wht = p.whtAmount ? {
    category: p.whtCategory ?? null, label: cat?.label ?? null, rate: cat?.rate ?? null,
    base: cat?.rate ? Math.round(p.whtAmount / cat.rate) : allocations.reduce((a, x) => a + x.net, 0),
    amount: p.whtAmount, certificate: p.whtCertificate ?? null,
    payer: p.direction === 'out' ? us : them, payee: p.direction === 'out' ? them : us,
    form: p.direction === 'out' ? (party?.kind === 'person' ? 'PND3' : 'PND53') : null,
    weIssue: p.direction === 'out',
    words: jur.amountInWords(p.whtAmount, 'th'),
  } : null;
  const createdBy = one<{ name: string }>(db, 'SELECT name FROM users WHERE id = ?', p.createdBy)?.name ?? '';
  return {
    payment: p, party, allocations, wht, createdBy,
    refund: p.allocations.length > 0 && p.allocations.every((a) => a.refund),
    method: pack.paymentMethods.find((m) => m.id === p.method)?.label ?? { en: p.method },
    seller: us, buyer: them,
    words: { th: jur.amountInWords(p.amount, 'th'), en: jur.amountInWords(p.amount, 'en') },
  };
}

/** Every line posted to one account in a period, with opening and running balance. */
export function ledgerDetail(ctx: Ctx, account: string, from?: string, to?: string) {
  const { db, jur } = ctx;
  const acc = allAccounts({ db, jur }).find((a) => a.code === account);
  if (!acc) return null;
  const opening = from
    ? one<{ b: number | null }>(db, 'SELECT SUM(debit - credit) AS b FROM ledger_lines WHERE account = ? AND date < ?', account, from)?.b ?? 0
    : 0;
  let running = opening;
  const parties = new Map(all<{ id: string; name: string }>(db, 'SELECT id, name FROM parties').map((r) => [r.id, r.name]));
  const lines = all<R>(db,
    `SELECT l.entry_id, l.idx, l.date, l.debit, l.credit, l.party_id, e.memo, e.source_type, e.source_id, e.reversal_of, e.reversed_by
     FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account = ? AND (? IS NULL OR l.date >= ?) AND (? IS NULL OR l.date <= ?)
     ORDER BY l.date, e.rowid, l.idx`, account, from ?? null, from ?? null, to ?? null, to ?? null)
    .map((l) => {
      running += l.debit - l.credit;
      return {
        entryId: l.entry_id, date: l.date, memo: l.memo, debit: l.debit, credit: l.credit, balance: running,
        partyName: l.party_id ? parties.get(l.party_id) ?? '' : '', source: { type: l.source_type, id: l.source_id },
        reversal: !!l.reversal_of, reversed: !!l.reversed_by,
      };
    });
  return { account: acc, from: from ?? null, to: to ?? null, opening, closing: running, lines };
}

/** Manual journal entries (newest first) so they can be reviewed and reversed. */
export function manualEntries(ctx: Ctx) {
  const { db } = ctx;
  return all<R>(db, "SELECT * FROM journal_entries WHERE source_type = 'manual' ORDER BY date DESC, rowid DESC LIMIT 500").map((e) => ({
    id: e.id, date: e.date, memo: e.memo, reversalOf: e.reversal_of, reversedBy: e.reversed_by,
    lines: all<R>(db, 'SELECT account, debit, credit, party_id FROM ledger_lines WHERE entry_id = ? ORDER BY idx', e.id)
      .map((l) => ({ account: l.account, debit: l.debit, credit: l.credit, partyId: l.party_id })),
  }));
}

/**
 * The corrections report: every change made after something was issued or
 * posted — voided documents and payments, credit/debit notes, manual and
 * reversing journal entries — with reference, date and time, user, amount.
 * It is derived from the append-only journal, so it cannot be edited or hidden.
 */
export function adjustmentsReport(ctx: Ctx, from?: string, to?: string) {
  const { db, pack } = ctx;
  const users = new Map(all<{ id: string; name: string; username: string }>(db, 'SELECT id, name, username FROM users').map((u) => [u.id, u]));
  const rows: { seq: number; at: string; user: string; username: string; kind: string; label: Label; reference: string; subject: { type: string; id: string } | null; amount: number; reason: string }[] = [];
  const events = all<R>(db,
    `SELECT * FROM events WHERE type IN ('document.transitioned','payment.voided','document.applied','ledger.posted')
     AND (? IS NULL OR substr(at,1,10) >= ?) AND (? IS NULL OR substr(at,1,10) <= ?) ORDER BY seq`,
    from ?? null, from ?? null, to ?? null, to ?? null).map((r) => rowToEvent(r as never));
  for (const e of events) {
    const d = e.data as R;
    const who = users.get(e.actorId);
    const base = { seq: e.seq, at: e.at, user: who?.name ?? e.actorId, username: who?.username ?? '' };
    if (e.type === 'document.transitioned' && d.phase === 'void') {
      const doc = getDocument(db, d.id);
      if (!doc?.number) continue; // drafts discarded before issue are not corrections
      rows.push({ ...base, kind: 'void_document', label: { en: 'Voided document', th: 'ยกเลิกเอกสาร' }, reference: doc.number, subject: { type: 'document', id: doc.id }, amount: doc.totals.total, reason: d.reason ?? '' });
    } else if (e.type === 'payment.voided') {
      const p = getPayment(db, d.id);
      rows.push({ ...base, kind: 'void_payment', label: { en: 'Voided payment', th: 'ยกเลิกการรับ/จ่ายเงิน' }, reference: p?.number ?? d.id, subject: { type: 'payment', id: d.id }, amount: p?.amount ?? 0, reason: d.reason ?? '' });
    } else if (e.type === 'document.applied') {
      const by = getDocument(db, d.byId);
      const src = getDocument(db, d.sourceId);
      const dt = by ? docType(pack, by.type) : undefined;
      rows.push({ ...base, kind: d.amount >= 0 ? 'credit_note' : 'debit_note', label: dt?.label ?? { en: 'Note' },
        reference: `${by?.number ?? ''} → ${src?.number ?? ''}`, subject: { type: 'document', id: d.byId }, amount: d.amount, reason: String(by?.fields.reason ?? '') });
    } else if (e.type === 'ledger.posted') {
      const en = d.entry;
      if (en.source.type !== 'manual' && !(en.reversalOf && en.source.type === 'manual')) continue;
      const amt = en.lines.reduce((a: number, l: R) => a + l.debit, 0);
      rows.push({ ...base, kind: en.reversalOf ? 'reverse_entry' : 'manual_entry',
        label: en.reversalOf ? { en: 'Reversed journal entry', th: 'กลับรายการบัญชี' } : { en: 'Manual journal entry', th: 'บันทึกบัญชีด้วยมือ' },
        reference: en.id, subject: null, amount: amt, reason: en.memo });
    }
  }
  const counts: Record<string, { count: number; amount: number }> = {};
  for (const r of rows) {
    const c = (counts[r.kind] ??= { count: 0, amount: 0 });
    c.count += 1;
    c.amount += r.amount;
  }
  return { from: from ?? null, to: to ?? null, rows: rows.reverse(), counts };
}

/** Stock card: every movement of one item through internal locations with a running balance. */
export function stockCard(ctx: Ctx, itemId: string, from?: string, to?: string) {
  const { db, pack } = ctx;
  const item = one<R>(db, 'SELECT id, sku, name, uom FROM items WHERE id = ?', itemId);
  if (!item) return null;
  const internal = new Set(pack.locations.filter((l) => l.kind === 'internal').map((l) => l.id));
  const signed = (m: R) => (internal.has(m.to_loc) ? m.qty : 0) - (internal.has(m.from_loc) ? m.qty : 0);
  const moves = all<R>(db,
    `SELECT m.*, d.number AS doc_number, d.type AS doc_type, j.number AS job_number, u.name AS by_name FROM stock_moves m
     LEFT JOIN documents d ON d.id = m.document_id LEFT JOIN jobs j ON j.id = m.job_id LEFT JOIN users u ON u.id = m.by
     WHERE m.item_id = ? ORDER BY m.at, m.rowid`, itemId);
  let balance = 0;
  let opening = 0;
  const lines: R[] = [];
  for (const m of moves) {
    const q = signed(m);
    const day = String(m.at).slice(0, 10);
    if (from && day < from) {
      opening += q;
      balance += q;
      continue;
    }
    if (to && day > to) break;
    balance += q;
    if (q === 0 && !(internal.has(m.from_loc) && internal.has(m.to_loc))) continue;
    lines.push({
      at: m.at, in: q > 0 ? q : 0, out: q < 0 ? -q : 0, balance, from: m.from_loc, to: m.to_loc, transfer: q === 0,
      qty: m.qty, reference: m.doc_number ?? m.job_number ?? '', document: m.document_id ? { id: m.document_id, type: m.doc_type } : null,
      jobId: m.job_id, note: m.note ?? '', by: m.by_name ?? '',
    });
  }
  return { item, opening, closing: balance, lines };
}

export function authLog(ctx: Ctx, limit = 500) {
  return all<R>(ctx.db, 'SELECT * FROM auth_log ORDER BY id DESC LIMIT ?', Math.min(limit, 2000));
}

/**
 * What the system is and who may do what: the processing flow, the roles with
 * their capabilities and head count, and the size of each part of the journal.
 */
export function systemInfo(ctx: Ctx) {
  const { db, pack, jur, dataDir } = ctx;
  const users = listUsers(db);
  const roles = pack.roles.map((r) => ({
    id: r.id, label: r.label, capabilities: r.capabilities,
    users: users.filter((u) => u.role === r.id && u.active).map((u) => ({ id: u.id, name: u.name, username: u.username })),
  }));
  const events = all<{ type: string; n: number }>(db, 'SELECT type, COUNT(*) AS n FROM events GROUP BY type ORDER BY type');
  const head = one<{ seq: number; hash: string; at: string }>(db, 'SELECT seq, hash, at FROM events ORDER BY seq DESC LIMIT 1');
  let dbBytes = 0;
  try {
    dbBytes = statSync(join(dataDir, 'sabi.db')).size;
  } catch {
    /* in-memory database */
  }
  const capabilities = ['all', 'jobs.write', 'documents.write', 'documents.issue', 'documents.void', 'money.write', 'stock.write', 'parties.write', 'items.write', 'settings.write', 'ledger.write', 'reports.read', 'approve'];
  return {
    pack: { id: pack.id, label: pack.label, documentTypes: pack.documentTypes.map((d) => ({ id: d.id, label: d.label, direction: d.direction, effects: d.effects, convertsTo: d.convertsTo, adjusts: d.adjusts ?? null })) },
    jurisdiction: { id: jur.id, label: jur.label, accounts: allAccounts({ db, jur }).length },
    roles, capabilities, events, head, schemaVersion: SCHEMA_VERSION, dbBytes,
    correctionsProtected: correctionsProtected({ db }),
    counts: {
      users: users.filter((u) => u.active).length,
      documents: one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM documents')?.n ?? 0,
      entries: one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM journal_entries')?.n ?? 0,
    },
  };
}
