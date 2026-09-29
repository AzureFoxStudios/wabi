/**
 * End-to-end: customer → quotation → order → job work → material usage →
 * delivery/tax invoice → payment with withholding tax → job completed, with
 * discussion, tasks, approvals and the journal verified at the end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, seedDemo, setup, DEMO_PASSWORD, type App } from '../src/app.ts';
import { CommandError, type Actor } from '../src/engine.ts';
import { setPassword } from '../src/auth.ts';
import { verify, backup, restoreFromJournal } from '../src/maintenance.ts';
import { createHttpServer } from '../src/http.ts';
import * as Q from '../src/queries.ts';
import { all, one } from '../src/db.ts';
import { thaiTaxId } from '@sabi/pack-sheet-metal';

function fresh(): App {
  const dir = mkdtempSync(join(tmpdir(), 'sabi-'));
  return createApp({ dataDir: dir });
}

function expectError(fn: () => unknown, code: string, status?: number) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof CommandError, `expected CommandError, got ${e}`);
    assert.equal(e.code, code, `${e.code}: ${e.message}`);
    if (status) assert.equal(e.status, status);
    return e;
  }
  assert.fail(`expected error ${code}`);
}

test('complete sales workflow from inquiry to paid, verified journal', () => {
  const app = fresh();
  const ownerRec = setup(app, { company: 'Test Roofing Ltd.', name: 'Owner', username: 'boss', password: 'longpassword' });
  const owner: Actor = { id: ownerRec.id, name: 'Owner', role: 'owner' };
  const x = (actor: Actor, name: string, input: Record<string, unknown>) => app.exec(name, input, actor).result;
  const mk = (username: string, role: string): Actor => {
    const u = x(owner, 'user.create', { username, name: username, role });
    return { id: u.id, name: username, role };
  };
  const sales = mk('sam', 'sales');
  const manager = mk('mia', 'manager');
  const accounts = mk('ann', 'accounts');
  const workshop = mk('wes', 'workshop');
  const installer = mk('ian', 'installer');

  x(owner, 'company.update', {
    taxId: thaiTaxId('010555512345'), address: { line1: '1 Test Rd.', province: 'Bangkok' },
    fields: { branch_code: '00000', vat_registered: true },
  });

  // Invalid tax IDs are rejected at the door.
  expectError(() => x(sales, 'party.create', { kind: 'organization', name: 'Bad', roles: ['customer'], taxId: '1234567890123' }), 'invalid');

  // Customer without tax ID first: the tax invoice must refuse to issue later.
  const cust = x(sales, 'party.create', { kind: 'organization', name: 'Acme Build Co., Ltd.', roles: ['customer'], address: { line1: '9 Site Rd.' }, fields: { branch_code: '00000' } }).id;
  const sheet = x(manager, 'item.create', { sku: 'SHEET', name: 'Sheet 0.4', kind: 'stock', uom: 'm', salePrice: 20000, costPrice: 15000, measureTemplate: 'sheet_length' }).id;
  const labour = x(manager, 'item.create', { sku: 'LAB', name: 'Install', kind: 'service', uom: 'm2', salePrice: 10000, costPrice: 0, whtCategory: 'service' }).id;
  const sealant = x(manager, 'item.create', { sku: 'SEAL', name: 'Sealant', kind: 'stock', uom: 'pc', salePrice: 10000, costPrice: 8000 }).id;
  x(workshop, 'stock.adjust', { itemId: sheet, qty: 100, reason: 'Opening' });
  x(workshop, 'stock.adjust', { itemId: sealant, qty: 10, reason: 'Opening' });

  // Job: inquiry → survey requires the site address.
  const job = x(sales, 'job.create', { type: 'install', title: 'Roof', partyId: cust });
  assert.match(job.number, /^J\d{4}-0001$/);
  const e1 = expectError(() => x(sales, 'job.transition', { id: job.id, transition: 'survey' }), 'blocked', 409);
  assert.deepEqual((e1.details as any).missing, [{ kind: 'field', key: 'site_address' }]);
  x(sales, 'job.update', { id: job.id, fields: { site_address: 'Plot 7' } });
  x(sales, 'job.transition', { id: job.id, transition: 'survey' });
  const surveyTask = one<{ id: string; role: string }>(app.db, "SELECT id, role FROM tasks WHERE subject_id = ?", job.id)!;
  assert.equal(surveyTask.role, 'sales', 'workflow action created a task for sales');

  // Discussion with a mention lands in the workshop's attention.
  x(sales, 'message.post', { subjectType: 'job', subjectId: job.id, body: 'Can we cut 6 m? @wes' });
  const wesUser = { id: workshop.id, name: 'wes', username: 'wes', role: 'workshop', locale: 'th' as const, active: true, createdAt: '' };
  assert.equal(Q.attention(app.ctx, wesUser).mentions.length, 1);

  // Quotation with 15% discount → needs manager approval before sending.
  const qt = x(sales, 'document.create', {
    type: 'quotation', jobId: job.id,
    lines: [{ itemId: sheet, measures: { pieces: 10, length: 6 }, discountPct: 15 }, { itemId: labour, qty: 50 }],
  }).id;
  const qtDoc = Q.documentView(app.ctx, qt, wesUser)!;
  assert.equal(qtDoc.document.lines[0].qty, 60, 'measure template computed the quantity');
  expectError(() => x(sales, 'document.transition', { id: qt, transition: 'send' }), 'blocked', 409);
  const apr = x(sales, 'approval.request', { subjectType: 'document', subjectId: qt, transitionId: 'send' }).id;
  expectError(() => x(workshop, 'approval.decide', { id: apr, decision: 'approved' }), 'forbidden', 403);
  x(manager, 'approval.decide', { id: apr, decision: 'approved' });
  // Editing after approval invalidates it.
  x(sales, 'document.update', { id: qt, lines: [{ itemId: sheet, measures: { pieces: 10, length: 6 }, discountPct: 12 }, { itemId: labour, qty: 50 }] });
  assert.equal(one<{ state: string }>(app.db, 'SELECT state FROM approvals WHERE id = ?', apr)!.state, 'stale');
  expectError(() => x(sales, 'document.transition', { id: qt, transition: 'send' }), 'blocked', 409);
  const apr2 = x(sales, 'approval.request', { subjectType: 'document', subjectId: qt, transitionId: 'send' }).id;
  x(manager, 'approval.decide', { id: apr2, decision: 'approved' });
  x(sales, 'document.transition', { id: qt, transition: 'send' });
  assert.equal(one<{ state: string }>(app.db, 'SELECT state FROM jobs WHERE id = ?', job.id)!.state, 'quoted', 'job auto-moved on issued quotation');
  expectError(() => x(sales, 'document.update', { id: qt, notes: 'x' }), 'immutable', 409);

  // Customer accepts: sales order from the quotation.
  const so = x(sales, 'document.create', { type: 'sales_order', sourceId: qt }).id;
  x(manager, 'document.transition', { id: so, transition: 'confirm' });
  assert.equal(one<{ state: string }>(app.db, 'SELECT state FROM documents WHERE id = ?', qt)!.state, 'accepted', 'quotation auto-accepted');
  assert.equal(one<{ state: string }>(app.db, 'SELECT state FROM jobs WHERE id = ?', job.id)!.state, 'confirmed');
  assert.ok(all(app.db, 'SELECT * FROM messages WHERE subject_id = ? AND meta IS NOT NULL', job.id).length >= 1, 'notifyRole posted a system note');
  const stock1 = Q.stockPosition(app.db, app.ctx.pack).get(sheet);
  assert.equal(stock1.reserved, 60);

  // Work: cutting, material usage, readiness requires tasks done.
  expectError(() => x(installer, 'job.transition', { id: job.id, transition: 'produce' }), 'blocked', 409); // role guard
  x(workshop, 'job.transition', { id: job.id, transition: 'produce' });
  expectError(() => x(workshop, 'job.transition', { id: job.id, transition: 'ready' }), 'blocked', 409);
  for (const t of all<{ id: string }>(app.db, "SELECT id FROM tasks WHERE subject_id = ? AND done_at IS NULL", job.id)) x(workshop, 'task.complete', { id: t.id });
  x(workshop, 'stock.issue', { jobId: job.id, itemId: sealant, qty: 2, note: 'ridge' });
  x(workshop, 'job.transition', { id: job.id, transition: 'ready' });
  x(manager, 'job.update', { id: job.id, fields: { delivery_date: '2026-10-01' } });
  x(manager, 'job.transition', { id: job.id, transition: 'dispatch' });

  // Tax invoice: blocked by the Thai adapter until the customer has a tax ID.
  expectError(() => x(installer, 'document.create', { type: 'tax_invoice', sourceId: so }), 'forbidden', 403);
  const iv = x(accounts, 'document.create', { type: 'tax_invoice', sourceId: so }).id;
  const err = expectError(() => x(accounts, 'document.transition', { id: iv, transition: 'issue' }), 'jurisdiction', 422);
  assert.ok((err.details as any).issues.some((i: any) => i.code === 'buyer_tax_id'));
  x(sales, 'party.update', { id: cust, taxId: thaiTaxId('010555598765') });
  const issued = x(accounts, 'document.transition', { id: iv, transition: 'issue' });
  assert.deepEqual(issued.warnings, []);
  const ivDoc = Q.documentView(app.ctx, iv, wesUser)!;
  assert.match(ivDoc.document.number!, /^IV\d{4}-0001$/);
  assert.equal(ivDoc.document.partySnapshot?.taxId, thaiTaxId('010555598765'), 'buyer snapshot frozen at issue');
  // 60 m × 200 × 0.88 = 10,560 + 50 × 100 = 5,000 → 15,560 + 7% VAT 1,089.20 = 16,649.20
  assert.equal(ivDoc.document.totals.total, 1_664_920);
  const stock2 = Q.stockPosition(app.db, app.ctx.pack).get(sheet);
  assert.equal(stock2.onHand, 40, 'stock left the warehouse with the delivery');
  assert.equal(stock2.reserved, 0);

  // Job completion needs installer task done + issued invoice.
  expectError(() => x(installer, 'job.transition', { id: job.id, transition: 'complete' }), 'blocked', 409);
  for (const t of all<{ id: string }>(app.db, "SELECT id FROM tasks WHERE subject_id = ? AND done_at IS NULL", job.id)) x(installer, 'task.complete', { id: t.id });
  x(installer, 'job.transition', { id: job.id, transition: 'complete' });
  assert.equal(one<{ phase: string }>(app.db, 'SELECT phase FROM jobs WHERE id = ?', job.id)!.phase, 'done');

  // Payment: customer withholds 3% on the service part (5,000 → 150).
  assert.deepEqual(ivDoc.wht.map((w: any) => [w.category, w.amount]), [['service', 15000]]);
  expectError(() => x(accounts, 'payment.record', { direction: 'in', partyId: cust, method: 'transfer', amount: 1_664_920, whtAmount: 15000, allocations: [{ documentId: iv, amount: 1_664_920 }] }), 'unbalanced', 422);
  expectError(() => x(accounts, 'payment.record', { direction: 'in', partyId: cust, method: 'transfer', amount: 2_000_000, allocations: [{ documentId: iv, amount: 2_000_000 }] }), 'overpaid', 422);
  x(accounts, 'payment.record', { direction: 'in', partyId: cust, method: 'transfer', amount: 1_649_920, whtAmount: 15000, whtCategory: 'service', allocations: [{ documentId: iv, amount: 1_664_920 }] });
  const ws = Q.jobWorkspace(app.ctx, job.id, wesUser)!;
  assert.equal(ws.money.outstanding, 0);
  assert.equal(ws.money.paid, 1_664_920);
  assert.ok(ws.materials.some((m: any) => m.to === 'consumed'), 'material usage visible on the job');
  assert.ok(ws.timeline.length > 20, 'timeline aggregates job + document events');
  expectError(() => x(accounts, 'document.transition', { id: iv, transition: 'void', reason: 'x' }), 'has_payments', 409);

  // Books balance; AR is cleared; WHT prepaid recorded.
  const tb = Q.trialBalance(app.ctx);
  assert.equal(tb.reduce((a, r) => a + r.balance, 0), 0);
  assert.equal(tb.find((r) => r.account === '1130')!.balance, 0);
  assert.equal(tb.find((r) => r.account === '1170')!.balance, 15000);
  assert.equal(tb.find((r) => r.account === '2150')!.balance, -108920);

  // Journal: append-only and fully reproducible.
  assert.throws(() => app.db.exec("UPDATE events SET data = '{}' WHERE seq = 1"), /append-only/);
  const r = verify(app.db);
  assert.ok(r.ok, JSON.stringify(r, null, 1));
});

test('demo seed builds a consistent workspace; every screen query runs', () => {
  const app = fresh();
  seedDemo(app);
  const r = verify(app.db);
  assert.ok(r.ok, JSON.stringify(r.projections.filter((p) => !p.ok)));
  const users = all<any>(app.db, 'SELECT * FROM users');
  for (const u of users) {
    const viewer = { ...u, active: true, createdAt: u.created_at };
    const a = Q.attention(app.ctx, viewer);
    assert.ok(a);
    if (u.username === 'arun') {
      assert.equal(a.approvals.length, 1, 'manager sees the discount approval');
      assert.ok(a.mentions.length >= 1, 'manager was mentioned');
      assert.ok(a.stock.some((s: any) => s.sku === 'ZL-047' && s.short), 'zincalume shortage flagged');
    }
    if (u.username === 'pim') {
      assert.ok(a.money!.overdue.length >= 1, 'accounts sees the overdue invoice');
      assert.ok(a.money!.payableSoon.length >= 1, 'accounts sees the supplier bill due');
    }
  }
  const viewer = { ...users[0], active: true, createdAt: users[0].created_at };
  for (const j of all<{ id: string }>(app.db, 'SELECT id FROM jobs')) assert.ok(Q.jobWorkspace(app.ctx, j.id, viewer));
  for (const d of all<{ id: string }>(app.db, 'SELECT id FROM documents')) assert.ok(Q.documentView(app.ctx, d.id, viewer));
  for (const p of all<{ id: string }>(app.db, 'SELECT id FROM parties')) assert.ok(Q.partyView(app.ctx, p.id));
  for (const i of all<{ id: string }>(app.db, 'SELECT id FROM items')) assert.ok(Q.itemView(app.ctx, i.id));
  assert.ok(Q.moneyOverview(app.ctx).receivables.length >= 1);
  assert.ok(Q.jobList(app.ctx, {}, viewer).length >= 5);
  assert.ok(Q.search(app.ctx, 'Baan').length >= 1);
  const month = new Date().toISOString().slice(0, 7);
  Q.vatReport(app.ctx, 'sales', month);
  Q.whtReport(app.ctx, month);
  assert.ok(Q.activity(app.ctx, {}).length > 10);

  // Backup → restore reproduces identical projections.
  const out = backup(app.db, app.ctx.dataDir, mkdtempSync(join(tmpdir(), 'sabi-bk-')));
  const target = join(mkdtempSync(join(tmpdir(), 'sabi-rs-')), 'sabi.db');
  assert.equal(restoreFromJournal(join(out.dir, 'journal.jsonl'), target), out.events);
  const restored = createApp({ dataDir: '/nonexistent', dbPath: target });
  assert.equal(one<{ n: number }>(restored.db, 'SELECT COUNT(*) AS n FROM documents')!.n, one<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM documents')!.n);
  assert.ok(verify(restored.db).ok);
});

test('HTTP: auth, CSRF guard, commands, reads', async () => {
  const app = fresh();
  seedDemo(app);
  const server = createHttpServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const s0 = await (await fetch(`${base}/api/session`)).json();
    assert.equal(s0.user, null);
    assert.equal(s0.demo, true);
    assert.equal((await fetch(`${base}/api/bootstrap`)).status, 401);
    const bad = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'nok', password: 'nope' }) });
    assert.equal(bad.status, 401);
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'nok', password: DEMO_PASSWORD }) });
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    assert.match(res.headers.get('set-cookie')!, /HttpOnly; SameSite=Lax/);
    const h = { cookie, 'content-type': 'application/json' };
    const boot = await (await fetch(`${base}/api/bootstrap`, { headers: h })).json();
    assert.equal(boot.user.username, 'nok');
    assert.equal(boot.pack.id, 'sheet-metal');
    // Form posts (text/plain) are refused.
    const csrf = await fetch(`${base}/api/commands/party.create`, { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(csrf.status, 415);
    const created = await fetch(`${base}/api/commands/party.create`, { method: 'POST', headers: h, body: JSON.stringify({ kind: 'person', name: 'Walk-in', roles: ['customer'] }) });
    assert.equal(created.status, 200);
    const denied = await fetch(`${base}/api/commands/stock.adjust`, { method: 'POST', headers: h, body: JSON.stringify({ itemId: 'x', qty: 1, reason: 'x' }) });
    assert.equal(denied.status, 403);
    const att = await (await fetch(`${base}/api/attention`, { headers: h })).json();
    assert.ok(Array.isArray(att.nextSteps));
    const jobs = await (await fetch(`${base}/api/jobs`, { headers: h })).json();
    const ws = await (await fetch(`${base}/api/jobs/${jobs[0].id}`, { headers: h })).json();
    assert.ok(ws.job.number);
    const up = await fetch(`${base}/api/files?subjectType=job&subjectId=${jobs[0].id}&name=${encodeURIComponent('รูปหน้างาน.jpg')}`, { method: 'POST', headers: { cookie, 'content-type': 'image/jpeg' }, body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    assert.equal(up.status, 200);
    const fileId = (await up.json()).result.id;
    const f = await fetch(`${base}/api/files/${fileId}`, { headers: { cookie } });
    assert.equal(f.status, 200);
    assert.equal((await f.arrayBuffer()).byteLength, 4);
    assert.equal((await fetch(`${base}/api/export`, { headers: h })).status, 403, 'only owner exports');
  } finally {
    server.close();
  }
});

test('setup refuses a second owner; passwords are not in the journal', () => {
  const app = fresh();
  const u = setup(app, { company: 'A', name: 'A', username: 'alpha', password: 'longpassword' });
  assert.throws(() => setup(app, { company: 'B', name: 'B', username: 'bravo', password: 'longpassword' }), /already set up/);
  setPassword(app.db, u.id, 'another-password');
  const journal = all<{ data: string }>(app.db, 'SELECT data FROM events').map((r) => r.data).join('\n');
  assert.ok(!journal.includes('scrypt') && !journal.includes('longpassword'));
});
