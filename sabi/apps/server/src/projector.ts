/**
 * Projector: applies one journal event to the read tables.
 *
 * MUST be deterministic and depend only on the event + current projection
 * state, so that `sabi verify` can rebuild every table from the journal.
 * No clocks, no randomness, no config lookups that could change over time.
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  Approval, Document, FileRecord, Item, Job, JournalEntry, JournalEvent, Message, Party, Payment, StockMove, Task,
} from '@sabi/core';
import { all, one, run } from './db.ts';

type D = Record<string, any>;
const js = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

function bumpSequence(db: DatabaseSync, seq: { key: string; n: number } | undefined) {
  if (!seq) return;
  run(db, 'INSERT INTO sequences (key, last) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET last = MAX(last, excluded.last)', seq.key, seq.n);
}

function writeLines(db: DatabaseSync, doc: Pick<Document, 'id' | 'lines'>) {
  run(db, 'DELETE FROM document_lines WHERE document_id = ?', doc.id);
  doc.lines.forEach((l, i) =>
    run(db,
      `INSERT INTO document_lines (id, document_id, position, item_id, description, measures, qty, uom, unit_price,
        discount_pct, tax_code, wht_category, item_kind, source_line_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      l.id, doc.id, i, l.itemId, l.description, js(l.measures), l.qty, l.uom, l.unitPrice, l.discountPct ?? 0,
      l.taxCode, l.whtCategory, l.itemKind, l.sourceLineId),
  );
}

const COLS: Record<string, Record<string, string>> = {
  parties: { kind: 'kind', name: 'name', roles: 'roles', taxId: 'tax_id', phone: 'phone', email: 'email', address: 'address', parentId: 'parent_id', paymentTermsDays: 'payment_terms_days', creditLimit: 'credit_limit', fields: 'fields', archived: 'archived' },
  items: { sku: 'sku', name: 'name', kind: 'kind', uom: 'uom', salePrice: 'sale_price', costPrice: 'cost_price', taxCode: 'tax_code', whtCategory: 'wht_category', measureTemplate: 'measure_template', fields: 'fields', active: 'active' },
  jobs: { title: 'title', partyId: 'party_id', contactId: 'contact_id', ownerId: 'owner_id', dueDate: 'due_date', fields: 'fields' },
  documents: { partyId: 'party_id', date: 'date', dueDate: 'due_date', priceMode: 'price_mode', notes: 'notes', fields: 'fields', totals: 'totals' },
  users: { name: 'name', role: 'role', locale: 'locale', active: 'active' },
};
const JSON_COLS = new Set(['roles', 'address', 'fields', 'totals']);

function patchRow(db: DatabaseSync, table: string, id: string, patch: D, updatedAt?: string) {
  const map = COLS[table];
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = map[k];
    if (!col) continue;
    sets.push(`${col} = ?`);
    vals.push(JSON_COLS.has(col) ? js(v) : typeof v === 'boolean' ? (v ? 1 : 0) : v ?? null);
  }
  if (table === 'documents' && patch.totals) {
    sets.push('total = ?');
    vals.push(patch.totals.total);
  }
  if (updatedAt && table !== 'users') {
    sets.push('updated_at = ?');
    vals.push(updatedAt);
  }
  if (sets.length === 0) return;
  run(db, `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
}

export function project(db: DatabaseSync, e: JournalEvent): void {
  const d = e.data as D;
  switch (e.type) {
    case 'company.updated':
      run(db, "INSERT INTO settings (key, value) VALUES ('company', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(d.company));
      break;
    case 'settings.updated':
      run(db, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', d.key, JSON.stringify(d.value));
      break;

    case 'user.created': {
      const u = d.user;
      run(db, 'INSERT INTO users (id, name, username, role, locale, active, created_at) VALUES (?,?,?,?,?,?,?)',
        u.id, u.name, u.username, u.role, u.locale, u.active ? 1 : 0, u.createdAt);
      break;
    }
    case 'user.updated':
      patchRow(db, 'users', d.id, d.patch);
      break;

    case 'party.created': {
      const p: Party = d.party;
      run(db,
        `INSERT INTO parties (id, kind, name, roles, tax_id, phone, email, address, parent_id, payment_terms_days,
          credit_limit, fields, archived, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        p.id, p.kind, p.name, js(p.roles), p.taxId, p.phone, p.email, js(p.address), p.parentId, p.paymentTermsDays,
        p.creditLimit, js(p.fields ?? {}), p.archived ? 1 : 0, p.createdAt, p.updatedAt);
      break;
    }
    case 'party.updated':
      patchRow(db, 'parties', d.id, d.patch, d.updatedAt);
      break;

    case 'item.created': {
      const i: Item = d.item;
      run(db,
        `INSERT INTO items (id, sku, name, kind, uom, sale_price, cost_price, tax_code, wht_category, measure_template,
          fields, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        i.id, i.sku, i.name, i.kind, i.uom, i.salePrice, i.costPrice, i.taxCode, i.whtCategory, i.measureTemplate,
        js(i.fields ?? {}), i.active ? 1 : 0, i.createdAt, i.updatedAt);
      break;
    }
    case 'item.updated':
      patchRow(db, 'items', d.id, d.patch, d.updatedAt);
      break;

    case 'job.created': {
      const jb: Job = d.job;
      run(db,
        `INSERT INTO jobs (id, number, type, title, party_id, contact_id, owner_id, state, phase, due_date, fields,
          created_at, updated_at, closed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        jb.id, jb.number, jb.type, jb.title, jb.partyId, jb.contactId, jb.ownerId, jb.state, jb.phase, jb.dueDate,
        js(jb.fields ?? {}), jb.createdAt, jb.updatedAt, jb.closedAt);
      bumpSequence(db, d.sequence);
      break;
    }
    case 'job.updated':
      patchRow(db, 'jobs', d.id, d.patch, d.updatedAt);
      break;
    case 'job.transitioned':
      run(db, 'UPDATE jobs SET state = ?, phase = ?, updated_at = ?, closed_at = ? WHERE id = ?',
        d.to, d.phase, e.at, d.phase === 'open' ? null : e.at, d.id);
      break;

    case 'document.created': {
      const doc: Document = d.document;
      run(db,
        `INSERT INTO documents (id, type, number, state, phase, party_id, job_id, source_id, date, due_date, price_mode,
          notes, fields, totals, total, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        doc.id, doc.type, doc.number, doc.state, doc.phase, doc.partyId, doc.jobId, doc.sourceId, doc.date, doc.dueDate,
        doc.priceMode, doc.notes, js(doc.fields ?? {}), js(doc.totals), doc.totals.total, doc.createdBy, doc.createdAt, doc.updatedAt);
      writeLines(db, doc);
      break;
    }
    case 'document.updated':
      patchRow(db, 'documents', d.id, d.patch, d.updatedAt);
      if (d.patch.lines) writeLines(db, { id: d.id, lines: d.patch.lines });
      break;
    case 'document.transitioned': {
      run(db, 'UPDATE documents SET state = ?, phase = ?, updated_at = ? WHERE id = ?', d.to, d.phase, e.at, d.id);
      if (d.issue) {
        run(db, 'UPDATE documents SET number = ?, party_snapshot = ?, seller_snapshot = ?, issued_at = ?, issued_by = ? WHERE id = ?',
          d.issue.number, js(d.issue.partySnapshot), js(d.issue.sellerSnapshot), e.at, e.actorId, d.id);
        bumpSequence(db, d.issue.sequence);
      }
      if (d.phase === 'void') run(db, 'UPDATE documents SET void_reason = ? WHERE id = ?', d.reason ?? null, d.id);
      break;
    }

    case 'stock.moved':
      for (const m of d.moves as StockMove[]) {
        run(db,
          'INSERT INTO stock_moves (id, item_id, qty, from_loc, to_loc, document_id, job_id, line_id, note, at, by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          m.id, m.itemId, m.qty, m.from, m.to, m.documentId, m.jobId, m.lineId, m.note, m.at, m.by);
      }
      break;

    case 'ledger.posted': {
      const en: JournalEntry = d.entry;
      run(db, 'INSERT INTO journal_entries (id, date, memo, source_type, source_id, reversal_of) VALUES (?,?,?,?,?,?)',
        en.id, en.date, en.memo, en.source.type, en.source.id, en.reversalOf);
      en.lines.forEach((l, i) =>
        run(db, 'INSERT INTO ledger_lines (entry_id, idx, date, account, debit, credit, party_id) VALUES (?,?,?,?,?,?,?)',
          en.id, i, en.date, l.account, l.debit, l.credit, l.partyId));
      if (en.reversalOf) run(db, 'UPDATE journal_entries SET reversed_by = ? WHERE id = ?', en.id, en.reversalOf);
      break;
    }

    case 'payment.recorded': {
      const p: Payment = d.payment;
      run(db,
        `INSERT INTO payments (id, number, direction, party_id, date, method, amount, wht_amount, wht_category,
          wht_certificate, reference, voided, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
        p.id, p.number, p.direction, p.partyId, p.date, p.method, p.amount, p.whtAmount, p.whtCategory,
        p.whtCertificate, p.reference, p.createdBy, p.createdAt);
      for (const a of p.allocations) run(db, 'INSERT INTO payment_allocations (payment_id, document_id, amount) VALUES (?,?,?)', p.id, a.documentId, a.amount);
      bumpSequence(db, d.sequence);
      break;
    }
    case 'payment.voided':
      run(db, 'UPDATE payments SET voided = 1, void_reason = ? WHERE id = ?', d.reason, d.id);
      break;

    case 'task.created': {
      const t: Task = d.task;
      run(db,
        'INSERT INTO tasks (id, subject_type, subject_id, title, assignee_id, role, due, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        t.id, t.subjectType, t.subjectId, t.title, t.assigneeId, t.role, t.due, t.createdBy, t.createdAt);
      break;
    }
    case 'task.updated':
      run(db, 'UPDATE tasks SET title = COALESCE(?, title), assignee_id = ?, due = ? WHERE id = ?', d.title, d.assigneeId, d.due, d.id);
      break;
    case 'task.completed':
      run(db, 'UPDATE tasks SET done_at = ?, done_by = ? WHERE id = ?', e.at, e.actorId, d.id);
      break;
    case 'task.reopened':
      run(db, 'UPDATE tasks SET done_at = NULL, done_by = NULL WHERE id = ?', d.id);
      break;

    case 'message.posted': {
      const m: Message & { label?: unknown } = d.message;
      run(db,
        'INSERT INTO messages (id, seq, subject_type, subject_id, author_id, body, mentions, file_ids, meta, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        m.id, e.seq, m.subjectType, m.subjectId, m.authorId, m.body, js(m.mentions), js(m.fileIds), m.label ? js({ label: m.label }) : null, m.createdAt);
      break;
    }
    case 'file.attached': {
      const f: FileRecord = d.file;
      run(db,
        'INSERT INTO files (id, sha256, name, mime, size, subject_type, subject_id, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        f.id, f.sha256, f.name, f.mime, f.size, f.subjectType, f.subjectId, f.uploadedBy, f.createdAt);
      break;
    }
    case 'approval.requested': {
      const a: Approval = d.approval;
      run(db,
        `INSERT INTO approvals (id, subject_type, subject_id, transition_id, role, reason, state, requested_by, requested_at)
          VALUES (?,?,?,?,?,?,?,?,?)`,
        a.id, a.subjectType, a.subjectId, a.transitionId, a.role, a.reason, a.state, a.requestedBy, a.requestedAt);
      break;
    }
    case 'approval.decided':
      run(db, 'UPDATE approvals SET state = ?, decided_by = ?, decided_at = ?, comment = ? WHERE id = ?', d.state, e.actorId, e.at, d.comment, d.id);
      break;
    case 'approval.invalidated':
      run(db, "UPDATE approvals SET state = 'stale' WHERE subject_type = ? AND subject_id = ? AND state IN ('pending','approved')", e.subjectType, e.subjectId);
      break;

    default:
      throw new Error(`Projector: unknown event type '${e.type}'`);
  }
  link(db, e);
}

/** Relate an event to every subject whose timeline should show it. */
function link(db: DatabaseSync, e: JournalEvent): void {
  if (e.type === 'ledger.posted' || e.type === 'company.updated' || e.type === 'settings.updated') return;
  const links = new Set<string>();
  const add = (t: string | undefined, id: string | null | undefined) => {
    if (t && id) links.add(`${t}\u0000${id}`);
  };
  const addDocumentContext = (docId: string) => {
    const r = one<{ job_id: string | null; party_id: string; source_id: string | null }>(db, 'SELECT job_id, party_id, source_id FROM documents WHERE id = ?', docId);
    add('document', docId);
    if (r) {
      add('job', r.job_id);
      add('party', r.party_id);
      add('document', r.source_id);
    }
  };
  const addSubject = (t: string, id: string) => {
    if (t === 'document') addDocumentContext(id);
    else if (t === 'job') {
      add('job', id);
      const r = one<{ party_id: string }>(db, 'SELECT party_id FROM jobs WHERE id = ?', id);
      add('party', r?.party_id);
    } else add(t, id);
  };

  const d = e.data as D;
  if (e.type === 'stock.moved') {
    for (const m of d.moves as StockMove[]) {
      add('item', m.itemId);
      if (m.documentId) addDocumentContext(m.documentId);
      if (m.jobId) addSubject('job', m.jobId);
    }
  } else if (e.type === 'payment.recorded' || e.type === 'payment.voided') {
    const pid = e.type === 'payment.recorded' ? d.payment.id : d.id;
    add('payment', pid);
    const p = one<{ party_id: string }>(db, 'SELECT party_id FROM payments WHERE id = ?', pid);
    add('party', p?.party_id);
    for (const a of all<{ document_id: string }>(db, 'SELECT document_id FROM payment_allocations WHERE payment_id = ?', pid)) {
      addDocumentContext(a.document_id);
    }
  } else if (e.type === 'party.created' || e.type === 'party.updated') {
    add('party', e.subjectId);
    const parent = one<{ parent_id: string | null }>(db, 'SELECT parent_id FROM parties WHERE id = ?', e.subjectId);
    add('party', parent?.parent_id);
  } else {
    addSubject(e.subjectType, e.subjectId);
  }
  for (const k of links) {
    const [t, id] = k.split('\u0000');
    run(db, 'INSERT OR IGNORE INTO event_links (seq, subject_type, subject_id) VALUES (?,?,?)', e.seq, t, id);
  }
}
