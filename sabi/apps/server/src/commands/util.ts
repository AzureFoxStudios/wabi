import type { DocLine, GuardContext, Job, Document, Label, SubjectType } from '@sabi/core';
import { computeTotals, measuredQty, roundQty, docType } from '@sabi/core';
import { all, one } from '../db.ts';
import { fail, newId, type Scope } from '../engine.ts';
import { getItem, getJob, getDocument, getParty, settledAmount, heldRetention } from '../repo.ts';

// ───────────────────────────── Input validation ─────────────────────────────

export function str(v: unknown, name: string, opts: { max?: number } = {}): string {
  if (typeof v !== 'string' || !v.trim()) fail('invalid', `${name} is required`, { field: name });
  const s = (v as string).trim();
  if (s.length > (opts.max ?? 500)) fail('invalid', `${name} is too long`, { field: name });
  return s;
}

export function optStr(v: unknown, name: string, max = 2000): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') fail('invalid', `${name} must be text`, { field: name });
  const s = (v as string).trim();
  if (s.length > max) fail('invalid', `${name} is too long`, { field: name });
  return s || undefined;
}

export function num(v: unknown, name: string, opts: { min?: number; int?: boolean } = {}): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) fail('invalid', `${name} must be a number`, { field: name });
  if (opts.int && !Number.isInteger(n)) fail('invalid', `${name} must be a whole number`, { field: name });
  if (opts.min !== undefined && (n as number) < opts.min) fail('invalid', `${name} must be ≥ ${opts.min}`, { field: name });
  return n as number;
}

export function optNum(v: unknown, name: string, opts: { min?: number; int?: boolean } = {}): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return num(v, name, opts);
}

export function date(v: unknown, name: string): string {
  const s = str(v, name, { max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) fail('invalid', `${name} must be a date (YYYY-MM-DD)`, { field: name });
  return s;
}

export function optDate(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return date(v, name);
}

export function oneOf<T extends string>(v: unknown, name: string, allowed: readonly T[]): T {
  if (!allowed.includes(v as T)) fail('invalid', `${name} must be one of ${allowed.join(', ')}`, { field: name });
  return v as T;
}

export function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function addDays(d: string, days: number): string {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

// ───────────────────────────── Subjects ─────────────────────────────

export const SUBJECT_TYPES: readonly SubjectType[] = ['job', 'document', 'party', 'item', 'payment'];

export function assertSubject(s: Scope, type: unknown, id: unknown): { type: SubjectType; id: string } {
  const t = oneOf(type, 'subjectType', SUBJECT_TYPES);
  const sid = str(id, 'subjectId');
  const table = { job: 'jobs', document: 'documents', party: 'parties', item: 'items', payment: 'payments' }[t];
  if (!one(s.db, `SELECT 1 FROM ${table} WHERE id = ?`, sid)) fail('not_found', `${t} not found`, undefined, 404);
  return { type: t, id: sid };
}

export function mustJob(s: Scope, id: unknown): Job {
  const j = getJob(s.db, str(id, 'jobId'));
  if (!j) fail('not_found', 'Job not found', undefined, 404);
  return j!;
}

export function mustDocument(s: Scope, id: unknown): Document {
  const d = getDocument(s.db, str(id, 'documentId'));
  if (!d) fail('not_found', 'Document not found', undefined, 404);
  return d!;
}

export function mustParty(s: Scope, id: unknown) {
  const p = getParty(s.db, str(id, 'partyId'));
  if (!p) fail('not_found', 'Party not found', undefined, 404);
  return p!;
}

// ───────────────────────────── Sequences ─────────────────────────────

export function nextSequence(s: Scope, key: string): number {
  const r = one<{ last: number }>(s.db, 'SELECT last FROM sequences WHERE key = ?', key);
  return (r?.last ?? 0) + 1;
}

export const formatNumber = (prefix: string, year: string, n: number) => `${prefix}${year}-${String(n).padStart(4, '0')}`;

// ───────────────────────────── Guard contexts ─────────────────────────────

function approvalMap(s: Scope, subjectType: string, subjectId: string) {
  const m: Record<string, 'pending' | 'approved' | 'rejected'> = {};
  for (const a of all<{ transition_id: string; state: string }>(s.db,
    "SELECT transition_id, state FROM approvals WHERE subject_type = ? AND subject_id = ? AND state != 'stale' ORDER BY requested_at",
    subjectType, subjectId)) {
    m[a.transition_id] = a.state as 'pending' | 'approved' | 'rejected';
  }
  return m;
}

export function jobGuardContext(s: Scope, job: Job, role: string | null): GuardContext {
  const documents = all<{ type: string; phase: Document['phase'] }>(s.db, 'SELECT type, phase FROM documents WHERE job_id = ?', job.id);
  const open = one<{ n: number }>(s.db, "SELECT COUNT(*) AS n FROM tasks WHERE subject_type = 'job' AND subject_id = ? AND done_at IS NULL", job.id);
  return {
    fields: { ...job.fields, title: job.title, partyId: job.partyId, ownerId: job.ownerId, dueDate: job.dueDate },
    documents,
    openTasks: open?.n ?? 0,
    approvals: approvalMap(s, 'job', job.id),
    role,
    isSuperuser: role === null ? false : s.isSuperuser,
  };
}

export function documentMetrics(doc: Document): Record<string, number> {
  return {
    total: doc.totals.total / 100,
    net: doc.totals.net / 100,
    tax: doc.totals.tax / 100,
    max_discount_pct: doc.totals.maxDiscountPct,
    line_count: doc.lines.length,
  };
}

/** Open balance of an issued receivable/payable document; undefined for documents that carry no money. */
export function outstandingOf(s: Scope, doc: Document): number | undefined {
  const dt = docType(s.pack, doc.type);
  if (!dt.effects.includes('receivable') && !dt.effects.includes('payable')) return undefined;
  if (dt.adjusts) return undefined;
  if (doc.phase !== 'issued' && doc.phase !== 'closed') return undefined;
  return doc.totals.total - heldRetention(doc) - settledAmount(s.db, doc.id);
}

export function documentGuardContext(s: Scope, doc: Document, role: string | null): GuardContext {
  const children = all<{ type: string; phase: Document['phase'] }>(s.db, 'SELECT type, phase FROM documents WHERE source_id = ?', doc.id);
  const open = one<{ n: number }>(s.db, "SELECT COUNT(*) AS n FROM tasks WHERE subject_type = 'document' AND subject_id = ? AND done_at IS NULL", doc.id);
  return {
    fields: { ...doc.fields, partyId: doc.partyId, date: doc.date, dueDate: doc.dueDate, notes: doc.notes },
    documents: children,
    lineCount: doc.lines.length,
    openTasks: open?.n ?? 0,
    metrics: documentMetrics(doc),
    outstanding: outstandingOf(s, doc),
    approvals: approvalMap(s, 'document', doc.id),
    role,
    isSuperuser: role === null ? false : s.isSuperuser,
  };
}

// ───────────────────────────── Lines ─────────────────────────────

/**
 * Normalise client-supplied lines: fill defaults from the item, compute the
 * quantity from a measure template, clamp values. Server is authoritative.
 */
export function normalizeLines(s: Scope, raw: unknown, direction: 'sales' | 'purchase'): DocLine[] {
  if (!Array.isArray(raw)) fail('invalid', 'lines must be a list');
  if ((raw as unknown[]).length > 500) fail('invalid', 'Too many lines');
  return (raw as unknown[]).map((r, idx) => {
    const l = obj(r);
    const item = typeof l.itemId === 'string' && l.itemId ? getItem(s.db, l.itemId) : undefined;
    if (l.itemId && !item) fail('invalid', `Line ${idx + 1}: unknown item`);
    let qty = optNum(l.qty, `Line ${idx + 1} quantity`) ?? 1;
    let measures: Record<string, number> | undefined;
    const tplId = item?.measureTemplate;
    const tpl = tplId ? s.pack.measureTemplates.find((t) => t.id === tplId) : undefined;
    if (tpl && l.measures && typeof l.measures === 'object') {
      measures = {};
      for (const inp of tpl.inputs) {
        const v = optNum((l.measures as Record<string, unknown>)[inp.key], `${inp.label.en}`);
        if (v !== undefined) measures[inp.key] = v;
      }
      if (tpl.inputs.every((i) => measures![i.key] !== undefined)) qty = measuredQty(tpl, measures);
    }
    const defaultPrice = item ? (direction === 'sales' ? item.salePrice : item.costPrice) : 0;
    const unitPrice = Math.round(optNum(l.unitPrice, `Line ${idx + 1} price`) ?? defaultPrice);
    const taxCode = item && s.pack.taxCodeFromItem ? item.taxCode : optStr(l.taxCode, 'taxCode') ?? item?.taxCode ?? s.jur.defaultTaxCode;
    if (!s.jur.taxCodes.some((t) => t.code === taxCode)) fail('invalid', `Line ${idx + 1}: unknown tax code ${taxCode}`);
    const description = optStr(l.description, 'description', 1000) ?? item?.name ?? '';
    if (!description) fail('invalid', `Line ${idx + 1}: description or item is required`);
    return {
      id: typeof l.id === 'string' && /^ln_[a-z0-9]+$/.test(l.id) ? l.id : newId('ln'),
      itemId: item?.id,
      description,
      measures,
      qty: roundQty(qty),
      uom: optStr(l.uom, 'uom', 20) ?? item?.uom ?? 'pc',
      unitPrice,
      discountPct: Math.min(100, Math.max(0, optNum(l.discountPct, 'discount') ?? 0)),
      taxCode,
      whtCategory: optStr(l.whtCategory, 'whtCategory') ?? item?.whtCategory,
      itemKind: item?.kind ?? 'non_stock',
      sourceLineId: typeof l.sourceLineId === 'string' ? l.sourceLineId : undefined,
    } satisfies DocLine;
  });
}

export function totalsFor(s: Scope, lines: DocLine[], priceMode: 'exclusive' | 'inclusive', date: string) {
  return computeTotals(lines, priceMode, date, (c, d) => s.jur.taxRate(c, d));
}

export function docTypeOf(s: Scope, type: string) {
  try {
    return docType(s.pack, type);
  } catch {
    return fail('invalid', `Unknown document type '${type}'`);
  }
}

// ───────────────────────────── System messages ─────────────────────────────

export function systemMessage(s: Scope, subjectType: SubjectType, subjectId: string, label: Label, mentions: string[] = []) {
  s.emit({
    type: 'message.posted',
    subjectType,
    subjectId,
    data: {
      message: {
        id: newId('msg'), subjectType, subjectId, authorId: 'system', body: label.en, label, mentions, fileIds: [],
        createdAt: s.at,
      },
    },
  });
}
