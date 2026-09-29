import type { PostingAccounts } from './jurisdiction.ts';
import type { DocTypeDef, Document, JournalEntry, JournalLine, Payment } from './types.ts';

/**
 * Posting policy: operational events → double-entry journal lines.
 *
 * Inventory is treated periodically (purchases expensed to a purchases
 * account; stock valuation is reported from quantities × cost), which is the
 * common Thai SME practice and avoids GRNI accounts. Entries are stored as
 * events by the caller, so changing this policy never rewrites history.
 */

function line(account: string, debit: number, credit: number, partyId?: string): JournalLine {
  return { account, debit, credit, ...(partyId ? { partyId } : {}) };
}

function nonZero(lines: JournalLine[]): JournalLine[] {
  return lines.filter((l) => l.debit !== 0 || l.credit !== 0);
}

export function assertBalanced(lines: JournalLine[]): void {
  const d = lines.reduce((s, l) => s + l.debit, 0);
  const c = lines.reduce((s, l) => s + l.credit, 0);
  if (d !== c) throw new Error(`Unbalanced journal entry: debit ${d} ≠ credit ${c}`);
}

/** Swap debit and credit on every line. */
function flip(lines: JournalLine[]): JournalLine[] {
  return lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
}

export function postDocument(
  doc: Document,
  type: DocTypeDef,
  acc: PostingAccounts,
  id: string,
): JournalEntry | null {
  const t = doc.totals;
  const held = doc.retention ?? 0;
  let lines: JournalLine[] | null = null;
  if (type.effects.includes('receivable')) {
    lines = nonZero([
      line(acc.receivable, t.total - held, 0, doc.partyId),
      line(acc.retentionReceivable, held, 0, doc.partyId),
      line(acc.revenueGoods, 0, t.netGoods),
      line(acc.revenueServices, 0, t.netServices),
      line(acc.outputTax, 0, t.tax),
    ]);
  } else if (type.effects.includes('payable')) {
    lines = nonZero([
      line(acc.purchases, t.net, 0),
      line(acc.inputTax, t.tax, 0),
      line(acc.payable, 0, t.total - held, doc.partyId),
      line(acc.retentionPayable, 0, held, doc.partyId),
    ]);
  }
  if (!lines || lines.length === 0) return null;
  // A credit note is the mirror image of the invoice it corrects.
  if (type.adjusts === 'credit') lines = flip(lines);
  assertBalanced(lines);
  return {
    id,
    date: doc.date,
    memo: `${doc.number ?? doc.id}`,
    source: { type: 'document', id: doc.id },
    lines,
  };
}

/**
 * Money in: Dr cash/bank (+ WHT prepaid) / Cr the account of each settled document.
 * Money out: Dr the account of each settled document / Cr cash/bank (+ WHT payable).
 * `kindOf` says whether an allocated document is a receivable or a payable, so a refund
 * (money out against a customer's credit, money in from a supplier's credit) lands on the right account.
 */
export function postPayment(
  p: Payment,
  acc: PostingAccounts,
  id: string,
  cashMethods: string[] = ['cash'],
  kindOf: (documentId: string) => 'receivable' | 'payable' = () => (p.direction === 'in' ? 'receivable' : 'payable'),
): JournalEntry {
  const money = cashMethods.includes(p.method) ? acc.cash : acc.bank;
  const counter = new Map<string, number>();
  for (const a of p.allocations) {
    const account = kindOf(a.documentId) === 'receivable' ? acc.receivable : acc.payable;
    counter.set(account, (counter.get(account) ?? 0) + a.amount);
  }
  const counterLines = [...counter].map(([account, amt]) => (p.direction === 'in' ? line(account, 0, amt, p.partyId) : line(account, amt, 0, p.partyId)));
  const lines =
    p.direction === 'in'
      ? nonZero([line(money, p.amount, 0), line(acc.whtPrepaid, p.whtAmount, 0), ...counterLines])
      : nonZero([...counterLines, line(money, 0, p.amount), line(acc.whtPayable, 0, p.whtAmount)]);
  assertBalanced(lines);
  return { id, date: p.date, memo: p.number, source: { type: 'payment', id: p.id }, lines };
}

/** Released retention becomes an ordinary receivable/payable again. */
export function postRetentionRelease(doc: Document, type: DocTypeDef, acc: PostingAccounts, id: string, date: string): JournalEntry {
  const amt = doc.retention ?? 0;
  const lines = type.effects.includes('receivable')
    ? [line(acc.receivable, amt, 0, doc.partyId), line(acc.retentionReceivable, 0, amt, doc.partyId)]
    : [line(acc.retentionPayable, amt, 0, doc.partyId), line(acc.payable, 0, amt, doc.partyId)];
  assertBalanced(lines);
  return { id, date, memo: `Retention released ${doc.number ?? doc.id}`, source: { type: 'document', id: doc.id }, lines };
}

/** Validate a hand-written (adjusting) entry: at least two lines, each one-sided, positive, balanced. */
export function manualEntry(id: string, date: string, memo: string, raw: JournalLine[]): JournalEntry {
  const lines = nonZero(raw.map((l) => line(l.account, Math.round(l.debit || 0), Math.round(l.credit || 0), l.partyId)));
  if (lines.length < 2) throw new Error('A journal entry needs at least two lines');
  for (const l of lines) {
    if (l.debit < 0 || l.credit < 0) throw new Error('Amounts must be positive');
    if (l.debit && l.credit) throw new Error('A line is either a debit or a credit');
  }
  assertBalanced(lines);
  return { id, date, memo, source: { type: 'manual', id }, lines };
}

export function reverse(entry: JournalEntry, id: string, date: string): JournalEntry {
  return {
    id,
    date,
    memo: `Reversal of ${entry.memo}`,
    source: entry.source,
    reversalOf: entry.id,
    lines: entry.lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
  };
}
