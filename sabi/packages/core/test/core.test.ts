import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate, compileFormula, FormulaError, computeTotals, lineAmounts, roundHalfUp, openLines,
  fulfilment, evaluateTransitions, nextAction, autoTransition, postDocument, postPayment, reverse, postRetentionRelease, manualEntry,
  assertBalanced, formatMinor,
} from '../src/index.ts';
import type { DocLine, Document, WorkflowDef, DocTypeDef, PostingAccounts, Payment } from '../src/index.ts';

test('formula: arithmetic, precedence, functions, comparisons', () => {
  assert.equal(evaluate('pieces * length', { pieces: 20, length: 6.5 }), 130);
  assert.equal(evaluate('2 + 3 * 4', {}), 14);
  assert.equal(evaluate('(2 + 3) * 4', {}), 20);
  assert.equal(evaluate('-3 + 5', {}), 2);
  assert.equal(evaluate('ceil(area / 0.76)', { area: 10 }), 14);
  assert.equal(evaluate('round(1.23456, 2)', {}), 1.23);
  assert.equal(evaluate('max_discount_pct > 10', { max_discount_pct: 12 }), 1);
  assert.equal(evaluate('max_discount_pct > 10 && total >= 100', { max_discount_pct: 12, total: 50 }), 0);
  assert.equal(evaluate('a || b', { a: 0, b: 1 }), 1);
  assert.equal(evaluate('missing * 3', {}), 0);
  assert.equal(evaluate('5 / 0', {}), 0);
});

test('formula: rejects code injection and bad syntax', () => {
  assert.throws(() => compileFormula('process.exit()'), FormulaError);
  assert.throws(() => compileFormula('a; b'), FormulaError);
  assert.throws(() => compileFormula('(1 + 2'), FormulaError);
  assert.throws(() => compileFormula('constructor["x"]'), FormulaError);
});

test('money: half-up rounding without float noise', () => {
  assert.equal(roundHalfUp(100.5), 101);
  assert.equal(roundHalfUp(1.005 * 100), 101);
  assert.equal(roundHalfUp(-2.5), -3);
  assert.equal(formatMinor(123456789), '1,234,567.89');
  assert.equal(formatMinor(-5), '−0.05');
});

const rate = (code: string) => (code === 'VAT7' ? 0.07 : 0);
const L = (p: Partial<DocLine>): DocLine => ({
  id: p.id ?? 'l' + Math.random(), description: 'x', qty: 1, uom: 'pc', unitPrice: 0, discountPct: 0,
  taxCode: 'VAT7', ...p,
});

test('totals: exclusive VAT computed on summed base', () => {
  const t = computeTotals(
    [L({ qty: 130, unitPrice: 185_00, itemKind: 'stock' }), L({ qty: 1, unitPrice: 1_000_00, itemKind: 'service', whtCategory: 'service' })],
    'exclusive', '2026-09-29', rate,
  );
  assert.equal(t.net, 24_050_00 + 1_000_00);
  assert.equal(t.tax, roundHalfUp(25_050_00 * 0.07));
  assert.equal(t.total, t.net + t.tax);
  assert.equal(t.netGoods, 24_050_00);
  assert.equal(t.netServices, 1_000_00);
  assert.deepEqual(t.whtBases, [{ category: 'service', base: 1_000_00 }]);
});

test('totals: inclusive VAT extracts tax', () => {
  const t = computeTotals([L({ qty: 1, unitPrice: 107_00 })], 'inclusive', '2026-01-01', rate);
  assert.equal(t.tax, 7_00);
  assert.equal(t.net, 100_00);
  assert.equal(t.total, 107_00);
});

test('totals: discounts and exempt codes', () => {
  const a = lineAmounts({ qty: 3, unitPrice: 333_33, discountPct: 10 });
  assert.equal(a.gross, 999_99);
  assert.equal(a.discount, 100_00);
  const t = computeTotals([L({ qty: 1, unitPrice: 50_00, taxCode: 'EXEMPT', discountPct: 12 })], 'exclusive', '2026-01-01', rate);
  assert.equal(t.tax, 0);
  assert.equal(t.maxDiscountPct, 12);
});

const doc = (p: Partial<Document>): Document => ({
  id: 'd', type: 'order', state: 'draft', phase: 'draft', partyId: 'p', date: '2026-09-29',
  priceMode: 'exclusive', lines: [], fields: {}, createdBy: 'u', createdAt: '', updatedAt: '',
  totals: computeTotals([], 'exclusive', '2026-09-29', rate), ...p,
});

test('conversion: open lines and fulfilment across partial deliveries', () => {
  const so = doc({ lines: [L({ id: 'a', qty: 10 }), L({ id: 'b', qty: 5 })] });
  const d1 = doc({ id: 'd1', type: 'inv', phase: 'issued', lines: [L({ qty: 4, sourceLineId: 'a' })] });
  const dv = doc({ id: 'dv', type: 'inv', phase: 'void', lines: [L({ qty: 10, sourceLineId: 'a' })] });
  const open = openLines(so, [d1, dv], 'inv');
  assert.deepEqual(open.map((l) => [l.sourceLineId, l.qty]), [['a', 6], ['b', 5]]);
  assert.equal(fulfilment(so, [d1, dv], 'inv'), 4 / 15);
});

const wf: WorkflowDef<string> = {
  initial: 'new',
  states: [
    { id: 'new', label: { en: 'New' }, phase: 'open' },
    { id: 'quoted', label: { en: 'Quoted' }, phase: 'open' },
    { id: 'lost', label: { en: 'Lost' }, phase: 'cancelled' },
  ],
  transitions: [
    { id: 'quote', from: ['new'], to: 'quoted', label: { en: 'Quote' }, primary: true, auto: true,
      requires: { fields: ['site'], documents: [{ type: 'quotation', phase: ['issued', 'closed'] }] } },
    { id: 'lose', from: '*', to: 'lost', label: { en: 'Lost' }, requireReason: true },
  ],
};

test('workflow: guards explain what is missing; next action prefers primary', () => {
  const opts = evaluateTransitions(wf, 'new', { fields: {}, documents: [], role: 'sales' });
  const n = nextAction(opts)!;
  assert.equal(n.transition.id, 'quote');
  assert.equal(n.ok, false);
  assert.deepEqual(n.missing.map((m) => m.kind).sort(), ['document', 'field']);
  assert.equal(autoTransition(wf, 'new', { fields: { site: 'x' }, documents: [{ type: 'quotation', phase: 'issued' }], role: null })?.id, 'quote');
});

test('workflow: approval guard with condition, role self-approval and recorded approval', () => {
  const dwf: WorkflowDef<string> = {
    initial: 'draft',
    states: [{ id: 'draft', label: { en: 'Draft' }, phase: 'draft' }, { id: 'sent', label: { en: 'Sent' }, phase: 'issued' }],
    transitions: [{ id: 'send', from: ['draft'], to: 'sent', label: { en: 'Send' },
      requires: { lines: true, approval: { role: 'manager', when: 'max_discount_pct > 10' } } }],
  };
  const base = { fields: {}, lineCount: 1, metrics: { max_discount_pct: 15 } };
  const blocked = evaluateTransitions(dwf, 'draft', { ...base, role: 'sales' })[0];
  assert.deepEqual(blocked.missing, [{ kind: 'approval', role: 'manager', status: 'none' }]);
  assert.equal(evaluateTransitions(dwf, 'draft', { ...base, role: 'manager' })[0].ok, true);
  assert.equal(evaluateTransitions(dwf, 'draft', { ...base, role: 'sales', approvals: { send: 'approved' } })[0].ok, true);
  assert.equal(evaluateTransitions(dwf, 'draft', { ...base, metrics: { max_discount_pct: 5 }, role: 'sales' })[0].ok, true);
});

const acc: PostingAccounts = {
  receivable: '1130', payable: '2120', revenueGoods: '4110', revenueServices: '4120', purchases: '5110',
  outputTax: '2150', inputTax: '1160', whtPrepaid: '1170', whtPayable: '2160', cash: '1110', bank: '1120',
  retentionReceivable: '1150', retentionPayable: '2140',
};

test('accounting: invoice, bill and payment postings balance; reversal mirrors', () => {
  const lines = [L({ qty: 10, unitPrice: 100_00, itemKind: 'stock' }), L({ qty: 1, unitPrice: 500_00, itemKind: 'service' })];
  const inv = doc({ number: 'IV-1', lines, totals: computeTotals(lines, 'exclusive', '2026-09-29', rate) });
  const salesType = { effects: ['receivable'] } as unknown as DocTypeDef;
  const e = postDocument(inv, salesType, acc, 'je1')!;
  assertBalanced(e.lines);
  assert.equal(e.lines.find((l) => l.account === '4120')!.credit, 500_00);
  const r = reverse(e, 'je2', '2026-09-30');
  assert.equal(r.lines[0].credit, e.lines[0].debit);

  const bill = postDocument(inv, { effects: ['payable'] } as unknown as DocTypeDef, acc, 'je3')!;
  assertBalanced(bill.lines);

  const p: Payment = { id: 'p', number: 'RC-1', direction: 'in', partyId: 'c', date: '2026-10-01', method: 'transfer',
    amount: inv.totals.total - 15_00, whtAmount: 15_00, allocations: [{ documentId: 'd1', amount: inv.totals.total }], createdBy: 'u', createdAt: '' };
  const pe = postPayment(p, acc, 'je4');
  assertBalanced(pe.lines);
  assert.equal(pe.lines.find((l) => l.account === '1170')!.debit, 15_00);
  assert.equal(pe.lines.find((l) => l.account === '1130')!.credit, inv.totals.total);
});

test('accounting: retention is held apart, credit notes mirror, refunds and manual entries balance', () => {
  const lines = [L({ qty: 1, unitPrice: 1000_00, itemKind: 'service' })];
  const totals = computeTotals(lines, 'exclusive', '2026-09-29', rate);
  const inv = doc({ number: 'IV-2', lines, totals, retention: 5350 });
  const salesType = { effects: ['receivable'] } as unknown as DocTypeDef;
  const e = postDocument(inv, salesType, acc, 'je1')!;
  assert.equal(e.lines.find((l) => l.account === '1130')!.debit, totals.total - 5350);
  assert.equal(e.lines.find((l) => l.account === '1150')!.debit, 5350);
  const rel = postRetentionRelease(inv, salesType, acc, 'je2', '2026-12-01');
  assert.deepEqual(rel.lines.map((l) => [l.account, l.debit, l.credit]), [['1130', 5350, 0], ['1150', 0, 5350]]);

  const cn = doc({ number: 'CN-1', lines, totals });
  const ce = postDocument(cn, { effects: ['receivable'], adjusts: 'credit' } as unknown as DocTypeDef, acc, 'je3')!;
  assert.equal(ce.lines.find((l) => l.account === '1130')!.credit, totals.total);
  assert.equal(ce.lines.find((l) => l.account === '2150')!.debit, totals.tax);

  // Money out against a receivable document is a refund: Dr receivables / Cr bank.
  const refund: Payment = { id: 'r', number: 'PV-1', direction: 'out', partyId: 'c', date: '2026-10-01', method: 'transfer',
    amount: 100_00, whtAmount: 0, allocations: [{ documentId: 'iv', amount: 100_00, refund: true }], createdBy: 'u', createdAt: '' };
  const re = postPayment(refund, acc, 'je4', ['cash'], () => 'receivable');
  assert.deepEqual(re.lines.map((l) => [l.account, l.debit, l.credit]), [['1130', 100_00, 0], ['1120', 0, 100_00]]);

  const m = manualEntry('je5', '2026-10-31', 'Depreciation', [{ account: '5250', debit: 500_00, credit: 0 }, { account: '1219', debit: 0, credit: 500_00 }]);
  assert.equal(m.source.type, 'manual');
  assert.throws(() => manualEntry('je6', '2026-10-31', 'x', [{ account: '5250', debit: 1, credit: 0 }, { account: '1219', debit: 0, credit: 2 }]));
  assert.throws(() => manualEntry('je7', '2026-10-31', 'x', [{ account: '5250', debit: 1, credit: 0 }]));
});
