/** Read-side helpers: SQL rows → core records. */
import type { DatabaseSync } from 'node:sqlite';
import type {
  Approval, Document, DocLine, FileRecord, Item, Job, Message, Party, Payment, StockMove, Task, Address, PartySnapshot,
} from '@sabi/core';
import { all, one } from './db.ts';

type R = Record<string, any>;
const j = <T>(v: unknown, fallback: T): T => (typeof v === 'string' && v ? (JSON.parse(v) as T) : fallback);
const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

export interface Company {
  name: string;
  taxId?: string;
  phone?: string;
  email?: string;
  address?: Address;
  fields: Record<string, unknown>;
}

export interface UserRecord {
  id: string;
  name: string;
  username: string;
  role: string;
  locale: 'en' | 'th';
  active: boolean;
  createdAt: string;
}

export const toUser = (r: R): UserRecord => ({
  id: r.id, name: r.name, username: r.username, role: r.role, locale: r.locale, active: !!r.active, createdAt: r.created_at,
});

export const toParty = (r: R): Party => ({
  id: r.id, kind: r.kind, name: r.name, roles: j(r.roles, []), taxId: opt(r.tax_id), phone: opt(r.phone),
  email: opt(r.email), address: j(r.address, undefined), parentId: opt(r.parent_id),
  paymentTermsDays: opt(r.payment_terms_days), creditLimit: opt(r.credit_limit), fields: j(r.fields, {}),
  archived: !!r.archived, createdAt: r.created_at, updatedAt: r.updated_at,
});

export const toItem = (r: R): Item => ({
  id: r.id, sku: r.sku, name: r.name, kind: r.kind, uom: r.uom, salePrice: r.sale_price, costPrice: r.cost_price,
  taxCode: r.tax_code, whtCategory: opt(r.wht_category), measureTemplate: opt(r.measure_template),
  fields: j(r.fields, {}), active: !!r.active, createdAt: r.created_at, updatedAt: r.updated_at,
});

export const toJob = (r: R): Job => ({
  id: r.id, number: r.number, type: r.type, title: r.title, partyId: r.party_id, contactId: opt(r.contact_id),
  ownerId: opt(r.owner_id), state: r.state, phase: r.phase, dueDate: opt(r.due_date), fields: j(r.fields, {}),
  createdAt: r.created_at, updatedAt: r.updated_at, closedAt: opt(r.closed_at),
});

export const toLine = (r: R): DocLine => ({
  id: r.id, itemId: opt(r.item_id), description: r.description, measures: j(r.measures, undefined), qty: r.qty,
  uom: r.uom, unitPrice: r.unit_price, discountPct: r.discount_pct, taxCode: r.tax_code,
  whtCategory: opt(r.wht_category), itemKind: opt(r.item_kind), sourceLineId: opt(r.source_line_id),
});

export function toDocument(r: R, lines: DocLine[]): Document {
  return {
    id: r.id, type: r.type, number: opt(r.number), state: r.state, phase: r.phase, partyId: r.party_id,
    jobId: opt(r.job_id), sourceId: opt(r.source_id), date: r.date, dueDate: opt(r.due_date), priceMode: r.price_mode,
    lines, notes: opt(r.notes), fields: j(r.fields, {}), totals: j(r.totals, null as never),
    partySnapshot: j<PartySnapshot | undefined>(r.party_snapshot, undefined),
    sellerSnapshot: j<PartySnapshot | undefined>(r.seller_snapshot, undefined),
    issuedAt: opt(r.issued_at), issuedBy: opt(r.issued_by), voidReason: opt(r.void_reason),
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export const toTask = (r: R): Task => ({
  id: r.id, subjectType: r.subject_type, subjectId: r.subject_id, title: r.title, assigneeId: opt(r.assignee_id),
  role: opt(r.role), due: opt(r.due), doneAt: opt(r.done_at), doneBy: opt(r.done_by), createdBy: r.created_by,
  createdAt: r.created_at,
});

export const toMessage = (r: R): Message & { seq: number; label?: import('@sabi/core').Label } => ({
  id: r.id, seq: r.seq, label: j<{ label?: import('@sabi/core').Label }>(r.meta, {}).label, subjectType: r.subject_type, subjectId: r.subject_id, authorId: r.author_id, body: r.body,
  mentions: j(r.mentions, []), fileIds: j(r.file_ids, []), createdAt: r.created_at,
});

export const toFile = (r: R): FileRecord => ({
  id: r.id, sha256: r.sha256, name: r.name, mime: r.mime, size: r.size, subjectType: r.subject_type,
  subjectId: r.subject_id, uploadedBy: r.uploaded_by, createdAt: r.created_at,
});

export const toApproval = (r: R): Approval => ({
  id: r.id, subjectType: r.subject_type, subjectId: r.subject_id, transitionId: r.transition_id, role: r.role,
  reason: opt(r.reason), state: r.state, requestedBy: r.requested_by, requestedAt: r.requested_at,
  decidedBy: opt(r.decided_by), decidedAt: opt(r.decided_at), comment: opt(r.comment),
});

export const toMove = (r: R): StockMove => ({
  id: r.id, itemId: r.item_id, qty: r.qty, from: r.from_loc, to: r.to_loc, documentId: opt(r.document_id),
  jobId: opt(r.job_id), lineId: opt(r.line_id), note: opt(r.note), at: r.at, by: r.by,
});

export function toPayment(r: R, allocations: Payment['allocations']): Payment {
  return {
    id: r.id, number: r.number, direction: r.direction, partyId: r.party_id, date: r.date, method: r.method,
    amount: r.amount, whtAmount: r.wht_amount, whtCategory: opt(r.wht_category), whtCertificate: opt(r.wht_certificate),
    reference: opt(r.reference), allocations, voided: !!r.voided, voidReason: opt(r.void_reason),
    createdBy: r.created_by, createdAt: r.created_at,
  };
}

// ───────────────────────────── Getters ─────────────────────────────

export function getCompany(db: DatabaseSync): Company {
  const r = one<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'company'");
  return r ? JSON.parse(r.value) : { name: '', fields: {} };
}

export function getUser(db: DatabaseSync, id: string): UserRecord | undefined {
  const r = one(db, 'SELECT * FROM users WHERE id = ?', id);
  return r ? toUser(r) : undefined;
}

export function listUsers(db: DatabaseSync): UserRecord[] {
  return all(db, 'SELECT * FROM users ORDER BY created_at').map(toUser);
}

export function getParty(db: DatabaseSync, id: string): Party | undefined {
  const r = one(db, 'SELECT * FROM parties WHERE id = ?', id);
  return r ? toParty(r) : undefined;
}

export function getItem(db: DatabaseSync, id: string): Item | undefined {
  const r = one(db, 'SELECT * FROM items WHERE id = ?', id);
  return r ? toItem(r) : undefined;
}

export function getJob(db: DatabaseSync, id: string): Job | undefined {
  const r = one(db, 'SELECT * FROM jobs WHERE id = ?', id);
  return r ? toJob(r) : undefined;
}

export function linesOf(db: DatabaseSync, documentId: string): DocLine[] {
  return all(db, 'SELECT * FROM document_lines WHERE document_id = ? ORDER BY position', documentId).map(toLine);
}

export function getDocument(db: DatabaseSync, id: string): Document | undefined {
  const r = one(db, 'SELECT * FROM documents WHERE id = ?', id);
  return r ? toDocument(r, linesOf(db, id)) : undefined;
}

export function documentsWhere(db: DatabaseSync, where: string, ...params: unknown[]): Document[] {
  return all(db, `SELECT * FROM documents WHERE ${where} ORDER BY date, created_at`, ...params).map((r) =>
    toDocument(r, linesOf(db, r.id as string)),
  );
}

export function getPayment(db: DatabaseSync, id: string): Payment | undefined {
  const r = one(db, 'SELECT * FROM payments WHERE id = ?', id);
  if (!r) return undefined;
  const allocs = all<{ document_id: string; amount: number }>(db, 'SELECT * FROM payment_allocations WHERE payment_id = ?', id);
  return toPayment(r, allocs.map((a) => ({ documentId: a.document_id, amount: a.amount })));
}

export function tasksOf(db: DatabaseSync, subjectType: string, subjectId: string): Task[] {
  return all(db, 'SELECT * FROM tasks WHERE subject_type = ? AND subject_id = ? ORDER BY done_at IS NOT NULL, due IS NULL, due, created_at', subjectType, subjectId).map(toTask);
}

/** Settled amount (money + WHT) allocated to a document by non-void payments. */
export function settledAmount(db: DatabaseSync, documentId: string): number {
  const r = one<{ s: number | null }>(db,
    'SELECT SUM(a.amount) AS s FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.document_id = ? AND p.voided = 0',
    documentId);
  return r?.s ?? 0;
}

/** On-hand quantity per internal location for one item. */
export function onHandByLocation(db: DatabaseSync, itemId: string, internal: string[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(internal.map((l) => [l, 0]));
  for (const r of all<{ loc: string; q: number }>(db,
    `SELECT to_loc AS loc, SUM(qty) AS q FROM stock_moves WHERE item_id = ? GROUP BY to_loc
     UNION ALL SELECT from_loc AS loc, -SUM(qty) AS q FROM stock_moves WHERE item_id = ? GROUP BY from_loc`, itemId, itemId)) {
    if (r.loc in out) out[r.loc] = Math.round((out[r.loc] + r.q) * 1000) / 1000;
  }
  return out;
}
