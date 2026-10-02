/**
 * Command handlers. Each command validates input against current state and
 * emits events; nothing else writes to projection tables.
 */
import type { Document, Item, Job, Party, Payment, PaymentAllocation, StockMove } from '@sabi/core';
import { VIRTUAL_LOCATIONS, checkGuard, docType, jobType, openLines, postPayment, transitionsFrom } from '@sabi/core';
import { all, one } from '../db.ts';
import { fail, newId, type Handler, type Registry, type Scope } from '../engine.ts';
import { getCompany, getDocument, getItem, getParty, getPayment, getUser } from '../repo.ts';
import {
  addDays, assertSubject, date, docTypeOf, documentGuardContext, formatNumber, mustDocument, mustJob, mustParty,
  nextSequence, normalizeLines, num, obj, oneOf, optDate, optNum, optStr, outstandingOf, str, systemMessage, totalsFor,
} from './util.ts';
import { reverseLedger, settle, transitionDocument, transitionJob } from './workflow.ts';
import { booksCommands, requireCorrection } from './books.ts';

// ───────────────────────────── Company & users ─────────────────────────────

function cleanAddress(v: unknown) {
  const a = obj(v);
  const out: Record<string, string> = {};
  for (const k of ['line1', 'line2', 'district', 'province', 'postcode', 'country']) {
    const s = optStr(a[k], `address.${k}`, 300);
    if (s) out[k] = s;
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanFields(v: unknown): Record<string, unknown> {
  const f = obj(v);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(f)) {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(k)) continue;
    if (val === null || val === '' || val === undefined) continue;
    if (typeof val === 'string') out[k] = val.slice(0, 4000);
    else if (typeof val === 'number' && Number.isFinite(val)) out[k] = val;
    else if (typeof val === 'boolean') out[k] = val;
  }
  return out;
}

const companyUpdate: Handler = (s, input) => {
  s.require('settings.write');
  const cur = getCompany(s.db);
  const taxId = optStr(input.taxId, 'taxId', 20)?.replace(/\D/g, '');
  if (taxId && !s.jur.validateTaxId(taxId)) fail('invalid', 'Tax ID is not valid', { field: 'taxId' });
  const company = {
    name: input.name !== undefined ? str(input.name, 'name') : cur.name,
    taxId: input.taxId !== undefined ? taxId : cur.taxId,
    phone: input.phone !== undefined ? optStr(input.phone, 'phone', 50) : cur.phone,
    email: input.email !== undefined ? optStr(input.email, 'email', 200) : cur.email,
    address: input.address !== undefined ? cleanAddress(input.address) : cur.address,
    fields: input.fields !== undefined ? { ...cur.fields, ...cleanFields(input.fields) } : cur.fields,
  };
  s.emit({ type: 'company.updated', subjectType: 'settings', subjectId: 'company', data: { company } });
  return company;
};

const userCreate: Handler = (s, input) => {
  if (!s.actor.system) s.require('settings.write');
  const username = str(input.username, 'username', { max: 40 }).toLowerCase();
  if (!/^[a-z0-9_.-]{2,40}$/.test(username)) fail('invalid', 'Username may use a–z, 0–9, dot, dash, underscore', { field: 'username' });
  if (one(s.db, 'SELECT 1 FROM users WHERE username = ?', username)) fail('conflict', 'Username is taken', { field: 'username' }, 409);
  const role = oneOf(input.role, 'role', s.pack.roles.map((r) => r.id));
  const user = {
    id: typeof input.id === 'string' && s.actor.system ? input.id : newId('usr'),
    name: str(input.name, 'name', { max: 100 }),
    username,
    role,
    locale: input.locale === 'en' ? 'en' : 'th',
    active: true,
    createdAt: s.at,
  };
  s.emit({ type: 'user.created', subjectType: 'user', subjectId: user.id, data: { user } });
  return user;
};

const userUpdate: Handler = (s, input) => {
  const id = str(input.id, 'id');
  const self = id === s.actor.id;
  const u = getUser(s.db, id);
  if (!u) fail('not_found', 'User not found', undefined, 404);
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = str(input.name, 'name', { max: 100 });
  if (input.locale !== undefined) patch.locale = input.locale === 'en' ? 'en' : 'th';
  if (input.role !== undefined || input.active !== undefined) {
    s.require('settings.write');
    if (input.role !== undefined) patch.role = oneOf(input.role, 'role', s.pack.roles.map((r) => r.id));
    if (input.active !== undefined) patch.active = !!input.active;
    if (self && (patch.active === false || (patch.role && patch.role !== 'owner' && u!.role === 'owner'))) {
      fail('invalid', 'You cannot demote or deactivate yourself');
    }
  } else if (!self) s.require('settings.write');
  s.emit({ type: 'user.updated', subjectType: 'user', subjectId: id, data: { id, patch } });
  return { id };
};

// ───────────────────────────── Parties & items ─────────────────────────────

function partyInput(s: Scope, input: Record<string, any>, partial: boolean): Partial<Party> {
  const out: Partial<Party> = {};
  if (!partial || input.kind !== undefined) out.kind = oneOf(input.kind ?? 'organization', 'kind', ['person', 'organization'] as const);
  if (!partial || input.name !== undefined) out.name = str(input.name, 'name', { max: 200 });
  if (!partial || input.roles !== undefined) {
    const roles = Array.isArray(input.roles) ? input.roles.filter((r: unknown) => typeof r === 'string').slice(0, 10) : [];
    out.roles = [...new Set(roles as string[])];
  }
  if (input.taxId !== undefined) {
    const t = optStr(input.taxId, 'taxId', 20)?.replace(/\D/g, '');
    if (t && !s.jur.validateTaxId(t)) fail('invalid', 'Tax ID is not valid', { field: 'taxId' });
    out.taxId = t;
  }
  if (input.phone !== undefined) out.phone = optStr(input.phone, 'phone', 50);
  if (input.email !== undefined) out.email = optStr(input.email, 'email', 200);
  if (input.address !== undefined) out.address = cleanAddress(input.address);
  if (input.parentId !== undefined) {
    out.parentId = optStr(input.parentId, 'parentId');
    if (out.parentId) mustParty(s, out.parentId);
  }
  if (input.paymentTermsDays !== undefined) out.paymentTermsDays = optNum(input.paymentTermsDays, 'paymentTermsDays', { min: 0, int: true });
  if (input.creditLimit !== undefined) out.creditLimit = optNum(input.creditLimit, 'creditLimit', { min: 0, int: true });
  if (input.archived !== undefined) out.archived = !!input.archived;
  return out;
}

const partyCreate: Handler = (s, input) => {
  s.require('parties.write');
  const base = partyInput(s, input, false);
  const party: Party = {
    id: newId('pty'), kind: base.kind!, name: base.name!, roles: base.roles ?? [], taxId: base.taxId, phone: base.phone,
    email: base.email, address: base.address, parentId: base.parentId, paymentTermsDays: base.paymentTermsDays,
    creditLimit: base.creditLimit, fields: cleanFields(input.fields), createdAt: s.at, updatedAt: s.at,
  };
  s.emit({ type: 'party.created', subjectType: 'party', subjectId: party.id, data: { party } });
  return { id: party.id };
};

const partyUpdate: Handler = (s, input) => {
  s.require('parties.write');
  const p = mustParty(s, input.id);
  const patch: Record<string, unknown> = partyInput(s, input, true);
  if (input.fields !== undefined) patch.fields = { ...p.fields, ...cleanFields(input.fields) };
  for (const k of Object.keys(obj(input.fields))) if (obj(input.fields)[k] === null || obj(input.fields)[k] === '') delete (patch.fields as Record<string, unknown>)[k];
  s.emit({ type: 'party.updated', subjectType: 'party', subjectId: p.id, data: { id: p.id, patch, updatedAt: s.at } });
  return { id: p.id };
};

function itemInput(s: Scope, input: Record<string, any>, partial: boolean): Partial<Item> {
  const out: Partial<Item> = {};
  if (!partial || input.sku !== undefined) out.sku = str(input.sku, 'sku', { max: 60 });
  if (!partial || input.name !== undefined) out.name = str(input.name, 'name', { max: 300 });
  if (!partial || input.kind !== undefined) out.kind = oneOf(input.kind ?? 'stock', 'kind', ['stock', 'service', 'non_stock'] as const);
  if (!partial || input.uom !== undefined) out.uom = str(input.uom ?? 'pc', 'uom', { max: 20 });
  if (!partial || input.salePrice !== undefined) out.salePrice = Math.round(num(input.salePrice ?? 0, 'salePrice', { min: 0 }));
  if (!partial || input.costPrice !== undefined) out.costPrice = Math.round(num(input.costPrice ?? 0, 'costPrice', { min: 0 }));
  if (!partial || input.taxCode !== undefined) {
    out.taxCode = optStr(input.taxCode, 'taxCode') ?? s.jur.defaultTaxCode;
    if (!s.jur.taxCodes.some((t) => t.code === out.taxCode)) fail('invalid', 'Unknown tax code', { field: 'taxCode' });
  }
  if (input.whtCategory !== undefined) {
    out.whtCategory = optStr(input.whtCategory, 'whtCategory');
    if (out.whtCategory && !s.jur.whtCategories.some((w) => w.id === out.whtCategory)) fail('invalid', 'Unknown WHT category', { field: 'whtCategory' });
  }
  if (input.measureTemplate !== undefined) {
    out.measureTemplate = optStr(input.measureTemplate, 'measureTemplate');
    if (out.measureTemplate && !s.pack.measureTemplates.some((m) => m.id === out.measureTemplate)) fail('invalid', 'Unknown measure template', { field: 'measureTemplate' });
  }
  if (input.reorderPoint !== undefined) {
    const rp = optNum(input.reorderPoint, 'reorderPoint', { min: 0 });
    (out as Record<string, unknown>).reorderPoint = rp ?? null; // null clears it
  }
  if (input.active !== undefined) out.active = !!input.active;
  return out;
}

const itemCreate: Handler = (s, input) => {
  s.require('items.write');
  const b = itemInput(s, input, false);
  if (one(s.db, 'SELECT 1 FROM items WHERE sku = ?', b.sku)) fail('conflict', 'SKU already exists', { field: 'sku' }, 409);
  const item: Item = {
    id: newId('itm'), sku: b.sku!, name: b.name!, kind: b.kind!, uom: b.uom!, salePrice: b.salePrice!, costPrice: b.costPrice!,
    taxCode: b.taxCode!, whtCategory: b.whtCategory, measureTemplate: b.measureTemplate, fields: cleanFields(input.fields),
    reorderPoint: b.reorderPoint ?? undefined, active: true, createdAt: s.at, updatedAt: s.at,
  };
  s.emit({ type: 'item.created', subjectType: 'item', subjectId: item.id, data: { item } });
  return { id: item.id };
};

const itemUpdate: Handler = (s, input) => {
  s.require('items.write');
  const it = getItem(s.db, str(input.id, 'id'));
  if (!it) fail('not_found', 'Item not found', undefined, 404);
  const patch: Record<string, unknown> = itemInput(s, input, true);
  if (patch.sku && patch.sku !== it!.sku && one(s.db, 'SELECT 1 FROM items WHERE sku = ?', patch.sku)) fail('conflict', 'SKU already exists', { field: 'sku' }, 409);
  if (input.fields !== undefined) patch.fields = { ...it!.fields, ...cleanFields(input.fields) };
  s.emit({ type: 'item.updated', subjectType: 'item', subjectId: it!.id, data: { id: it!.id, patch, updatedAt: s.at } });
  return { id: it!.id };
};

// ───────────────────────────── Stock ─────────────────────────────

function internalLocation(s: Scope, v: unknown): string {
  const loc = optStr(v, 'location') ?? s.pack.defaultLocation;
  if (!s.pack.locations.some((l) => l.id === loc && l.kind === 'internal')) fail('invalid', `Unknown location '${loc}'`);
  return loc;
}

function stockItem(s: Scope, id: unknown): Item {
  const it = getItem(s.db, str(id, 'itemId'));
  if (!it) fail('not_found', 'Item not found', undefined, 404);
  if (it!.kind !== 'stock') fail('invalid', 'Only stock items have stock');
  return it!;
}

const stockAdjust: Handler = (s, input) => {
  s.require('stock.write');
  const it = stockItem(s, input.itemId);
  const qty = num(input.qty, 'qty');
  if (qty === 0) fail('invalid', 'Quantity cannot be zero');
  const reason = str(input.reason, 'reason', { max: 300 });
  const loc = internalLocation(s, input.location);
  const move: StockMove = {
    id: newId('mv'), itemId: it.id, qty: Math.abs(qty), from: qty > 0 ? 'adjustment' : loc, to: qty > 0 ? loc : 'adjustment',
    note: reason, at: s.at, by: s.actor.id,
  };
  s.emit({ type: 'stock.moved', subjectType: 'item', subjectId: it.id, data: { moves: [move], kind: 'adjustment' } });
  return { id: move.id };
};

const stockIssue: Handler = (s, input) => {
  s.require('stock.write');
  const job = mustJob(s, input.jobId);
  const it = stockItem(s, input.itemId);
  const qty = num(input.qty, 'qty', { min: 0.001 });
  const loc = internalLocation(s, input.location);
  const move: StockMove = {
    id: newId('mv'), itemId: it.id, qty, from: loc, to: 'consumed', jobId: job.id, note: optStr(input.note, 'note', 300),
    at: s.at, by: s.actor.id,
  };
  s.emit({ type: 'stock.moved', subjectType: 'job', subjectId: job.id, data: { moves: [move], kind: 'issue' } });
  return { id: move.id };
};

const stockTransfer: Handler = (s, input) => {
  s.require('stock.write');
  const it = stockItem(s, input.itemId);
  const qty = num(input.qty, 'qty', { min: 0.001 });
  const from = internalLocation(s, input.from);
  const to = internalLocation(s, input.to);
  if (from === to) fail('invalid', 'Choose two different locations');
  const move: StockMove = { id: newId('mv'), itemId: it.id, qty, from, to, note: optStr(input.note, 'note', 300), at: s.at, by: s.actor.id };
  s.emit({ type: 'stock.moved', subjectType: 'item', subjectId: it.id, data: { moves: [move], kind: 'transfer' } });
  return { id: move.id };
};

// ───────────────────────────── Jobs ─────────────────────────────

const jobCreate: Handler = (s, input) => {
  s.require('jobs.write');
  const type = str(input.type ?? s.pack.jobTypes[0].id, 'type');
  let jt;
  try {
    jt = jobType(s.pack, type);
  } catch {
    fail('invalid', 'Unknown job type');
  }
  const party = mustParty(s, input.partyId);
  const year = s.today().slice(0, 4);
  const key = `job:${jt!.id}:${year}`;
  const n = nextSequence(s, key);
  const initial = jt!.workflow.states.find((x) => x.id === jt!.workflow.initial)!;
  const ownerId = optStr(input.ownerId, 'ownerId') ?? (s.actor.system ? undefined : s.actor.id);
  if (ownerId && !getUser(s.db, ownerId)) fail('invalid', 'Unknown owner');
  const job: Job = {
    id: newId('job'), number: formatNumber(jt!.numbering.prefix, year, n), type: jt!.id,
    title: str(input.title, 'title', { max: 200 }), partyId: party.id, contactId: optStr(input.contactId, 'contactId'),
    ownerId, state: initial.id, phase: initial.phase, dueDate: optDate(input.dueDate, 'dueDate'),
    fields: cleanFields(input.fields), createdAt: s.at, updatedAt: s.at,
  };
  s.emit({ type: 'job.created', subjectType: 'job', subjectId: job.id, data: { job, sequence: { key, n } } });
  return { id: job.id, number: job.number };
};

const jobUpdate: Handler = (s, input) => {
  s.require('jobs.write');
  const job = mustJob(s, input.id);
  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = str(input.title, 'title', { max: 200 });
  if (input.partyId !== undefined) patch.partyId = mustParty(s, input.partyId).id;
  if (input.contactId !== undefined) patch.contactId = optStr(input.contactId, 'contactId') ?? null;
  if (input.ownerId !== undefined) {
    const o = optStr(input.ownerId, 'ownerId');
    if (o && !getUser(s.db, o)) fail('invalid', 'Unknown owner');
    patch.ownerId = o ?? null;
  }
  if (input.dueDate !== undefined) patch.dueDate = optDate(input.dueDate, 'dueDate') ?? null;
  if (input.fields !== undefined) {
    const merged = { ...job.fields, ...cleanFields(input.fields) };
    for (const [k, v] of Object.entries(obj(input.fields))) if (v === null || v === '') delete merged[k];
    patch.fields = merged;
  }
  s.emit({ type: 'job.updated', subjectType: 'job', subjectId: job.id, data: { id: job.id, patch, updatedAt: s.at } });
  return { id: job.id };
};

const jobTransition: Handler = (s, input) => {
  const job = mustJob(s, input.id);
  transitionJob(s, job, str(input.transition, 'transition'), optStr(input.reason, 'reason', 500));
  return { id: job.id };
};

// ───────────────────────────── Documents ─────────────────────────────

const documentCreate: Handler = (s, input) => {
  s.require('documents.write');
  const dt = docTypeOf(s, str(input.type, 'type'));
  let partyId: string | undefined = optStr(input.partyId, 'partyId');
  let jobId: string | undefined = optStr(input.jobId, 'jobId');
  let sourceId: string | undefined;
  let lines;
  let priceMode = input.priceMode === 'inclusive' ? 'inclusive' : input.priceMode === 'exclusive' ? 'exclusive' : dt.priceMode ?? 'exclusive';
  if (input.sourceId) {
    const src = mustDocument(s, input.sourceId);
    const srcType = docType(s.pack, src.type);
    if (!srcType.convertsTo.includes(dt.id)) fail('invalid', `${srcType.label.en} cannot be converted to ${dt.label.en}`);
    if (src.phase !== 'issued' && src.phase !== 'closed') fail('invalid_state', 'Issue the source document first', undefined, 409);
    if (dt.adjusts) {
      // A note corrects value, not quantity: start from the original lines and edit them down to the difference.
      if (srcType.direction !== dt.direction) fail('invalid', 'A note must stay on the same side as the document it corrects');
      lines = src.lines.map((l) => ({ ...l, id: newId('ln') }));
    } else {
      const children = all<{ id: string }>(s.db, 'SELECT id FROM documents WHERE source_id = ?', src.id).map((r) => getDocument(s.db, r.id)!);
      lines = openLines(src, children, dt.id).map((l) => ({ ...l, id: newId('ln') }));
      if (!lines.length) fail('nothing_open', 'Everything on the source document has already been converted', undefined, 409);
    }
    // Purchase docs converted from a sales doc would keep the customer; only same-direction conversions copy the party.
    partyId = srcType.direction === dt.direction ? src.partyId : partyId;
    jobId = src.jobId ?? jobId;
    sourceId = src.id;
    priceMode = src.priceMode;
  } else {
    if (dt.adjusts) fail('invalid', `Create a ${dt.label.en} from the document it corrects`);
    lines = normalizeLines(s, input.lines ?? [], dt.direction);
  }
  if (jobId) {
    const job = mustJob(s, jobId);
    if (!partyId && dt.direction === 'sales') partyId = job.partyId;
  }
  const party = mustParty(s, partyId);
  const docDate = optDate(input.date, 'date') ?? s.today();
  // Credit/debit notes adjust another document's balance and are never "due" themselves.
  const dueDays = dt.adjusts ? undefined : dt.effects.includes('receivable') || dt.effects.includes('payable') ? party.paymentTermsDays ?? dt.defaultDueDays : dt.defaultDueDays;
  const doc: Document = {
    id: newId('doc'), type: dt.id, state: dt.workflow.initial, phase: 'draft', partyId: party.id, jobId, sourceId,
    date: docDate, dueDate: optDate(input.dueDate, 'dueDate') ?? (dueDays !== undefined ? addDays(docDate, dueDays) : undefined),
    priceMode: priceMode as Document['priceMode'], lines, notes: optStr(input.notes, 'notes', 4000), fields: cleanFields(input.fields),
    totals: totalsFor(s, lines, priceMode as Document['priceMode'], docDate), createdBy: s.actor.id, createdAt: s.at, updatedAt: s.at,
  };
  s.emit({ type: 'document.created', subjectType: 'document', subjectId: doc.id, data: { document: doc } });
  return { id: doc.id };
};

const documentUpdate: Handler = (s, input) => {
  s.require('documents.write');
  const doc = mustDocument(s, input.id);
  if (doc.phase !== 'draft') fail('immutable', 'Issued documents cannot be edited. Void and re-issue instead.', undefined, 409);
  const dt = docType(s.pack, doc.type);
  const patch: Record<string, unknown> = {};
  if (input.partyId !== undefined) patch.partyId = mustParty(s, input.partyId).id;
  if (dt.adjusts && patch.partyId && patch.partyId !== doc.partyId) fail('invalid', 'A note belongs to the party of the document it corrects');
  if (input.date !== undefined) patch.date = date(input.date, 'date');
  if (input.dueDate !== undefined) patch.dueDate = optDate(input.dueDate, 'dueDate') ?? null;
  if (input.priceMode !== undefined) patch.priceMode = oneOf(input.priceMode, 'priceMode', ['exclusive', 'inclusive'] as const);
  if (input.notes !== undefined) patch.notes = optStr(input.notes, 'notes', 4000) ?? null;
  if (input.fields !== undefined) {
    const merged = { ...doc.fields, ...cleanFields(input.fields) };
    for (const [k, v] of Object.entries(obj(input.fields))) if (v === null || v === '') delete merged[k];
    patch.fields = merged;
  }
  const lines = input.lines !== undefined ? normalizeLines(s, input.lines, dt.direction) : doc.lines;
  if (input.lines !== undefined) patch.lines = lines;
  const priceMode = (patch.priceMode as Document['priceMode']) ?? doc.priceMode;
  const docDate = (patch.date as string) ?? doc.date;
  patch.totals = totalsFor(s, lines, priceMode, docDate);
  s.emit({ type: 'document.updated', subjectType: 'document', subjectId: doc.id, data: { id: doc.id, patch, updatedAt: s.at } });
  const contentChanged = input.lines !== undefined || input.partyId !== undefined || input.priceMode !== undefined;
  if (contentChanged && one(s.db, "SELECT 1 FROM approvals WHERE subject_type = 'document' AND subject_id = ? AND state IN ('pending','approved')", doc.id)) {
    s.emit({ type: 'approval.invalidated', subjectType: 'document', subjectId: doc.id, data: { reason: 'content changed' } });
  }
  return { id: doc.id, totals: patch.totals };
};

const documentTransition: Handler = (s, input) => {
  const doc = mustDocument(s, input.id);
  const tid = str(input.transition, 'transition');
  const dt = docType(s.pack, doc.type);
  const t = dt.workflow.transitions.find((x) => x.id === tid);
  const target = t && dt.workflow.states.find((x) => x.id === t.to);
  if (doc.phase !== 'draft' && target?.phase === 'void') requireCorrection(s, input, `void ${doc.number}: ${input.reason ?? ''}`);
  const r = transitionDocument(s, doc, tid, optStr(input.reason, 'reason', 500));
  return { id: doc.id, ...r };
};

// ───────────────────────────── Payments ─────────────────────────────

const paymentRecord: Handler = (s, input) => {
  s.require('money.write');
  const direction = oneOf(input.direction ?? 'in', 'direction', ['in', 'out'] as const);
  const party = mustParty(s, input.partyId);
  const method = oneOf(input.method, 'method', s.pack.paymentMethods.map((m) => m.id));
  const amount = Math.round(num(input.amount, 'amount', { min: 0 }));
  const whtAmount = Math.round(optNum(input.whtAmount, 'whtAmount', { min: 0 }) ?? 0);
  if (amount + whtAmount <= 0) fail('invalid', 'Enter an amount');
  const allocations = (Array.isArray(input.allocations) ? input.allocations : []).map((a: unknown, i: number) => {
    const o = obj(a);
    return { documentId: str(o.documentId, `allocation ${i + 1}`), amount: Math.round(num(o.amount, `allocation ${i + 1} amount`, { min: 1 })) };
  });
  if (!allocations.length) fail('invalid', 'Choose at least one document to settle');
  const total = allocations.reduce((a: number, b: { amount: number }) => a + b.amount, 0);
  if (total !== amount + whtAmount) fail('unbalanced', 'Allocations must equal the amount received plus tax withheld', { allocated: total, expected: amount + whtAmount }, 422);
  const kinds = new Map<string, 'receivable' | 'payable'>();
  for (const a of allocations as PaymentAllocation[]) {
    const doc = getDocument(s.db, a.documentId);
    if (!doc) fail('not_found', 'Document not found', undefined, 404);
    const dt = docType(s.pack, doc!.type);
    const kind = dt.effects.includes('receivable') ? 'receivable' : dt.effects.includes('payable') ? 'payable' : undefined;
    if (!kind || dt.adjusts) fail('invalid', `${doc!.number ?? 'Document'} cannot be settled by a payment`);
    if (doc!.phase !== 'issued' && doc!.phase !== 'closed') fail('invalid_state', `${doc!.number ?? 'Draft'} is not issued`, undefined, 409);
    if (doc!.partyId !== party.id) fail('invalid', `${doc!.number} belongs to another party`);
    if (kinds.has(doc!.id)) fail('invalid', `${doc!.number} is listed twice`);
    kinds.set(doc!.id, kind!);
    const open = outstandingOf(s, doc!) ?? 0;
    // Money flowing the "wrong" way for a document is a refund of an over-credited balance.
    const refund = (direction === 'in') !== (kind === 'receivable');
    if (refund) {
      if (whtAmount) fail('invalid', 'A refund cannot carry withholding tax');
      if (a.amount > -open) fail('overpaid', `${doc!.number}: only ${(Math.max(0, -open) / 100).toFixed(2)} can be refunded`, { documentId: doc!.id, open }, 422);
      a.refund = true;
    } else if (a.amount > open) {
      fail('overpaid', `${doc!.number}: only ${(Math.max(0, open) / 100).toFixed(2)} is outstanding`, { documentId: doc!.id, open }, 422);
    }
  }
  const whtCategory = optStr(input.whtCategory, 'whtCategory');
  if (whtCategory && !s.jur.whtCategories.some((w) => w.id === whtCategory)) fail('invalid', 'Unknown WHT category');
  const pDate = optDate(input.date, 'date') ?? s.today();
  const year = pDate.slice(0, 4);
  const key = `pay:${direction}:${year}`;
  const n = nextSequence(s, key);
  const payment: Payment = {
    id: newId('pay'), number: formatNumber(direction === 'in' ? 'RC' : 'PV', year, n), direction, partyId: party.id,
    date: pDate, method, amount, whtAmount, whtCategory: whtAmount ? whtCategory : undefined,
    whtCertificate: optStr(input.whtCertificate, 'whtCertificate', 60), reference: optStr(input.reference, 'reference', 200),
    allocations, createdBy: s.actor.id, createdAt: s.at,
  };
  s.emit({ type: 'payment.recorded', subjectType: 'payment', subjectId: payment.id, data: { payment, sequence: { key, n } } });
  const cash = s.pack.paymentMethods.filter((m) => m.cash).map((m) => m.id);
  const entry = postPayment(payment, s.jur.postingAccounts, newId('je'), cash, (id) => kinds.get(id)!);
  s.emit({ type: 'ledger.posted', subjectType: 'payment', subjectId: payment.id, data: { entry } });
  for (const a of allocations) s.touched.add(`document:${a.documentId}`);
  return { id: payment.id, number: payment.number };
};

const paymentVoid: Handler = (s, input) => {
  s.require('money.write');
  const p = getPayment(s.db, str(input.id, 'id'));
  if (!p) fail('not_found', 'Payment not found', undefined, 404);
  if (p!.voided) fail('invalid_state', 'Already void', undefined, 409);
  const reason = str(input.reason, 'reason', { max: 300 });
  requireCorrection(s, input, `void ${p!.number}: ${reason}`);
  s.emit({ type: 'payment.voided', subjectType: 'payment', subjectId: p!.id, data: { id: p!.id, reason } });
  reverseLedger(s, 'payment', p!.id);
  for (const a of p!.allocations) s.touched.add(`document:${a.documentId}`);
  return { id: p!.id };
};

// ───────────────────────────── Collaboration ─────────────────────────────

const taskCreate: Handler = (s, input) => {
  const subj = assertSubject(s, input.subjectType, input.subjectId);
  const assigneeId = optStr(input.assigneeId, 'assigneeId');
  if (assigneeId && !getUser(s.db, assigneeId)) fail('invalid', 'Unknown assignee');
  const role = optStr(input.role, 'role');
  if (role && !s.pack.roles.some((r) => r.id === role)) fail('invalid', 'Unknown role');
  const task = {
    id: newId('tsk'), subjectType: subj.type, subjectId: subj.id, title: str(input.title, 'title', { max: 300 }),
    assigneeId, role, due: optDate(input.due, 'due'), createdBy: s.actor.id, createdAt: s.at,
  };
  s.emit({ type: 'task.created', subjectType: subj.type, subjectId: subj.id, data: { task } });
  return { id: task.id };
};

function mustTask(s: Scope, id: unknown) {
  const t = one<{ id: string; subject_type: string; subject_id: string; done_at: string | null }>(s.db, 'SELECT id, subject_type, subject_id, done_at FROM tasks WHERE id = ?', str(id, 'id'));
  if (!t) fail('not_found', 'Task not found', undefined, 404);
  return t!;
}

const taskComplete: Handler = (s, input) => {
  const t = mustTask(s, input.id);
  if (t.done_at) return { id: t.id };
  s.emit({ type: 'task.completed', subjectType: t.subject_type as never, subjectId: t.subject_id, data: { id: t.id } });
  return { id: t.id };
};

const taskReopen: Handler = (s, input) => {
  const t = mustTask(s, input.id);
  s.emit({ type: 'task.reopened', subjectType: t.subject_type as never, subjectId: t.subject_id, data: { id: t.id } });
  return { id: t.id };
};

const taskUpdate: Handler = (s, input) => {
  const t = mustTask(s, input.id);
  const assigneeId = optStr(input.assigneeId, 'assigneeId');
  if (assigneeId && !getUser(s.db, assigneeId)) fail('invalid', 'Unknown assignee');
  s.emit({
    type: 'task.updated', subjectType: t.subject_type as never, subjectId: t.subject_id,
    data: { id: t.id, title: optStr(input.title, 'title', 300), assigneeId, due: optDate(input.due, 'due') },
  });
  return { id: t.id };
};

export function parseMentions(s: Scope, body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/@([a-z0-9_.-]{2,40})/gi)) {
    const name = m[1].toLowerCase();
    const u = one<{ id: string }>(s.db, 'SELECT id FROM users WHERE username = ?', name);
    if (u) out.add(u.id);
    else if (s.pack.roles.some((r) => r.id === name)) out.add(`role:${name}`);
  }
  return [...out];
}

const messagePost: Handler = (s, input) => {
  const subj = assertSubject(s, input.subjectType, input.subjectId);
  const body = str(input.body, 'message', { max: 8000 });
  const fileIds = (Array.isArray(input.fileIds) ? input.fileIds : []).filter((f: unknown) => typeof f === 'string').slice(0, 20);
  for (const f of fileIds) if (!one(s.db, 'SELECT 1 FROM files WHERE id = ?', f)) fail('invalid', 'Unknown attachment');
  const message = {
    id: newId('msg'), subjectType: subj.type, subjectId: subj.id, authorId: s.actor.id, body,
    mentions: parseMentions(s, body), fileIds, createdAt: s.at,
  };
  s.emit({ type: 'message.posted', subjectType: subj.type, subjectId: subj.id, data: { message } });
  return { id: message.id };
};

const fileAttach: Handler = (s, input) => {
  const subj = assertSubject(s, input.subjectType, input.subjectId);
  const sha = str(input.sha256, 'sha256', { max: 64 });
  if (!/^[a-f0-9]{64}$/.test(sha)) fail('invalid', 'Bad file hash');
  const file = {
    id: newId('fil'), sha256: sha, name: str(input.name, 'name', { max: 255 }), mime: str(input.mime ?? 'application/octet-stream', 'mime', { max: 120 }),
    size: num(input.size, 'size', { min: 0, int: true }), subjectType: subj.type, subjectId: subj.id, uploadedBy: s.actor.id, createdAt: s.at,
  };
  s.emit({ type: 'file.attached', subjectType: subj.type, subjectId: subj.id, data: { file } });
  return { id: file.id };
};

const approvalRequest: Handler = (s, input) => {
  const subj = assertSubject(s, input.subjectType, input.subjectId);
  const transitionId = str(input.transitionId, 'transitionId');
  let transitions;
  let state: string;
  let ctx;
  if (subj.type === 'document') {
    const doc = getDocument(s.db, subj.id)!;
    const wf = docType(s.pack, doc.type).workflow;
    transitions = transitionsFrom(wf, doc.state);
    state = doc.state;
    ctx = documentGuardContext(s, doc, s.actor.role);
  } else if (subj.type === 'job') {
    fail('invalid', 'Job approvals are not configured in this version');
  } else fail('invalid', 'Approvals apply to documents');
  const t = transitions!.find((x) => x.id === transitionId);
  if (!t) fail('invalid', `No transition '${transitionId}' from '${state!}'`);
  const need = checkGuard(t!, ctx!).find((m) => m.kind === 'approval');
  if (!need || need.kind !== 'approval') fail('not_needed', 'No approval is needed for this step', undefined, 409);
  if ((need as { status: string }).status === 'pending') fail('pending', 'An approval is already pending', undefined, 409);
  const approval = {
    id: newId('apr'), subjectType: subj.type, subjectId: subj.id, transitionId, role: (need as { role: string }).role,
    reason: optStr(input.note, 'note', 500) ?? t!.requires?.approval?.reason?.en, state: 'pending',
    requestedBy: s.actor.id, requestedAt: s.at,
  };
  s.emit({ type: 'approval.requested', subjectType: subj.type, subjectId: subj.id, data: { approval } });
  return { id: approval.id };
};

const approvalDecide: Handler = (s, input) => {
  const a = one<{ id: string; role: string; state: string; subject_type: string; subject_id: string; requested_by: string }>(s.db,
    'SELECT * FROM approvals WHERE id = ?', str(input.id, 'id'));
  if (!a) fail('not_found', 'Approval not found', undefined, 404);
  if (a!.state !== 'pending') fail('invalid_state', 'This approval was already decided', undefined, 409);
  if (!s.isSuperuser && s.actor.role !== a!.role) fail('forbidden', `Only ${a!.role} can decide`, undefined, 403);
  if (a!.requested_by === s.actor.id && !s.isSuperuser) fail('forbidden', 'You cannot approve your own request', undefined, 403);
  const decision = oneOf(input.decision, 'decision', ['approved', 'rejected'] as const);
  s.emit({
    type: 'approval.decided', subjectType: a!.subject_type as never, subjectId: a!.subject_id,
    data: { id: a!.id, state: decision, comment: optStr(input.comment, 'comment', 500) },
  });
  return { id: a!.id };
};

// ───────────────────────────── Registry ─────────────────────────────

export const registry: Registry = {
  commands: {
    'company.update': companyUpdate,
    'user.create': userCreate,
    'user.update': userUpdate,
    'party.create': partyCreate,
    'party.update': partyUpdate,
    'item.create': itemCreate,
    'item.update': itemUpdate,
    'stock.adjust': stockAdjust,
    'stock.issue': stockIssue,
    'stock.transfer': stockTransfer,
    'job.create': jobCreate,
    'job.update': jobUpdate,
    'job.transition': jobTransition,
    'document.create': documentCreate,
    'document.update': documentUpdate,
    'document.transition': documentTransition,
    'payment.record': paymentRecord,
    'payment.void': paymentVoid,
    'task.create': taskCreate,
    'task.complete': taskComplete,
    'task.reopen': taskReopen,
    'task.update': taskUpdate,
    'message.post': messagePost,
    'file.attach': fileAttach,
    'approval.request': approvalRequest,
    'approval.decide': approvalDecide,
    ...booksCommands({ party: partyCreate, item: itemCreate }),
  },
  settle,
};

export { systemMessage, VIRTUAL_LOCATIONS };
