/**
 * Corrections and books: retention, credit/debit notes with stock returns,
 * refunds, supplier credits, manual/reversing journal entries, the corrections
 * password, the adjustment report, imports and settings — verified journal at the end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, setup, type App } from '../src/app.ts';
import { CommandError, type Actor } from '../src/engine.ts';
import { hashPassword } from '../src/auth.ts';
import { verify } from '../src/maintenance.ts';
import * as Q from '../src/queries.ts';
import * as B from '../src/reports.ts';
import { one, run } from '../src/db.ts';
import { CORRECTIONS_KEY } from '../src/commands/books.ts';
import { webhookListener } from '../src/webhook.ts';
import { thaiTaxId } from '@sabi/pack-sheet-metal';

const dirs: string[] = [];
process.on('exit', () => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function fresh(): App {
  const d = mkdtempSync(join(tmpdir(), 'sabi-books-'));
  dirs.push(d);
  return createApp({ dataDir: d });
}
function expectError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof CommandError, String(e));
    assert.equal(e.code, code, `${e.code}: ${e.message}`);
    return e;
  }
  assert.fail(`expected ${code}`);
}

function world() {
  const app = fresh();
  const o = setup(app, { company: 'Books Test Ltd.', name: 'Owner', username: 'boss', password: 'longpassword' });
  const owner: Actor = { id: o.id, name: 'Owner', role: 'owner' };
  const x = (a: Actor, name: string, input: Record<string, unknown>) => app.exec(name, input, a).result;
  const u = x(owner, 'user.create', { username: 'ann', name: 'Ann', role: 'accounts' });
  const accounts: Actor = { id: u.id, name: 'Ann', role: 'accounts' };
  const w = x(owner, 'user.create', { username: 'wes', name: 'Wes', role: 'workshop' });
  const workshop: Actor = { id: w.id, name: 'Wes', role: 'workshop' };
  x(owner, 'company.update', { taxId: thaiTaxId('010555512345'), address: { line1: '1 Test Rd.' }, fields: { branch_code: '00000', vat_registered: true } });
  const cust = x(owner, 'party.create', { kind: 'organization', name: 'Acme Co., Ltd.', roles: ['customer'], taxId: thaiTaxId('010555598765'), address: { line1: '9 Site Rd.' }, fields: { branch_code: '00000' } }).id;
  const supp = x(owner, 'party.create', { kind: 'organization', name: 'Steel Supply', roles: ['supplier'], taxId: thaiTaxId('010555511111'), address: { line1: '5 Mill Rd.' }, fields: { branch_code: '00000' } }).id;
  const sheet = x(owner, 'item.create', { sku: 'SHEET', name: 'Sheet', kind: 'stock', uom: 'm', salePrice: 20000, costPrice: 15000, reorderPoint: 20 }).id;
  const svc = x(owner, 'item.create', { sku: 'SVC', name: 'Extra work', kind: 'service', uom: 'job', salePrice: 10000, costPrice: 0 }).id;
  x(owner, 'stock.adjust', { itemId: sheet, qty: 100, reason: 'Opening' });
  return { app, owner, accounts, workshop, x, cust, supp, sheet, svc };
}

const onHand = (app: App, item: string) => Q.stockPosition(app.db, app.ctx.pack).get(item)!.onHand;
const view = (app: App, id: string) => Q.documentView(app.ctx, id, { id: 'v', name: 'v', username: 'v', role: 'owner', locale: 'en', active: true, createdAt: '' } as never)!;
const state = (app: App, id: string) => one<{ state: string }>(app.db, 'SELECT state FROM documents WHERE id = ?', id)!.state;

test('retention, credit/debit notes, refunds and supplier credits keep balances, stock and books right', () => {
  const { app, accounts, x, cust, supp, sheet, svc } = world();

  // Invoice 10 m × 200 = 2,000 + VAT 140 = 2,140; customer holds 5% retention (107).
  const iv = x(accounts, 'document.create', { type: 'tax_invoice', partyId: cust, lines: [{ itemId: sheet, qty: 10 }], fields: { retention_pct: 5 } }).id;
  x(accounts, 'document.transition', { id: iv, transition: 'issue' });
  assert.equal(view(app, iv).balance, 214000 - 10700, 'retention is not due yet');
  assert.equal(view(app, iv).retention!.amount, 10700);
  assert.equal(onHand(app, sheet), 90);
  x(accounts, 'payment.record', { direction: 'in', partyId: cust, method: 'transfer', amount: 203300, allocations: [{ documentId: iv, amount: 203300 }] });
  assert.equal(state(app, iv), 'paid');
  // Releasing retention makes it due again and reopens the invoice.
  x(accounts, 'document.releaseRetention', { id: iv });
  assert.equal(state(app, iv), 'issued');
  assert.equal(view(app, iv).balance, 10700);
  expectError(() => x(accounts, 'document.releaseRetention', { id: iv }), 'invalid_state');
  x(accounts, 'payment.record', { direction: 'in', partyId: cust, method: 'transfer', amount: 10700, allocations: [{ documentId: iv, amount: 10700 }] });
  assert.equal(state(app, iv), 'paid');
  let tb = Q.trialBalance(app.ctx);
  assert.equal(tb.find((r) => r.account === '1150')?.balance ?? 0, 0, 'retention receivable cleared');

  // Notes can only be made from the document they correct.
  expectError(() => x(accounts, 'document.create', { type: 'credit_note', partyId: cust, lines: [{ itemId: sheet, qty: 1 }] }), 'invalid');
  // Credit note: 2 m came back. Lines start as a copy of the invoice and are edited down to the difference.
  const cn = x(accounts, 'document.create', { type: 'credit_note', sourceId: iv }).id;
  assert.equal(view(app, cn).document.lines[0].qty, 10);
  x(accounts, 'document.update', { id: cn, lines: [{ itemId: sheet, qty: 2 }], fields: { goods_returned: true } });
  expectError(() => x(accounts, 'document.transition', { id: cn, transition: 'issue' }), 'blocked'); // reason required
  x(accounts, 'document.update', { id: cn, fields: { reason: 'Two sheets damaged in transport' } });
  x(accounts, 'document.transition', { id: cn, transition: 'issue' });
  assert.equal(onHand(app, sheet), 92, 'returned goods are back in stock');
  assert.equal(view(app, iv).balance, -42800, 'the customer is now owed 428');
  assert.equal(view(app, cn).balance, null, 'a note carries no balance of its own');
  const basis = view(app, cn).noteBasis!;
  assert.deepEqual([basis.original, basis.corrected, basis.difference], [200000, 160000, 40000]);
  assert.throws(() => x(accounts, 'document.transition', { id: iv, transition: 'void', reason: 'x' }));

  // Refund: money out against the invoice, never more than is owed back, never with WHT.
  expectError(() => x(accounts, 'payment.record', { direction: 'out', partyId: cust, method: 'transfer', amount: 50000, allocations: [{ documentId: iv, amount: 50000 }] }), 'overpaid');
  expectError(() => x(accounts, 'payment.record', { direction: 'out', partyId: cust, method: 'transfer', amount: 40000, whtAmount: 2800, allocations: [{ documentId: iv, amount: 42800 }] }), 'invalid');
  const refund = x(accounts, 'payment.record', { direction: 'out', partyId: cust, method: 'transfer', amount: 42800, allocations: [{ documentId: iv, amount: 42800 }] });
  assert.equal(view(app, iv).balance, 0);
  assert.equal(B.paymentView(app.ctx, refund.id)!.refund, true);
  tb = Q.trialBalance(app.ctx);
  assert.equal(tb.find((r) => r.account === '1130')!.balance, 0, 'receivables cleared after refund');
  assert.equal(tb.find((r) => r.account === '2150')!.balance, -(14000 - 2800), 'output VAT reduced by the credit note');

  // Corrections password: once set, voids need it.
  run(app.db, 'INSERT INTO local_state (key, value) VALUES (?, ?)', CORRECTIONS_KEY, hashPassword('fix-it-now'));
  expectError(() => x(accounts, 'document.transition', { id: cn, transition: 'void', reason: 'wrong' }), 'corrections_password');
  expectError(() => x(accounts, 'document.transition', { id: cn, transition: 'void', reason: 'wrong', correctionsPassword: 'fix-it-now' }), 'has_payments'); // refund first
  expectError(() => x(accounts, 'payment.void', { id: refund.id, reason: 'mistake', correctionsPassword: 'nope' }), 'corrections_password');
  x(accounts, 'payment.void', { id: refund.id, reason: 'mistake', correctionsPassword: 'fix-it-now' });
  x(accounts, 'document.transition', { id: cn, transition: 'void', reason: 'wrong', correctionsPassword: 'fix-it-now' });
  assert.equal(view(app, iv).balance, 0);
  assert.equal(onHand(app, sheet), 90, 'voiding the note takes the returned goods out again');
  assert.equal(one<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM auth_log WHERE kind = 'correction'")!.n, 2);
  run(app.db, 'DELETE FROM local_state WHERE key = ?', CORRECTIONS_KEY);

  // Debit note: extra work billed on top → the invoice is due again.
  const dn = x(accounts, 'document.create', { type: 'debit_note', sourceId: iv }).id;
  x(accounts, 'document.update', { id: dn, lines: [{ itemId: svc, qty: 1 }], fields: { reason: 'Extra flashing requested on site' } });
  x(accounts, 'document.transition', { id: dn, transition: 'issue' });
  assert.equal(state(app, iv), 'issued');
  assert.equal(view(app, iv).balance, 10700);
  expectError(() => x(accounts, 'document.transition', { id: iv, transition: 'void', reason: 'x' }), 'has_children');

  // A negative invoice is refused: that is what credit notes are for.
  const neg = x(accounts, 'document.create', { type: 'tax_invoice', partyId: cust, lines: [{ description: 'Deposit returned', qty: 1, unitPrice: -50000 }] }).id;
  expectError(() => x(accounts, 'document.transition', { id: neg, transition: 'issue' }), 'invalid');

  // Supplier bill, then a supplier credit with goods sent back.
  const bl = x(accounts, 'document.create', { type: 'supplier_bill', partyId: supp, lines: [{ itemId: sheet, qty: 10, unitPrice: 15000 }], fields: { supplier_ref: 'INV-778' } }).id;
  x(accounts, 'document.transition', { id: bl, transition: 'record' });
  const sc = x(accounts, 'document.create', { type: 'supplier_credit', sourceId: bl }).id;
  x(accounts, 'document.update', { id: sc, lines: [{ itemId: sheet, qty: 1, unitPrice: 15000 }], fields: { supplier_ref: 'CN-12', reason: 'Bent sheet', goods_returned: true } });
  x(accounts, 'document.transition', { id: sc, transition: 'record' });
  assert.equal(onHand(app, sheet), 89);
  assert.equal(view(app, bl).balance, 160500 - 16050);

  // VAT reports: notes negative, pointing at the corrected document, with tax ID and branch.
  const month = view(app, iv).document.date.slice(0, 7);
  const sales = Q.vatReport(app.ctx, 'sales', month);
  const cnRow = sales.rows.find((r) => r.id === cn)!;
  assert.equal(cnRow.voided, true);
  const dnRow = sales.rows.find((r) => r.id === dn)!;
  assert.equal(dnRow.kind, 'debit');
  assert.equal(dnRow.corrects!.id, iv);
  assert.equal(dnRow.branch, '00000');
  const purchases = Q.vatReport(app.ctx, 'purchase', month);
  const scRow = purchases.rows.find((r) => r.id === sc)!;
  assert.equal(scRow.vat, -1050);
  assert.equal(scRow.number, 'CN-12');
  assert.equal(scRow.corrects!.number, 'INV-778');

  // Stock card tells the whole story of the item.
  const card = B.stockCard(app.ctx, sheet)!;
  assert.equal(card.closing, 89);
  assert.deepEqual(card.lines.map((l) => l.in - l.out), [100, -10, 2, -2, -1]);

  tb = Q.trialBalance(app.ctx);
  assert.equal(tb.reduce((a, r) => a + r.balance, 0), 0);
  const gl = B.ledgerDetail(app.ctx, '1130')!;
  assert.equal(gl.closing, tb.find((r) => r.account === '1130')!.balance);
  assert.equal(gl.closing, 10700);
  assert.ok(verify(app.db).ok);
});

test('manual journal entries, custom accounts, adjustment report, imports, settings and webhook', async () => {
  const { app, owner, accounts, workshop, x, cust } = world();

  // Custom account on top of the jurisdiction's chart.
  expectError(() => x(workshop, 'account.create', { code: '5990', name: 'Tools', type: 'expense' }), 'forbidden');
  expectError(() => x(accounts, 'account.create', { code: '5110', name: 'Dup', type: 'expense' }), 'conflict');
  x(accounts, 'account.create', { code: '5990', nameEn: 'Small tools', nameTh: 'เครื่องมือเล็ก', type: 'expense' });
  assert.ok(Q.bootstrap(app.ctx, { id: owner.id, role: 'owner' } as never, false).jurisdiction.chartOfAccounts.some((a) => a.code === '5990'));

  expectError(() => x(accounts, 'journal.post', { memo: 'x', lines: [{ account: '5990', debit: 100 }, { account: '1110', credit: 90 }] }), 'unbalanced');
  expectError(() => x(accounts, 'journal.post', { memo: 'x', lines: [{ account: '9999', debit: 100 }, { account: '1110', credit: 100 }] }), 'invalid');
  const je = x(accounts, 'journal.post', { date: '2026-09-30', memo: 'Bought drill for cash', lines: [{ account: '5990', debit: 250000 }, { account: '1110', credit: 250000 }] }).id;
  let tb = Q.trialBalance(app.ctx);
  assert.equal(tb.find((r) => r.account === '5990')!.balance, 250000);
  assert.equal(tb.find((r) => r.account === '5990')!.name.th, 'เครื่องมือเล็ก');
  expectError(() => x(accounts, 'journal.reverse', { id: je }), 'invalid'); // reason required
  const rev = x(accounts, 'journal.reverse', { id: je, reason: 'Drill was returned' }).id;
  expectError(() => x(accounts, 'journal.reverse', { id: je, reason: 'again' }), 'invalid_state');
  expectError(() => x(accounts, 'journal.reverse', { id: rev, reason: 'undo' }), 'invalid_state');
  tb = Q.trialBalance(app.ctx);
  assert.equal(tb.find((r) => r.account === '5990')!.balance, 0);
  const docEntry = one<{ id: string }>(app.db, "SELECT id FROM journal_entries WHERE source_type != 'manual' LIMIT 1");
  if (docEntry) expectError(() => x(accounts, 'journal.reverse', { id: docEntry.id, reason: 'x' }), 'invalid');
  assert.equal(B.manualEntries(app.ctx).length, 2);

  // A voided invoice and the journal entries appear in the corrections report.
  const iv = x(accounts, 'document.create', { type: 'tax_invoice', partyId: cust, lines: [{ description: 'Consulting', qty: 1, unitPrice: 100000 }] }).id;
  x(accounts, 'document.transition', { id: iv, transition: 'issue' });
  x(accounts, 'document.transition', { id: iv, transition: 'void', reason: 'Wrong customer' });
  const adj = B.adjustmentsReport(app.ctx);
  assert.deepEqual(adj.rows.map((r) => r.kind).sort(), ['manual_entry', 'reverse_entry', 'void_document']);
  assert.equal(adj.counts.void_document.amount, 107000);
  assert.equal(adj.rows.find((r) => r.kind === 'void_document')!.reason, 'Wrong customer');
  assert.equal(adj.rows[0].username, 'ann');

  // Import is all-or-nothing, validated like hand entry.
  const bad = expectError(() => x(accounts, 'import.parties', { rows: [{ kind: 'organization', name: 'Good Co', roles: ['customer'] }, { kind: 'organization', name: 'Bad', taxId: '1234567890123', roles: ['customer'] }] }), 'import_failed');
  assert.equal((bad.details as any).errors[0].row, 2);
  assert.equal(one<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM parties WHERE name = 'Good Co'")!.n, 0);
  assert.equal(x(accounts, 'import.parties', { rows: [{ kind: 'organization', name: 'Good Co', roles: ['customer'] }, { kind: 'person', name: 'Somsak', roles: ['customer'] }] }).created, 2);
  expectError(() => x(accounts, 'import.items', { rows: [{ sku: 'A', name: 'A' }] }), 'forbidden');
  assert.equal(x(owner, 'import.items', { rows: [{ sku: 'A1', name: 'Bolt', uom: 'pc', salePrice: 500, reorderPoint: 100 }, { sku: 'A2', name: 'Nut', uom: 'pc' }] }).created, 2);
  assert.equal(one<{ r: number }>(app.db, "SELECT reorder_point AS r FROM items WHERE sku = 'A1'")!.r, 100);
  expectError(() => x(owner, 'import.items', { rows: [{ sku: 'A3', name: 'x' }, { sku: 'A3', name: 'dup' }] }), 'import_failed');

  // Settings in the journal; webhook secret hidden from non-owners.
  expectError(() => x(owner, 'settings.update', { key: 'webhook', value: { url: 'ftp://x' } }), 'invalid');
  x(owner, 'settings.update', { key: 'webhook', value: { url: 'https://hooks.example/sabi', secret: 's3cret' } });
  x(owner, 'settings.update', { key: 'signInNotice', value: 'Software written by Books Test Ltd.' });
  assert.equal(Q.settingsFor(app.db, false).webhook.url, '(set)');
  assert.equal(Q.settingsFor(app.db, true).webhook.secret, 's3cret');

  const calls: { url: string; init: any }[] = [];
  const listener = webhookListener(app.db, (async (url: string, init: any) => {
    calls.push({ url, init });
    return new Response('ok');
  }) as never);
  const r = app.exec('task.create', { subjectType: 'party', subjectId: cust, title: 'Call back' }, owner);
  listener(r.events.map((e) => ({ ...e, at: '', actorId: owner.id, data: {}, hash: '', prevHash: '', id: '' })) as never);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hooks.example/sabi');
  assert.match(calls[0].init.headers['x-sabi-signature'], /^sha256=[0-9a-f]{64}$/);
  assert.equal(JSON.parse(calls[0].init.body).events[0].type, 'task.created');

  const sys = B.systemInfo(app.ctx);
  assert.ok(sys.roles.find((ro) => ro.id === 'accounts')!.users.some((u) => u.username === 'ann'));
  assert.ok(sys.events.some((e) => e.type === 'ledger.posted'));
  assert.ok(verify(app.db).ok);
});

test('progress billing: partial invoices against one order; a deposit cannot be a negative invoice', () => {
  const { app, owner, x, cust, svc } = world();
  // A lump-sum job: one line, qty 1, 100,000.00.
  const so = x(owner, 'document.create', { type: 'sales_order', partyId: cust, lines: [{ itemId: svc, qty: 1, unitPrice: 10_000_000 }] }).id;
  x(owner, 'document.transition', { id: so, transition: 'confirm' });
  // Stage 1: bill 30 % of the line.
  const iv1 = x(owner, 'document.create', { type: 'tax_invoice', sourceId: so }).id;
  const l1 = view(app, iv1).document.lines[0];
  x(owner, 'document.update', { id: iv1, lines: [{ ...l1, qty: 0.3 }] });
  x(owner, 'document.transition', { id: iv1, transition: 'issue' });
  assert.equal(view(app, iv1).document.totals.net, 3_000_000);
  // Stage 2 starts from what is still open on the order.
  const iv2 = x(owner, 'document.create', { type: 'tax_invoice', sourceId: so }).id;
  assert.equal(view(app, iv2).document.lines[0].qty, 0.7, 'the next invoice opens with the remaining 70 %');
  x(owner, 'document.transition', { id: iv2, transition: 'issue' });
  // Fully billed: nothing open any more.
  expectError(() => x(owner, 'document.create', { type: 'tax_invoice', sourceId: so }), 'nothing_open');

  // "Less deposit" as a negative invoice is refused at issue; deposits are corrected with a credit note instead.
  const neg = x(owner, 'document.create', { type: 'tax_invoice', partyId: cust, lines: [{ itemId: svc, qty: -1, unitPrice: 500_000 }] }).id;
  expectError(() => x(owner, 'document.transition', { id: neg, transition: 'issue' }), 'invalid');
  assert.ok(verify(app.db).ok);
});

test('item lines keep the item tax code when the pack says so (RD standard cl. 13(ข))', () => {
  const { app, owner, x, cust, sheet } = world();
  assert.equal(app.ctx.pack.taxCodeFromItem, true);
  const other = app.ctx.jur.taxCodes.find((t) => t.code !== app.ctx.jur.defaultTaxCode)!.code;
  const d = x(owner, 'document.create', { type: 'quotation', partyId: cust, lines: [{ itemId: sheet, qty: 1, taxCode: other }, { description: 'Free text', qty: 1, unitPrice: 100, taxCode: other }] }).id;
  const lines = view(app, d).document.lines;
  assert.equal(lines[0].taxCode, app.ctx.jur.defaultTaxCode, 'catalogue item line uses the item tax code');
  assert.equal(lines[1].taxCode, other, 'a free-text line keeps the chosen code');
});
