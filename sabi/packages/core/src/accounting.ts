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

export function postDocument(
  doc: Document,
  type: DocTypeDef,
  acc: PostingAccounts,
  id: string,
): JournalEntry | null {
  const t = doc.totals;
  let lines: JournalLine[] | null = null;
  if (type.effects.includes('receivable')) {
    lines = nonZero([
      line(acc.receivable, t.total, 0, doc.partyId),
      line(acc.revenueGoods, 0, t.netGoods),
      line(acc.revenueServices, 0, t.netServices),
      line(acc.outputTax, 0, t.tax),
    ]);
  } else if (type.effects.includes('payable')) {
    lines = nonZero([
      line(acc.purchases, t.net, 0),
      line(acc.inputTax, t.tax, 0),
      line(acc.payable, 0, t.total, doc.partyId),
    ]);
  }
  if (!lines || lines.length === 0) return null;
  assertBalanced(lines);
  return {
    id,
    date: doc.date,
    memo: `${doc.number ?? doc.id}`,
    source: { type: 'document', id: doc.id },
    lines,
  };
}

export function postPayment(p: Payment, acc: PostingAccounts, id: string, cashMethods: string[] = ['cash']): JournalEntry {
  const money = cashMethods.includes(p.method) ? acc.cash : acc.bank;
  const settled = p.amount + p.whtAmount;
  const lines =
    p.direction === 'in'
      ? nonZero([
          line(money, p.amount, 0),
          line(acc.whtPrepaid, p.whtAmount, 0),
          line(acc.receivable, 0, settled, p.partyId),
        ])
      : nonZero([
          line(acc.payable, settled, 0, p.partyId),
          line(money, 0, p.amount),
          line(acc.whtPayable, 0, p.whtAmount),
        ]);
  assertBalanced(lines);
  return { id, date: p.date, memo: p.number, source: { type: 'payment', id: p.id }, lines };
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
