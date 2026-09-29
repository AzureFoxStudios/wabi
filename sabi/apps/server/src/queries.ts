/**
 * Read models for the web app. Everything here is derived from projection
 * tables; nothing writes. Shapes are tailored to screens (workspace, lists,
 * attention) rather than mirroring tables.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Document, DocTypeDef, JournalEvent, Pack, Jurisdiction, Label } from '@sabi/core';
import {
  consumedQty, docType, evaluateTransitions, fulfilment, jobType, nextAction, openLines, pipeline, stateOf,
  type TransitionOption,
} from '@sabi/core';
import { all, one } from './db.ts';
import { rowToEvent } from './journal.ts';
import { describeEvent, type Described } from './describe.ts';
import {
  getCompany, getDocument, getItem, getJob, getParty, toLine, listUsers, settledAmount, heldRetention, tasksOf,
  toApproval, toDocument, toFile, toItem, toJob, toMessage, toMove, toParty, toPayment, type UserRecord,
} from './repo.ts';
import type { Ctx } from './engine.ts';
import { allAccounts, correctionsProtected } from './commands/books.ts';

type Viewer = UserRecord;

const today = () => new Date(Date.now() + Number(process.env.SABI_TZ_OFFSET_MINUTES ?? 420) * 60_000).toISOString().slice(0, 10);

function isSuper(pack: Pack, role: string) {
  return !!pack.roles.find((r) => r.id === role)?.capabilities.includes('all');
}
function hasCap(pack: Pack, role: string, cap: string) {
  const r = pack.roles.find((x) => x.id === role);
  return !!r && (r.capabilities.includes('all') || r.capabilities.includes(cap as never));
}

// ───────────────────────────── Shared helpers ─────────────────────────────

function allDocs(db: DatabaseSync, where = '1=1', ...params: unknown[]): Document[] {
  const rows = all<Record<string, any>>(db, `SELECT * FROM documents WHERE ${where} ORDER BY date DESC, created_at DESC`, ...params);
  if (!rows.length) return [];
  const lines = all<Record<string, any>>(db,
    `SELECT * FROM document_lines WHERE document_id IN (${rows.map(() => '?').join(',')}) ORDER BY document_id, position`, ...rows.map((r) => r.id));
  const byDoc = new Map<string, any[]>();
  for (const l of lines) {
    const arr = byDoc.get(l.document_id) ?? [];
    arr.push(l);
    byDoc.set(l.document_id, arr);
  }
  return rows.map((r) => toDocument(r, (byDoc.get(r.id) ?? []).map((l) => toLine(l))));
}

function moneyKind(dt: DocTypeDef): 'receivable' | 'payable' | null {
  return dt.effects.includes('receivable') ? 'receivable' : dt.effects.includes('payable') ? 'payable' : null;
}

function settledMap(db: DatabaseSync): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of all<{ document_id: string; s: number }>(db,
    `SELECT a.document_id, SUM(CASE WHEN a.refund = 1 THEN -a.amount ELSE a.amount END) AS s FROM payment_allocations a
     JOIN payments p ON p.id = a.payment_id WHERE p.voided = 0 GROUP BY a.document_id`)) {
    m.set(r.document_id, r.s);
  }
  for (const r of all<{ source_id: string; s: number }>(db, 'SELECT source_id, SUM(amount) AS s FROM doc_adjustments GROUP BY source_id')) {
    m.set(r.source_id, (m.get(r.source_id) ?? 0) + r.s);
  }
  return m;
}

function partyNames(db: DatabaseSync): Map<string, string> {
  return new Map(all<{ id: string; name: string }>(db, 'SELECT id, name FROM parties').map((r) => [r.id, r.name]));
}

export function docSummary(pack: Pack, d: Document, settled: number, parties?: Map<string, string>) {
  const dt = docType(pack, d.type);
  const st = stateOf(dt.workflow, d.state);
  const mk = moneyKind(dt);
  const live = d.phase === 'issued' || d.phase === 'closed';
  // Credit/debit notes change their source's balance and carry none of their own.
  const held = heldRetention(d);
  const balance = mk && live && !dt.adjusts ? d.totals.total - held - settled : null;
  return {
    id: d.id, type: d.type, number: d.number ?? null, state: d.state, stateLabel: st.label, tone: st.tone ?? 'neutral', phase: d.phase,
    partyId: d.partyId, partyName: parties?.get(d.partyId) ?? d.partySnapshot?.name ?? '', jobId: d.jobId ?? null, sourceId: d.sourceId ?? null,
    date: d.date, dueDate: d.dueDate ?? null, total: d.totals.total, net: d.totals.net, tax: d.totals.tax, money: mk, balance,
    overdue: !!(balance && balance > 0 && d.dueDate && d.dueDate < today()), ownerRole: st.ownerRole ?? null,
    adjusts: dt.adjusts ?? null, retentionHeld: held,
  };
}

/**
 * Stock position per item: on hand in internal locations, reserved by
 * confirmed orders not yet delivered, and incoming from open purchase orders.
 */
export function stockPosition(db: DatabaseSync, pack: Pack) {
  const internal = pack.locations.filter((l) => l.kind === 'internal').map((l) => l.id);
  const pos = new Map<string, { onHand: number; reserved: number; incoming: number; byLocation: Record<string, number> }>();
  const get = (id: string) => {
    let p = pos.get(id);
    if (!p) pos.set(id, (p = { onHand: 0, reserved: 0, incoming: 0, byLocation: Object.fromEntries(internal.map((l) => [l, 0])) }));
    return p;
  };
  for (const r of all<{ item_id: string; loc: string; q: number }>(db,
    `SELECT item_id, to_loc AS loc, SUM(qty) AS q FROM stock_moves GROUP BY item_id, to_loc
     UNION ALL SELECT item_id, from_loc AS loc, -SUM(qty) AS q FROM stock_moves GROUP BY item_id, from_loc`)) {
    if (!internal.includes(r.loc)) continue;
    const p = get(r.item_id);
    p.byLocation[r.loc] = round3(p.byLocation[r.loc] + r.q);
    p.onHand = round3(p.onHand + r.q);
  }
  const outTypes = new Set(pack.documentTypes.filter((t) => t.effects.includes('stock_out')).map((t) => t.id));
  const inTypes = new Set(pack.documentTypes.filter((t) => t.effects.includes('stock_in')).map((t) => t.id));
  const reserveTypes = pack.documentTypes.filter((t) => t.effects.includes('reserve')).map((t) => t.id);
  const incomingTypes = pack.documentTypes
    .filter((t) => t.direction === 'purchase' && !t.effects.includes('stock_in') && t.convertsTo.some((c) => inTypes.has(c)))
    .map((t) => t.id);
  const openOf = (types: string[], childTypes: Set<string>, add: (itemId: string, q: number, doc: Document) => void) => {
    if (!types.length) return;
    const docs = allDocs(db, `phase = 'issued' AND type IN (${types.map(() => '?').join(',')})`, ...types);
    for (const d of docs) {
      const children = allDocs(db, 'source_id = ?', d.id).filter((c) => childTypes.has(c.type));
      const used = consumedQty(children);
      for (const l of d.lines) {
        if (!l.itemId || l.itemKind !== 'stock') continue;
        const rem = round3(l.qty - (used.get(l.id) ?? 0));
        if (rem > 0) add(l.itemId, rem, d);
      }
    }
  };
  const reservedBy: { itemId: string; qty: number; docId: string; jobId?: string }[] = [];
  openOf(reserveTypes, outTypes, (id, q, d) => {
    get(id).reserved = round3(get(id).reserved + q);
    reservedBy.push({ itemId: id, qty: q, docId: d.id, jobId: d.jobId });
  });
  openOf(incomingTypes, inTypes, (id, q) => {
    get(id).incoming = round3(get(id).incoming + q);
  });
  return { pos, reservedBy, get: (id: string) => pos.get(id) ?? { onHand: 0, reserved: 0, incoming: 0, byLocation: {} } };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function shortages(db: DatabaseSync, pack: Pack) {
  const sp = stockPosition(db, pack);
  const out = [];
  for (const [itemId, p] of sp.pos) {
    const item = getItem(db, itemId);
    if (!item || item.kind !== 'stock') continue;
    const available = round3(p.onHand - p.reserved);
    const reorder = item.reorderPoint;
    const short = available < 0;
    const low = !short && reorder !== undefined && available < reorder;
    if (!short && !low) continue;
    const jobs = [...new Set(sp.reservedBy.filter((r) => r.itemId === itemId && r.jobId).map((r) => r.jobId!))];
    out.push({
      itemId, sku: item.sku, name: item.name, uom: item.uom, onHand: p.onHand, reserved: p.reserved, incoming: p.incoming,
      available, reorderPoint: reorder ?? null, short, covered: round3(available + p.incoming) >= 0,
      jobs: jobs.map((id) => ({ id, number: getJob(db, id)?.number ?? '' })),
    });
  }
  return out.sort((a, b) => Number(b.short) - Number(a.short) || a.available - b.available);
}

function options(opts: TransitionOption[]) {
  return opts.map((o) => ({
    id: o.transition.id, label: o.transition.label, to: o.transition.to, toLabel: o.target.label, primary: !!o.transition.primary,
    tone: o.transition.tone ?? null, auto: !!o.transition.auto, requireReason: !!o.transition.requireReason, ok: o.ok, missing: o.missing,
    phase: o.target.phase,
  }));
}

function eventsFor(db: DatabaseSync, pack: Pack, subjectType: string, subjectId: string, limit = 300): Described[] {
  const rows = all<Record<string, any>>(db,
    `SELECT e.* FROM event_links l JOIN events e ON e.seq = l.seq WHERE l.subject_type = ? AND l.subject_id = ? ORDER BY e.seq DESC LIMIT ?`,
    subjectType, subjectId, limit);
  return rows.map((r) => describeEvent(db, pack, rowToEvent(r as never))).filter((x): x is Described => !!x);
}

function messagesFor(db: DatabaseSync, subjectType: string, ids: string[]) {
  if (!ids.length) return [];
  return all(db, `SELECT * FROM messages WHERE subject_type = ? AND subject_id IN (${ids.map(() => '?').join(',')}) ORDER BY seq`, subjectType, ...ids).map(toMessage);
}

function filesFor(db: DatabaseSync, pairs: [string, string][]) {
  const out = [];
  for (const [t, id] of pairs) out.push(...all(db, 'SELECT * FROM files WHERE subject_type = ? AND subject_id = ? ORDER BY created_at DESC', t, id).map(toFile));
  return out;
}

function lastRead(db: DatabaseSync, userId: string, subjectType: string, subjectId: string) {
  return one<{ seq: number }>(db, 'SELECT seq FROM reads WHERE user_id = ? AND subject_type = ? AND subject_id = ?', userId, subjectType, subjectId)?.seq ?? 0;
}

// ───────────────────────────── Bootstrap ─────────────────────────────

export function bootstrap(ctx: Ctx, viewer: Viewer, demo: boolean) {
  const { db, pack, jur } = ctx;
  return {
    user: viewer,
    company: getCompany(db),
    users: listUsers(db).map((u) => ({ id: u.id, name: u.name, username: u.username, role: u.role, active: u.active })),
    pack,
    jurisdiction: {
      id: jur.id, label: jur.label, currency: jur.currency, currencySymbol: jur.currencySymbol, taxCodes: jur.taxCodes,
      defaultTaxCode: jur.defaultTaxCode, whtCategories: jur.whtCategories, partyFields: jur.partyFields,
      companyFields: jur.companyFields, chartOfAccounts: allAccounts({ db, jur }),
    },
    settings: settingsFor(db, isSuper(pack, viewer.role)),
    correctionsProtected: correctionsProtected({ db }),
    head: one<{ seq: number }>(db, 'SELECT COALESCE(MAX(seq),0) AS seq FROM events')?.seq ?? 0,
    demo,
    today: today(),
  };
}

/** Business settings from the journal. The webhook secret is only shown to owners. */
export function settingsFor(db: DatabaseSync, full: boolean) {
  const out: Record<string, any> = {};
  for (const r of all<{ key: string; value: string }>(db, "SELECT key, value FROM settings WHERE key != 'company'")) out[r.key] = JSON.parse(r.value);
  if (!full && out.webhook) out.webhook = { url: out.webhook.url ? '(set)' : null };
  return out;
}

// ───────────────────────────── Jobs ─────────────────────────────

export function jobList(ctx: Ctx, q: { type?: string; phase?: string; state?: string; partyId?: string; mine?: string; search?: string }, viewer: Viewer) {
  const { db, pack } = ctx;
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.type) (where.push('j.type = ?'), params.push(q.type));
  if (q.phase) (where.push('j.phase = ?'), params.push(q.phase));
  if (q.state) (where.push('j.state = ?'), params.push(q.state));
  if (q.partyId) (where.push('j.party_id = ?'), params.push(q.partyId));
  if (q.mine) (where.push('j.owner_id = ?'), params.push(viewer.id));
  if (q.search) {
    where.push('(j.number LIKE ? OR j.title LIKE ? OR p.name LIKE ?)');
    params.push(`%${q.search}%`, `%${q.search}%`, `%${q.search}%`);
  }
  const rows = all<Record<string, any>>(db,
    `SELECT j.*, p.name AS party_name,
       (SELECT MAX(l.seq) FROM event_links l WHERE l.subject_type = 'job' AND l.subject_id = j.id) AS last_seq
     FROM jobs j JOIN parties p ON p.id = j.party_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY j.phase = 'open' DESC, last_seq DESC LIMIT 500`, ...params);
  const settled = settledMap(db);
  return rows.map((r) => {
    const job = toJob(r);
    const jt = jobType(pack, job.type);
    const st = stateOf(jt.workflow, job.state);
    const docs = allDocs(db, 'job_id = ?', job.id);
    const money = jobMoney(pack, docs, settled);
    const openTasks = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM tasks WHERE subject_type = 'job' AND subject_id = ? AND done_at IS NULL", job.id)?.n ?? 0;
    const last = r.last_seq ? one<{ at: string; actor_id: string }>(db, 'SELECT at, actor_id FROM events WHERE seq = ?', r.last_seq) : undefined;
    return {
      id: job.id, number: job.number, type: job.type, title: job.title, partyId: job.partyId, partyName: r.party_name, ownerId: job.ownerId ?? null,
      state: job.state, stateLabel: st.label, tone: st.tone ?? 'neutral', phase: job.phase, ownerRole: st.ownerRole ?? null, dueDate: job.dueDate ?? null,
      summaryFields: Object.fromEntries(jt.fields.filter((f) => f.summary).map((f) => [f.key, job.fields[f.key] ?? null])),
      money, openTasks, lastAt: last?.at ?? job.updatedAt, lastActorId: last?.actor_id ?? null,
      unread: r.last_seq ? r.last_seq > lastRead(db, viewer.id, 'job', job.id) : false,
    };
  });
}

function jobMoney(pack: Pack, docs: Document[], settled: Map<string, number>) {
  let quoted = 0, ordered = 0, invoiced = 0, paid = 0, purchased = 0, billed = 0;
  for (const d of docs) {
    if (d.phase !== 'issued' && d.phase !== 'closed') continue;
    const dt = docType(pack, d.type);
    const mk = moneyKind(dt);
    if (mk === 'receivable') {
      invoiced += d.totals.total;
      paid += settled.get(d.id) ?? 0;
    } else if (mk === 'payable') billed += d.totals.total;
    else if (dt.direction === 'sales' && dt.effects.includes('reserve')) ordered += d.totals.total;
    else if (dt.direction === 'sales' && !dt.effects.length) quoted = Math.max(quoted, d.totals.total);
    else if (dt.direction === 'purchase' && !dt.effects.length) purchased += d.totals.total;
  }
  return { quoted, ordered, invoiced, paid, outstanding: invoiced - paid, purchased, billed };
}

export function jobWorkspace(ctx: Ctx, id: string, viewer: Viewer) {
  const { db, pack, jur } = ctx;
  const job = getJob(db, id);
  if (!job) return null;
  const jt = jobType(pack, job.type);
  const st = stateOf(jt.workflow, job.state);
  const party = getParty(db, job.partyId)!;
  const contact = job.contactId ? getParty(db, job.contactId) : undefined;
  const docs = allDocs(db, 'job_id = ?', job.id);
  const settled = settledMap(db);
  const parties = partyNames(db);
  const tasks = tasksOf(db, 'job', job.id);
  const openTasks = tasks.filter((t) => !t.doneAt).length;
  const approvals = all(db, "SELECT * FROM approvals WHERE (subject_type = 'job' AND subject_id = ?) OR (subject_type = 'document' AND subject_id IN (SELECT id FROM documents WHERE job_id = ?)) ORDER BY requested_at DESC", job.id, job.id).map(toApproval);
  const ctxGuard = {
    fields: { ...job.fields, title: job.title, partyId: job.partyId, ownerId: job.ownerId, dueDate: job.dueDate },
    documents: docs.map((d) => ({ type: d.type, phase: d.phase })), openTasks, role: viewer.role, isSuperuser: isSuper(pack, viewer.role),
  };
  const opts = evaluateTransitions(jt.workflow, job.state, ctxGuard);
  const next = nextAction(opts);

  // Fulfilment: ordered vs delivered per stock/service line of live orders.
  const sp = stockPosition(db, pack);
  const orderTypes = pack.documentTypes.filter((t) => t.effects.includes('reserve')).map((t) => t.id);
  const outTypes = new Set(pack.documentTypes.filter((t) => t.effects.includes('stock_out')).map((t) => t.id));
  const fulfilmentLines = [];
  for (const so of docs.filter((d) => orderTypes.includes(d.type) && (d.phase === 'issued' || d.phase === 'closed'))) {
    const children = allDocs(db, 'source_id = ?', so.id).filter((c) => outTypes.has(c.type));
    const used = consumedQty(children);
    for (const l of so.lines) {
      const delivered = Math.min(l.qty, used.get(l.id) ?? 0);
      const p = l.itemId ? sp.get(l.itemId) : undefined;
      const remaining = round3(l.qty - delivered);
      fulfilmentLines.push({
        documentId: so.id, documentNumber: so.number, lineId: l.id, itemId: l.itemId ?? null, description: l.description, uom: l.uom,
        kind: l.itemKind ?? 'non_stock', ordered: l.qty, delivered, remaining,
        onHand: p?.onHand ?? null, available: p ? round3(p.onHand - p.reserved) : null, incoming: p?.incoming ?? null,
        short: !!(p && remaining > 0 && p.onHand - p.reserved < 0),
      });
    }
  }
  // Materials physically moved for this job (deliveries + consumption), valued at cost.
  const moves = all(db, 'SELECT m.*, i.sku, i.name, i.uom, i.cost_price FROM stock_moves m JOIN items i ON i.id = m.item_id WHERE m.job_id = ? ORDER BY m.at', job.id);
  const materials = moves.map((m: any) => ({ ...toMove(m), sku: m.sku, name: m.name, uom: m.uom, cost: Math.round(m.cost_price * m.qty) }));
  const materialCost = materials.reduce((a, m) => a + (m.to === 'customer' || m.to === 'consumed' ? m.cost : m.from === 'customer' || m.from === 'consumed' ? -m.cost : 0), 0);

  const docIds = docs.map((d) => d.id);
  const messages = messagesFor(db, 'job', [job.id]);
  const docMessages = messagesFor(db, 'document', docIds);
  const files = filesFor(db, [['job', job.id], ...docIds.map((d) => ['document', d] as [string, string])]);
  const payments = all<Record<string, any>>(db,
    `SELECT DISTINCT p.* FROM payments p JOIN payment_allocations a ON a.payment_id = p.id WHERE a.document_id IN (SELECT id FROM documents WHERE job_id = ?) ORDER BY p.date`, job.id)
    .map((p) => toPayment(p, all<{ document_id: string; amount: number }>(db, 'SELECT * FROM payment_allocations WHERE payment_id = ?', p.id).map((a) => ({ documentId: a.document_id, amount: a.amount }))));

  // Which documents can be started from here (respecting the job type's allowed docs).
  const creatable = jt.documentTypes.map((t) => {
    const dt = docType(pack, t);
    const sources = docs.filter((d) => (d.phase === 'issued' || d.phase === 'closed') && docType(pack, d.type).convertsTo.includes(t))
      .filter((d) => openLines(d, allDocs(db, 'source_id = ?', d.id), t).length > 0)
      .map((d) => ({ id: d.id, number: d.number, type: d.type }));
    return { type: t, label: dt.label, direction: dt.direction, sources };
  });

  return {
    job, jobType: { id: jt.id, label: jt.label, fields: jt.fields }, state: st, pipeline: pipeline(jt.workflow),
    party, contact: contact ?? null, contacts: all(db, 'SELECT * FROM parties WHERE parent_id = ?', party.id).map(toParty),
    transitions: options(opts), next: next ? options([next])[0] : null,
    documents: docs.map((d) => ({ ...docSummary(pack, d, settled.get(d.id) ?? 0, parties), fulfilment: null as number | null })),
    creatable, tasks, approvals, messages, docMessages, files, payments,
    fulfilment: fulfilmentLines, materials, materialCost,
    money: jobMoney(pack, docs, settled),
    wht: docs.filter((d) => moneyKind(docType(pack, d.type)) === 'receivable' && d.phase === 'issued').flatMap((d) => whtOf(jur, d, party).map((w) => ({ ...w, documentId: d.id }))),
    timeline: eventsFor(db, pack, 'job', job.id),
    lastRead: lastRead(db, viewer.id, 'job', job.id),
  };
}

// ───────────────────────────── Documents ─────────────────────────────

export function documentList(ctx: Ctx, q: { type?: string; phase?: string; partyId?: string; money?: string; search?: string; open?: string }) {
  const { db, pack } = ctx;
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.type) (where.push('type = ?'), params.push(q.type));
  if (q.phase) (where.push('phase = ?'), params.push(q.phase));
  if (q.partyId) (where.push('party_id = ?'), params.push(q.partyId));
  if (q.search) {
    where.push('(number LIKE ? OR party_id IN (SELECT id FROM parties WHERE name LIKE ?))');
    params.push(`%${q.search}%`, `%${q.search}%`);
  }
  const settled = settledMap(db);
  const parties = partyNames(db);
  let list = allDocs(db, where.length ? where.join(' AND ') : '1=1', ...params).map((d) => docSummary(pack, d, settled.get(d.id) ?? 0, parties));
  if (q.money) list = list.filter((d) => d.money === q.money);
  if (q.open) list = list.filter((d) => (d.balance ?? 0) > 0);
  return list.slice(0, 1000);
}

export function documentView(ctx: Ctx, id: string, viewer: Viewer) {
  const { db, pack, jur } = ctx;
  const doc = getDocument(db, id);
  if (!doc) return null;
  const dt = docType(pack, doc.type);
  const st = stateOf(dt.workflow, doc.state);
  const party = getParty(db, doc.partyId)!;
  const settledNow = settledAmount(db, doc.id);
  const live = doc.phase === 'issued' || doc.phase === 'closed';
  const held = heldRetention(doc);
  const openNow = moneyKind(dt) && live && !dt.adjusts ? doc.totals.total - held - settledNow : undefined;
  const children = allDocs(db, 'source_id = ?', doc.id);
  const source = doc.sourceId ? getDocument(db, doc.sourceId) : undefined;
  const approvals = all(db, "SELECT * FROM approvals WHERE subject_type = 'document' AND subject_id = ? ORDER BY requested_at DESC", doc.id).map(toApproval);
  const valid: Record<string, 'pending' | 'approved' | 'rejected'> = {};
  for (const a of [...approvals].reverse()) if (a.state !== 'stale') valid[a.transitionId] = a.state as never;
  const metrics = { total: doc.totals.total / 100, net: doc.totals.net / 100, tax: doc.totals.tax / 100, max_discount_pct: doc.totals.maxDiscountPct, line_count: doc.lines.length };
  const opts = evaluateTransitions(dt.workflow, doc.state, {
    fields: { ...doc.fields, partyId: doc.partyId, date: doc.date, dueDate: doc.dueDate, notes: doc.notes },
    documents: children.map((c) => ({ type: c.type, phase: c.phase })), lineCount: doc.lines.length,
    openTasks: tasksOf(db, 'document', doc.id).filter((t) => !t.doneAt).length, metrics, approvals: valid,
    outstanding: openNow,
    role: viewer.role, isSuperuser: isSuper(pack, viewer.role),
  });
  const company = getCompany(db);
  const seller = doc.sellerSnapshot ?? { name: company.name, taxId: company.taxId, address: company.address, phone: company.phone, email: company.email, fields: company.fields };
  const buyer = doc.partySnapshot ?? { name: party.name, taxId: party.taxId, address: party.address, phone: party.phone, email: party.email, fields: party.fields };
  const issues = doc.phase === 'draft' ? jur.validateIssue({ doc, docType: dt, party, seller }) : [];
  const payments = all<Record<string, any>>(db,
    'SELECT p.*, a.amount AS allocated, a.refund AS refund FROM payments p JOIN payment_allocations a ON a.payment_id = p.id WHERE a.document_id = ? ORDER BY p.date', doc.id)
    .map((p) => ({ ...toPayment(p, []), allocated: p.allocated, refund: !!p.refund }));
  const mk = moneyKind(dt);
  const promptpay = typeof company.fields.promptpay_id === 'string' && mk === 'receivable' && doc.phase === 'issued' && (openNow ?? 0) > 0 && jur.paymentQr
    ? safeQr(() => jur.paymentQr!({ proxyId: company.fields.promptpay_id as string, amount: openNow!, reference: doc.number }))
    : null;
  // A credit/debit note must show the invoice it corrects, the original and corrected value and the difference.
  const noteBasis = dt.adjusts && source ? (() => {
    const before = allDocs(db, `source_id = ? AND id != ? AND phase IN ('issued','closed') AND issued_at < COALESCE(?, '9999')`, source.id, doc.id, doc.issuedAt ?? null)
      .filter((c) => docType(pack, c.type).adjusts);
    const original = source.totals.net + before.reduce((a, c) => a + (docType(pack, c.type).adjusts === 'credit' ? -c.totals.net : c.totals.net), 0);
    const difference = doc.totals.net;
    return { sourceNumber: source.number, sourceDate: source.date, original, corrected: dt.adjusts === 'credit' ? original - difference : original + difference, difference };
  })() : null;
  const items = new Map(doc.lines.filter((l) => l.itemId).map((l) => [l.itemId!, getItem(db, l.itemId!)]));
  return {
    document: doc, docType: dt, state: st, pipeline: pipeline(dt.workflow), party, job: doc.jobId ? getJob(db, doc.jobId) : null,
    source: source ? { id: source.id, number: source.number, type: source.type } : null,
    children: children.map((c) => docSummary(pack, c, settledAmount(db, c.id))),
    conversions: dt.convertsTo.map((t) => {
      const target = docType(pack, t);
      // Notes correct value, so they stay available for as long as the document is live.
      const open = !live ? 0 : target.adjusts ? doc.lines.length : openLines(doc, children, t).length;
      return { type: t, label: target.label, adjusts: target.adjusts ?? null, open };
    }),
    fulfilment: dt.convertsTo.length ? fulfilment(doc, children) : null,
    transitions: options(opts), approvals, issues, payments,
    balance: openNow ?? null, money: mk, noteBasis,
    retention: doc.retention ? { amount: doc.retention, releasedAt: doc.retentionReleasedAt ?? null } : null,
    wht: mk === 'receivable' ? whtOf(jur, doc, party) : [],
    seller, buyer, sellerIdentity: jur.describeTaxIdentity(seller, 'th'), buyerIdentity: jur.describeTaxIdentity(buyer, 'th'),
    sellerIdentityEn: jur.describeTaxIdentity(seller, 'en'), buyerIdentityEn: jur.describeTaxIdentity(buyer, 'en'),
    words: { th: jur.amountInWords(doc.totals.total, 'th'), en: jur.amountInWords(doc.totals.total, 'en') },
    promptpay, items: Object.fromEntries(items),
    tasks: tasksOf(db, 'document', doc.id), messages: messagesFor(db, 'document', [doc.id]), files: filesFor(db, [['document', doc.id]]),
    timeline: eventsFor(db, pack, 'document', doc.id),
    users: undefined,
  };
}

/** Expected withholding with a display label (the adapter only returns category ids). */
function whtOf(jur: Jurisdiction, doc: Document, party: NonNullable<ReturnType<typeof getParty>>) {
  return jur.suggestWht(doc, party).map((w) => ({ ...w, label: jur.whtCategories.find((c) => c.id === w.category)?.label ?? ({ en: w.category } as Label) }));
}

function safeQr(fn: () => string): string | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

// ───────────────────────────── Parties & items ─────────────────────────────

export function partyList(ctx: Ctx, q: { role?: string; search?: string }) {
  const { db, pack } = ctx;
  const settled = settledMap(db);
  const docs = allDocs(db, "phase IN ('issued','closed')");
  const bal = new Map<string, { receivable: number; payable: number; overdue: number }>();
  for (const d of docs) {
    const s = docSummary(pack, d, settled.get(d.id) ?? 0);
    if (!s.balance) continue;
    const b = bal.get(d.partyId) ?? { receivable: 0, payable: 0, overdue: 0 };
    if (s.money === 'receivable') b.receivable += s.balance;
    if (s.money === 'payable') b.payable += s.balance;
    if (s.overdue) b.overdue += s.balance;
    bal.set(d.partyId, b);
  }
  const where: string[] = ['archived = 0'];
  const params: unknown[] = [];
  if (q.role) (where.push("EXISTS (SELECT 1 FROM json_each(roles) WHERE value = ?)"), params.push(q.role));
  if (q.search) (where.push('(name LIKE ? OR tax_id LIKE ? OR phone LIKE ?)'), params.push(`%${q.search}%`, `%${q.search}%`, `%${q.search}%`));
  return all(db, `SELECT * FROM parties WHERE ${where.join(' AND ')} ORDER BY name`, ...params).map((r) => {
    const p = toParty(r);
    const openJobs = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM jobs WHERE party_id = ? AND phase = 'open'", p.id)?.n ?? 0;
    return { ...p, balance: bal.get(p.id) ?? { receivable: 0, payable: 0, overdue: 0 }, openJobs };
  });
}

export function partyView(ctx: Ctx, id: string) {
  const { db, pack } = ctx;
  const party = getParty(db, id);
  if (!party) return null;
  const settled = settledMap(db);
  const docs = allDocs(db, 'party_id = ?', id).map((d) => docSummary(pack, d, settled.get(d.id) ?? 0));
  const jobs = all(db, 'SELECT * FROM jobs WHERE party_id = ? OR contact_id = ? ORDER BY created_at DESC', id, id).map(toJob).map((j) => ({
    ...j, stateLabel: stateOf(jobType(pack, j.type).workflow, j.state).label, tone: stateOf(jobType(pack, j.type).workflow, j.state).tone,
  }));
  const payments = all<Record<string, any>>(db, 'SELECT * FROM payments WHERE party_id = ? ORDER BY date DESC', id).map((p) => toPayment(p, []));
  const receivable = docs.filter((d) => d.money === 'receivable').reduce((a, d) => a + (d.balance ?? 0), 0);
  const payable = docs.filter((d) => d.money === 'payable').reduce((a, d) => a + (d.balance ?? 0), 0);
  const overdue = docs.filter((d) => d.overdue).reduce((a, d) => a + (d.balance ?? 0), 0);
  return {
    party, parent: party.parentId ? getParty(db, party.parentId) : null,
    contacts: all(db, 'SELECT * FROM parties WHERE parent_id = ?', id).map(toParty),
    jobs, documents: docs, payments, balance: { receivable, payable, overdue },
    messages: messagesFor(db, 'party', [id]), files: filesFor(db, [['party', id]]), tasks: tasksOf(db, 'party', id),
    timeline: eventsFor(db, pack, 'party', id, 100),
  };
}

export function itemList(ctx: Ctx, q: { search?: string; kind?: string }) {
  const { db, pack } = ctx;
  const sp = stockPosition(db, pack);
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.kind) (where.push('kind = ?'), params.push(q.kind));
  if (q.search) (where.push('(sku LIKE ? OR name LIKE ?)'), params.push(`%${q.search}%`, `%${q.search}%`));
  return all(db, `SELECT * FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY active DESC, sku`, ...params).map((r) => {
    const it = toItem(r);
    const p = sp.get(it.id);
    return { ...it, stock: it.kind === 'stock' ? { onHand: p.onHand, reserved: p.reserved, incoming: p.incoming, available: round3(p.onHand - p.reserved) } : null };
  });
}

export function itemView(ctx: Ctx, id: string) {
  const { db, pack } = ctx;
  const item = getItem(db, id);
  if (!item) return null;
  const sp = stockPosition(db, pack);
  const p = sp.get(id);
  const moves = all(db,
    `SELECT m.*, d.number AS doc_number, d.type AS doc_type, j.number AS job_number FROM stock_moves m
     LEFT JOIN documents d ON d.id = m.document_id LEFT JOIN jobs j ON j.id = m.job_id WHERE m.item_id = ? ORDER BY m.at DESC LIMIT 200`, id)
    .map((m: any) => ({ ...toMove(m), docNumber: m.doc_number, docType: m.doc_type, jobNumber: m.job_number }));
  return {
    item, stock: item.kind === 'stock' ? { ...p, available: round3(p.onHand - p.reserved) } : null,
    reservedBy: sp.reservedBy.filter((r) => r.itemId === id).map((r) => ({ ...r, docNumber: getDocument(db, r.docId)?.number, jobNumber: r.jobId ? getJob(db, r.jobId)?.number : null })),
    moves, timeline: eventsFor(db, pack, 'item', id, 100),
  };
}

// ───────────────────────────── Attention ─────────────────────────────

/**
 * The home screen: what needs *my* attention, what changed since I last
 * looked, and where money is stuck.
 */
export function attention(ctx: Ctx, viewer: Viewer) {
  const { db, pack } = ctx;
  const role = viewer.role;
  const sup = isSuper(pack, role);
  const t = today();
  const settled = settledMap(db);
  const parties = partyNames(db);

  // 1. Approvals waiting on me.
  const approvals = all(db, "SELECT * FROM approvals WHERE state = 'pending' ORDER BY requested_at").map(toApproval)
    .filter((a) => sup || a.role === role)
    .map((a) => {
      const doc = a.subjectType === 'document' ? getDocument(db, a.subjectId) : undefined;
      return { ...a, document: doc ? docSummary(pack, doc, 0, parties) : null, maxDiscountPct: doc?.totals.maxDiscountPct ?? null };
    });

  // 2. Tasks for me or my role.
  const tasks = all<Record<string, any>>(db,
    `SELECT t.*, CASE t.subject_type WHEN 'job' THEN (SELECT number || ' · ' || title FROM jobs WHERE id = t.subject_id)
       WHEN 'document' THEN (SELECT COALESCE(number, type) FROM documents WHERE id = t.subject_id) ELSE '' END AS subject_label
     FROM tasks t WHERE t.done_at IS NULL AND (t.assignee_id = ? OR (t.assignee_id IS NULL AND (t.role = ? OR ?)))
     ORDER BY t.due IS NULL, t.due, t.created_at`, viewer.id, role, sup ? 1 : 0)
    .map((r) => ({ id: r.id, title: r.title, due: r.due, overdue: !!(r.due && r.due < t), subjectType: r.subject_type, subjectId: r.subject_id, subjectLabel: r.subject_label, assigneeId: r.assignee_id, role: r.role }));

  // 3. Jobs whose next step belongs to me (my role owns the state, or I own the job).
  const openJobs = all(db, "SELECT * FROM jobs WHERE phase = 'open' ORDER BY updated_at").map(toJob);
  const nextSteps = [];
  for (const job of openJobs) {
    const jt = jobType(pack, job.type);
    const st = stateOf(jt.workflow, job.state);
    const mine = st.ownerRole === role || (job.ownerId === viewer.id && !st.ownerRole);
    if (!mine && !(sup && st.ownerRole === undefined)) continue;
    const docs = all<{ type: string; phase: Document['phase'] }>(db, 'SELECT type, phase FROM documents WHERE job_id = ?', job.id);
    const openT = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM tasks WHERE subject_type = 'job' AND subject_id = ? AND done_at IS NULL", job.id)?.n ?? 0;
    const opts = evaluateTransitions(jt.workflow, job.state, {
      fields: { ...job.fields, title: job.title, partyId: job.partyId }, documents: docs, openTasks: openT, role, isSuperuser: sup,
    });
    const next = nextAction(opts);
    const idle = daysBetween(job.updatedAt.slice(0, 10), t);
    nextSteps.push({
      jobId: job.id, number: job.number, title: job.title, partyName: parties.get(job.partyId) ?? '', state: job.state, stateLabel: st.label,
      tone: st.tone ?? 'neutral', hint: st.hint ?? null, next: next ? options([next])[0] : null, idleDays: idle, dueDate: job.dueDate ?? null,
    });
  }
  nextSteps.sort((a, b) => b.idleDays - a.idleDays);

  // 4. Documents waiting on my role (drafts to issue, POs to receive...).
  const docsWaiting = allDocs(db, "phase IN ('draft','issued')")
    .map((d) => docSummary(pack, d, settled.get(d.id) ?? 0, parties))
    .filter((d) => d.ownerRole === role && !(d.money && d.phase === 'issued'))
    .slice(0, 30);

  // 5. Mentions I have not read.
  const mentionRows = all(db,
    `SELECT m.* FROM messages m WHERE (EXISTS (SELECT 1 FROM json_each(m.mentions) WHERE value = ? OR value = ?)) AND m.author_id != ?
     ORDER BY m.seq DESC LIMIT 30`, viewer.id, `role:${role}`, viewer.id).map(toMessage);
  const mentions = mentionRows
    .filter((m) => m.seq > lastRead(db, viewer.id, m.subjectType, m.subjectId))
    .map((m) => ({ ...m, subjectLabel: subjectLabel(db, m.subjectType, m.subjectId) }));

  // 6. Money: overdue receivables, payables due soon (only for roles that handle money).
  const seesMoney = hasCap(pack, role, 'money.write') || hasCap(pack, role, 'reports.read');
  let money = null;
  if (seesMoney) {
    const live = allDocs(db, "phase IN ('issued','closed')").map((d) => docSummary(pack, d, settled.get(d.id) ?? 0, parties));
  const open = live.filter((d) => (d.balance ?? 0) > 0);
  // Over-credited documents (a credit note larger than what was still owed): refund or leave as credit.
  const credits = live.filter((d) => (d.balance ?? 0) < 0);
  const retentionHeld = live.filter((d) => d.retentionHeld > 0);
    const soon = addDays(t, 7);
    money = {
      overdue: open.filter((d) => d.money === 'receivable' && d.overdue),
      receivableTotal: open.filter((d) => d.money === 'receivable').reduce((a, d) => a + d.balance!, 0),
      payableSoon: open.filter((d) => d.money === 'payable' && d.dueDate && d.dueDate <= soon),
      payableTotal: open.filter((d) => d.money === 'payable').reduce((a, d) => a + d.balance!, 0),
    };
  }

  // 7. Stock that blocks confirmed work.
  const seesStock = hasCap(pack, role, 'stock.write') || sup;
  const stock = seesStock ? shortages(db, pack) : [];

  // 8. What changed since my last visit (by other people or automation).
  const since = lastRead(db, viewer.id, 'home', 'home');
  const changedRows = all<Record<string, any>>(db,
    `SELECT * FROM events WHERE seq > ? AND actor_id != ? AND type NOT IN ('ledger.posted','settings.updated')
     ORDER BY seq DESC LIMIT 60`, since, viewer.id);
  const changes = changedRows.map((r) => {
    const e = rowToEvent(r as never);
    const d = describeEvent(db, pack, e);
    return d ? { ...d, where: whereOf(db, e) } : null;
  }).filter(Boolean);

  return { approvals, tasks, nextSteps, docsWaiting, mentions, money, stock, changes, since, today: t };
}

function whereOf(db: DatabaseSync, e: JournalEvent) {
  const link = one<{ subject_type: string; subject_id: string }>(db,
    "SELECT subject_type, subject_id FROM event_links WHERE seq = ? ORDER BY CASE subject_type WHEN 'job' THEN 0 WHEN 'document' THEN 1 WHEN 'party' THEN 2 ELSE 3 END LIMIT 1", e.seq);
  if (!link) return null;
  return { subjectType: link.subject_type, subjectId: link.subject_id, label: subjectLabel(db, link.subject_type, link.subject_id) };
}

export function subjectLabel(db: DatabaseSync, type: string, id: string): string {
  if (type === 'job') {
    const j = one<{ number: string; title: string }>(db, 'SELECT number, title FROM jobs WHERE id = ?', id);
    return j ? `${j.number} · ${j.title}` : '';
  }
  if (type === 'document') return one<{ n: string }>(db, "SELECT COALESCE(number, 'Draft') AS n FROM documents WHERE id = ?", id)?.n ?? '';
  if (type === 'party') return one<{ name: string }>(db, 'SELECT name FROM parties WHERE id = ?', id)?.name ?? '';
  if (type === 'item') return one<{ sku: string }>(db, 'SELECT sku FROM items WHERE id = ?', id)?.sku ?? '';
  if (type === 'payment') return one<{ number: string }>(db, 'SELECT number FROM payments WHERE id = ?', id)?.number ?? '';
  return '';
}

function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);
}
function addDays(d: string, n: number) {
  return new Date(Date.parse(d) + n * 86400_000).toISOString().slice(0, 10);
}

// ───────────────────────────── Money & reports ─────────────────────────────

export function moneyOverview(ctx: Ctx) {
  const { db, pack } = ctx;
  const settled = settledMap(db);
  const parties = partyNames(db);
  const t = today();
  const live = allDocs(db, "phase IN ('issued','closed')").map((d) => docSummary(pack, d, settled.get(d.id) ?? 0, parties));
  const open = live.filter((d) => (d.balance ?? 0) > 0);
  // Over-credited documents (a credit note larger than what was still owed): refund or leave as credit.
  const credits = live.filter((d) => (d.balance ?? 0) < 0);
  const retentionHeld = live.filter((d) => d.retentionHeld > 0);
  const age = (due: string | null) => (due ? Math.max(0, daysBetween(due, t)) : 0);
  const bucket = (days: number) => (days === 0 ? 'current' : days <= 30 ? '1-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+');
  const aging = (list: typeof open) => {
    const b: Record<string, number> = { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
    for (const d of list) b[bucket(age(d.dueDate))] += d.balance!;
    return b;
  };
  const receivables = open.filter((d) => d.money === 'receivable').map((d) => ({ ...d, daysOverdue: age(d.dueDate) }));
  const payables = open.filter((d) => d.money === 'payable').map((d) => ({ ...d, daysOverdue: age(d.dueDate) }));
  const month = t.slice(0, 7);
  const payments = all<Record<string, any>>(db, 'SELECT * FROM payments ORDER BY date DESC, created_at DESC LIMIT 100')
    .map((p) => ({ ...toPayment(p, all<{ document_id: string; amount: number; refund: number; number: string | null }>(db, 'SELECT a.*, d.number FROM payment_allocations a JOIN documents d ON d.id = a.document_id WHERE a.payment_id = ?', p.id).map((a) => ({ documentId: a.document_id, amount: a.amount, number: a.number, refund: !!a.refund }))), partyName: parties.get(p.party_id) ?? '' }));
  const inThisMonth = payments.filter((p) => !p.voided && p.direction === 'in' && p.date.startsWith(month)).reduce((a, p) => a + p.amount, 0);
  const outThisMonth = payments.filter((p) => !p.voided && p.direction === 'out' && p.date.startsWith(month)).reduce((a, p) => a + p.amount, 0);
  const vat = vatSummary(ctx, month);
  return { receivables, payables, credits, retentionHeld, agingReceivable: aging(receivables), agingPayable: aging(payables), payments, inThisMonth, outThisMonth, vat, month };
}

function vatSummary(ctx: Ctx, month: string) {
  const sales = vatReport(ctx, 'sales', month);
  const purchases = vatReport(ctx, 'purchase', month);
  const output = sales.rows.reduce((a, r) => a + r.vat, 0);
  const input = purchases.rows.reduce((a, r) => a + r.vat, 0);
  return { output, input, net: output - input };
}

/** Output / input tax report rows for one month (basis for the jurisdiction's VAT return). */
/**
 * Output/input tax report for a month. Credit notes count negative; each note
 * row names the document it corrects so the report can be checked line by line.
 * Counterparty tax ID and branch are included for every row.
 */
export function vatReport(ctx: Ctx, direction: 'sales' | 'purchase', month: string) {
  const { db, pack } = ctx;
  const types = pack.documentTypes.filter((t) => t.direction === direction && (direction === 'sales' ? t.effects.includes('receivable') : t.effects.includes('payable')));
  if (!types.length) return { month, rows: [] as any[], totals: { net: 0, vat: 0, total: 0 } };
  const byId = new Map(types.map((t) => [t.id, t]));
  const docs = allDocs(db, `type IN (${types.map(() => '?').join(',')}) AND number IS NOT NULL AND substr(date,1,7) = ?`, ...types.map((t) => t.id), month)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.number ?? '').localeCompare(b.number ?? ''));
  const parties = new Map<string, ReturnType<typeof getParty>>();
  const sources = new Map<string, Document | undefined>();
  const rows = docs.map((d) => {
    const p = d.partySnapshot ?? (() => {
      if (!parties.has(d.partyId)) parties.set(d.partyId, getParty(db, d.partyId));
      return parties.get(d.partyId);
    })();
    const dt = byId.get(d.type)!;
    const sign = dt.adjusts === 'credit' ? -1 : 1;
    const src = dt.adjusts && d.sourceId ? (sources.has(d.sourceId) ? sources.get(d.sourceId) : (sources.set(d.sourceId, getDocument(db, d.sourceId)), sources.get(d.sourceId))) : undefined;
    const voided = d.phase === 'void';
    const extNumber = (x: Document) => direction === 'purchase' ? String(x.fields.supplier_ref ?? x.number) : x.number;
    return {
      id: d.id, date: d.date, number: extNumber(d), internalNumber: d.number, type: d.type, kind: dt.adjusts ?? 'invoice',
      partyName: p?.name ?? '', taxId: p?.taxId ?? '', branch: (p?.fields?.branch_code as string) ?? '',
      net: voided ? 0 : sign * d.totals.net, vat: voided ? 0 : sign * d.totals.tax, total: voided ? 0 : sign * d.totals.total, voided,
      corrects: src ? { id: src.id, number: extNumber(src), date: src.date } : null,
      reason: dt.adjusts ? (d.fields.reason as string | undefined) ?? null : null,
    };
  });
  const sum = (k: 'net' | 'vat' | 'total') => rows.reduce((a, r) => a + r[k], 0);
  return { month, rows, totals: { net: sum('net'), vat: sum('vat'), total: sum('total') } };
}

export function whtReport(ctx: Ctx, month: string) {
  const { db, jur } = ctx;
  const rows = all<Record<string, any>>(db,
    `SELECT p.*, pa.name AS party_name, pa.tax_id, pa.kind AS party_kind, pa.address FROM payments p JOIN parties pa ON pa.id = p.party_id
     WHERE p.wht_amount > 0 AND p.voided = 0 AND substr(p.date,1,7) = ? ORDER BY p.date`, month);
  const cat = (id: string | null) => jur.whtCategories.find((c) => c.id === id);
  const map = (r: Record<string, any>) => ({
    id: r.id, number: r.number, date: r.date, partyName: r.party_name, taxId: r.tax_id, partyKind: r.party_kind,
    category: r.wht_category, categoryLabel: cat(r.wht_category)?.label ?? null, rate: cat(r.wht_category)?.rate ?? null,
    base: cat(r.wht_category)?.rate ? Math.round(r.wht_amount / cat(r.wht_category)!.rate) : null,
    wht: r.wht_amount, certificate: r.wht_certificate,
    // Thai filing form hint for tax we withheld: individuals → PND 3, juristic persons → PND 53.
    form: r.direction === 'out' ? (r.party_kind === 'person' ? 'PND3' : 'PND53') : null,
  });
  return {
    month,
    withheldFromUs: rows.filter((r) => r.direction === 'in').map(map),
    withheldByUs: rows.filter((r) => r.direction === 'out').map(map),
  };
}

export function stockReport(ctx: Ctx) {
  const items = itemList(ctx, { kind: 'stock' });
  return items.map((i) => ({ id: i.id, sku: i.sku, name: i.name, uom: i.uom, ...i.stock!, costPrice: i.costPrice, value: Math.round(i.costPrice * i.stock!.onHand) }));
}

export function trialBalance(ctx: Ctx, from?: string, to?: string) {
  const { db, jur } = ctx;
  const rows = all<{ account: string; debit: number; credit: number }>(db,
    `SELECT l.account, SUM(l.debit) AS debit, SUM(l.credit) AS credit FROM ledger_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE (? IS NULL OR e.date >= ?) AND (? IS NULL OR e.date <= ?) GROUP BY l.account ORDER BY l.account`, from ?? null, from ?? null, to ?? null, to ?? null);
  const chart = allAccounts({ db, jur });
  return rows.map((r) => {
    const a = chart.find((x) => x.code === r.account);
    return { ...r, name: a?.name ?? { en: r.account }, type: a?.type ?? null, balance: r.debit - r.credit };
  });
}

// ───────────────────────────── Activity & search ─────────────────────────────

export function activity(ctx: Ctx, q: { subjectType?: string; subjectId?: string; before?: string; limit?: string }) {
  const { db, pack } = ctx;
  const limit = Math.min(200, Number(q.limit ?? 100));
  const before = q.before ? Number(q.before) : Number.MAX_SAFE_INTEGER;
  if (q.subjectType && q.subjectId) return eventsFor(db, pack, q.subjectType, q.subjectId, limit);
  const rows = all<Record<string, any>>(db, "SELECT * FROM events WHERE seq < ? AND type != 'ledger.posted' ORDER BY seq DESC LIMIT ?", before, limit);
  return rows.map((r) => {
    const e = rowToEvent(r as never);
    const d = describeEvent(db, pack, e);
    return d ? { ...d, where: whereOf(db, e) } : null;
  }).filter(Boolean);
}

export function search(ctx: Ctx, text: string) {
  const { db, pack } = ctx;
  const q = `%${text.trim()}%`;
  if (!text.trim()) return [];
  const out: { type: string; id: string; title: string; subtitle: string; label?: Label }[] = [];
  for (const r of all<Record<string, any>>(db, 'SELECT j.id, j.number, j.title, p.name FROM jobs j JOIN parties p ON p.id = j.party_id WHERE j.number LIKE ? OR j.title LIKE ? OR p.name LIKE ? ORDER BY j.created_at DESC LIMIT 8', q, q, q)) {
    out.push({ type: 'job', id: r.id, title: `${r.number} · ${r.title}`, subtitle: r.name });
  }
  for (const r of all<Record<string, any>>(db, 'SELECT d.id, d.number, d.type, p.name FROM documents d JOIN parties p ON p.id = d.party_id WHERE d.number LIKE ? OR p.name LIKE ? ORDER BY d.created_at DESC LIMIT 8', q, q)) {
    out.push({ type: 'document', id: r.id, title: r.number ?? 'Draft', subtitle: r.name, label: docType(pack, r.type).label });
  }
  for (const r of all<Record<string, any>>(db, 'SELECT id, name, phone, tax_id FROM parties WHERE name LIKE ? OR phone LIKE ? OR tax_id LIKE ? LIMIT 8', q, q, q)) {
    out.push({ type: 'party', id: r.id, title: r.name, subtitle: r.phone ?? r.tax_id ?? '' });
  }
  for (const r of all<Record<string, any>>(db, 'SELECT id, sku, name FROM items WHERE sku LIKE ? OR name LIKE ? LIMIT 8', q, q)) {
    out.push({ type: 'item', id: r.id, title: r.sku, subtitle: r.name });
  }
  return out;
}
