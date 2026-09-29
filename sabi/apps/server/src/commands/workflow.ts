/** Workflow execution for jobs and documents, including document effects. */
import type { Document, Job, TransitionDef, PartySnapshot, StockMove, JournalEntry } from '@sabi/core';
import {
  autoTransition, checkGuard, docType, jobType, postDocument, reverse, stateOf, transitionsFrom,
} from '@sabi/core';
import { all, one } from '../db.ts';
import { fail, newId, SYSTEM, type Scope } from '../engine.ts';
import { getCompany, getDocument, getJob, getParty, settledAmount } from '../repo.ts';
import { addDays, documentGuardContext, formatNumber, jobGuardContext, nextSequence, systemMessage } from './util.ts';

function findTransition(from: string, transitions: TransitionDef[], id: string): TransitionDef {
  const t = transitions.find((x) => x.id === id);
  if (!t) fail('invalid', `Unknown transition '${id}'`);
  if (t!.from !== '*' && !t!.from.includes(from)) fail('invalid_state', `Cannot '${id}' from state '${from}'`, undefined, 409);
  return t!;
}

// ───────────────────────────── Jobs ─────────────────────────────

export function transitionJob(s: Scope, job: Job, transitionId: string, reason?: string, auto = false): void {
  const jt = jobType(s.pack, job.type);
  const t = findTransition(job.state, transitionsFrom(jt.workflow, job.state), transitionId);
  if (!auto) {
    s.require('jobs.write');
    const missing = checkGuard(t, jobGuardContext(s, job, s.actor.role));
    if (missing.length) fail('blocked', 'This step is blocked', { missing }, 409);
    if (t.requireReason && !reason) fail('reason_required', 'Please give a reason', undefined, 422);
  }
  const target = stateOf(jt.workflow, t.to);
  const actor = auto ? SYSTEM : s.actor;
  s.emit({
    type: 'job.transitioned', subjectType: 'job', subjectId: job.id,
    data: { id: job.id, from: job.state, to: t.to, phase: target.phase, transitionId: t.id, reason, auto: auto || undefined },
  }, actor);
  runActions(s, 'job', job.id, t, actor);
}

function runActions(s: Scope, subjectType: 'job' | 'document', subjectId: string, t: TransitionDef, actor = s.actor) {
  for (const a of t.actions ?? []) {
    if ('createTask' in a) {
      s.emit({
        type: 'task.created', subjectType, subjectId,
        data: {
          task: {
            id: newId('tsk'), subjectType, subjectId, title: a.createTask.title.th ?? a.createTask.title.en,
            role: a.createTask.role, due: a.createTask.dueInDays !== undefined ? addDays(s.today(), a.createTask.dueInDays) : undefined,
            createdBy: actor.id, createdAt: s.at,
          },
        },
      }, actor);
    } else if ('notifyRole' in a) {
      systemMessage(s, subjectType, subjectId, a.message ?? { en: 'Your attention is needed.', th: 'ต้องการความช่วยเหลือจากคุณ' }, [`role:${a.notifyRole}`]);
    }
  }
}

// ───────────────────────────── Documents ─────────────────────────────

function snapshotOfParty(p: NonNullable<ReturnType<typeof getParty>>): PartySnapshot {
  return { name: p.name, taxId: p.taxId, address: p.address, phone: p.phone, email: p.email, fields: p.fields };
}

export function transitionDocument(s: Scope, doc: Document, transitionId: string, reason?: string, auto = false) {
  const dt = docType(s.pack, doc.type);
  const t = findTransition(doc.state, transitionsFrom(dt.workflow, doc.state), transitionId);
  const target = stateOf(dt.workflow, t.to);
  const fromPhase = doc.phase;
  const toPhase = target.phase;
  const issuing = fromPhase === 'draft' && (toPhase === 'issued' || toPhase === 'closed');
  const voiding = toPhase === 'void';
  const warnings: unknown[] = [];

  if (!auto) {
    s.require('documents.write');
    if (issuing) s.require('documents.issue');
    if (voiding && fromPhase !== 'draft') s.require('documents.void');
    const missing = checkGuard(t, documentGuardContext(s, doc, s.actor.role));
    if (missing.length) fail('blocked', 'This step is blocked', { missing }, 409);
    if (t.requireReason && !reason) fail('reason_required', 'Please give a reason', undefined, 422);
  }

  let issue: Record<string, unknown> | undefined;
  if (issuing) {
    const party = getParty(s.db, doc.partyId);
    if (!party) fail('invalid', 'Document has no valid party');
    const company = getCompany(s.db);
    const seller: PartySnapshot = { name: company.name, taxId: company.taxId, address: company.address, phone: company.phone, email: company.email, fields: company.fields };
    const issues = s.jur.validateIssue({ doc, docType: dt, party: party!, seller });
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length) fail('jurisdiction', 'Required particulars are missing', { issues }, 422);
    warnings.push(...issues.filter((i) => i.level === 'warning'));
    if (doc.lines.some((l) => l.qty <= 0)) fail('invalid', 'Every line needs a quantity above zero', undefined, 422);
    const year = doc.date.slice(0, 4);
    const key = `doc:${doc.type}:${year}`;
    const n = nextSequence(s, key);
    issue = {
      number: formatNumber(dt.numbering.prefix, year, n),
      sequence: { key, n },
      partySnapshot: snapshotOfParty(party!),
      sellerSnapshot: seller,
    };
  }

  if (voiding) {
    const liveChildren = one<{ n: number }>(s.db, "SELECT COUNT(*) AS n FROM documents WHERE source_id = ? AND phase != 'void'", doc.id);
    if ((liveChildren?.n ?? 0) > 0) fail('has_children', 'Void the documents created from this one first', undefined, 409);
    if (settledAmount(s.db, doc.id) > 0) fail('has_payments', 'Void the payments allocated to this document first', undefined, 409);
  }

  const actor = auto ? SYSTEM : s.actor;
  s.emit({
    type: 'document.transitioned', subjectType: 'document', subjectId: doc.id,
    data: { id: doc.id, from: doc.state, to: t.to, phase: toPhase, transitionId: t.id, reason, auto: auto || undefined, issue },
  }, actor);

  if (issuing) warnings.push(...applyEffects(s, getDocument(s.db, doc.id)!, actor));
  if (voiding && fromPhase !== 'draft') reverseEffects(s, doc, actor);
  runActions(s, 'document', doc.id, t, actor);
  return { warnings };
}

function applyEffects(s: Scope, doc: Document, actor = s.actor): unknown[] {
  const dt = docType(s.pack, doc.type);
  const warnings: unknown[] = [];
  const loc = typeof doc.fields.location === 'string' ? doc.fields.location : s.pack.defaultLocation;
  const stockLines = doc.lines.filter((l) => l.itemId && l.itemKind === 'stock' && l.qty > 0);
  const moves = (from: string, to: string): StockMove[] =>
    stockLines.map((l) => ({
      id: newId('mv'), itemId: l.itemId!, qty: l.qty, from, to, documentId: doc.id, jobId: doc.jobId, lineId: l.id,
      at: s.at, by: actor.id,
    }));
  if (dt.effects.includes('stock_out') && stockLines.length) {
    for (const l of stockLines) {
      const r = one<{ q: number }>(s.db,
        'SELECT (SELECT COALESCE(SUM(qty),0) FROM stock_moves WHERE item_id = ? AND to_loc = ?) - (SELECT COALESCE(SUM(qty),0) FROM stock_moves WHERE item_id = ? AND from_loc = ?) AS q',
        l.itemId, loc, l.itemId, loc);
      if ((r?.q ?? 0) < l.qty) {
        warnings.push({ level: 'warning', code: 'negative_stock', message: { en: `Stock of "${l.description}" goes below zero.`, th: `สต็อก "${l.description}" ติดลบ` } });
      }
    }
    s.emit({ type: 'stock.moved', subjectType: 'document', subjectId: doc.id, data: { moves: moves(loc, 'customer') } }, actor);
  }
  if (dt.effects.includes('stock_in') && stockLines.length) {
    s.emit({ type: 'stock.moved', subjectType: 'document', subjectId: doc.id, data: { moves: moves('supplier', loc) } }, actor);
  }
  const entry = postDocument(doc, dt, s.jur.postingAccounts, newId('je'));
  if (entry) s.emit({ type: 'ledger.posted', subjectType: 'document', subjectId: doc.id, data: { entry } }, actor);
  return warnings;
}

function reverseEffects(s: Scope, doc: Document, actor = s.actor) {
  const moves = all<Record<string, any>>(s.db, 'SELECT * FROM stock_moves WHERE document_id = ?', doc.id);
  if (moves.length) {
    s.emit({
      type: 'stock.moved', subjectType: 'document', subjectId: doc.id,
      data: {
        moves: moves.map((m) => ({
          id: newId('mv'), itemId: m.item_id, qty: m.qty, from: m.to_loc, to: m.from_loc, documentId: doc.id,
          jobId: m.job_id ?? undefined, lineId: m.line_id ?? undefined, note: 'void', at: s.at, by: actor.id,
        })),
      },
    }, actor);
  }
  reverseLedger(s, 'document', doc.id, actor);
}

export function reverseLedger(s: Scope, sourceType: 'document' | 'payment', sourceId: string, actor = s.actor) {
  const entries = all<{ id: string; date: string; memo: string }>(s.db,
    'SELECT id, date, memo FROM journal_entries WHERE source_type = ? AND source_id = ? AND reversal_of IS NULL AND reversed_by IS NULL',
    sourceType, sourceId);
  for (const e of entries) {
    const lines = all<{ account: string; debit: number; credit: number; party_id: string | null }>(s.db,
      'SELECT account, debit, credit, party_id FROM ledger_lines WHERE entry_id = ? ORDER BY idx', e.id);
    const original: JournalEntry = {
      id: e.id, date: e.date, memo: e.memo, source: { type: sourceType, id: sourceId },
      lines: lines.map((l) => ({ account: l.account, debit: l.debit, credit: l.credit, ...(l.party_id ? { partyId: l.party_id } : {}) })),
    };
    s.emit({ type: 'ledger.posted', subjectType: sourceType, subjectId: sourceId, data: { entry: reverse(original, newId('je'), s.today()) } }, actor);
  }
}

// ───────────────────────────── Settle (automations) ─────────────────────────────

/**
 * After a command, apply configured `auto` transitions on every touched job /
 * document (and their parents) until nothing changes. Runs inside the same
 * transaction, as the system actor, so the journal shows who did what.
 */
export function settle(s: Scope): void {
  for (let round = 0; round < 10; round++) {
    const keys = new Set<string>();
    for (const k of s.touched) {
      keys.add(k);
      const [t, id] = k.split(':');
      if (t === 'document') {
        const d = one<{ source_id: string | null; job_id: string | null }>(s.db, 'SELECT source_id, job_id FROM documents WHERE id = ?', id);
        if (d?.source_id) keys.add(`document:${d.source_id}`);
        if (d?.job_id) keys.add(`job:${d.job_id}`);
      }
    }
    let changed = false;
    for (const k of keys) {
      const [t, id] = k.split(':');
      if (t === 'document') {
        const doc = getDocument(s.db, id);
        if (!doc || doc.phase === 'void') continue;
        const wf = docType(s.pack, doc.type).workflow;
        const tr = autoTransition(wf, doc.state, documentGuardContext(s, doc, null));
        if (tr) {
          transitionDocument(s, doc, tr.id, undefined, true);
          changed = true;
        }
      } else if (t === 'job') {
        const job = getJob(s.db, id);
        if (!job) continue;
        const wf = jobType(s.pack, job.type).workflow;
        const tr = autoTransition(wf, job.state, jobGuardContext(s, job, null));
        if (tr) {
          transitionJob(s, job, tr.id, undefined, true);
          changed = true;
        }
      }
    }
    if (!changed) return;
  }
}
