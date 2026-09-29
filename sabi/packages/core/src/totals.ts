import { evaluate } from './formula.ts';
import { roundHalfUp, roundQty } from './money.ts';
import type { DocLine, IsoDate, MeasureTemplate, Minor, TaxLine, Totals } from './types.ts';

export interface LineAmounts {
  gross: Minor;
  discount: Minor;
  amount: Minor;
}

/** Amount of one line in the document's price mode (no tax applied). */
export function lineAmounts(line: Pick<DocLine, 'qty' | 'unitPrice' | 'discountPct'>): LineAmounts {
  const gross = roundHalfUp(roundQty(line.qty) * line.unitPrice);
  const pct = Math.min(100, Math.max(0, line.discountPct || 0));
  const discount = roundHalfUp((gross * pct) / 100);
  return { gross, discount, amount: gross - discount };
}

/** Billable quantity from a measure template's inputs. */
export function measuredQty(template: MeasureTemplate, measures: Record<string, number>): number {
  return roundQty(evaluate(template.qty, measures));
}

export function describeMeasures(template: MeasureTemplate, measures: Record<string, number>): string {
  if (!template.describe) return '';
  return template.describe.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = measures[k];
    return v === undefined ? '?' : String(roundQty(v));
  });
}

export type RateOf = (code: string, date: IsoDate) => number;

/**
 * Document totals. Tax is computed once per tax code on the summed base
 * (Thai invoice convention), not per line.
 */
export function computeTotals(
  lines: DocLine[],
  priceMode: 'exclusive' | 'inclusive',
  date: IsoDate,
  rateOf: RateOf,
): Totals {
  let gross = 0;
  let discount = 0;
  let maxDiscountPct = 0;
  const byCode = new Map<string, Minor>();
  const byWht = new Map<string, Minor>();
  const goodsByCode = new Map<string, Minor>();

  for (const line of lines) {
    const a = lineAmounts(line);
    gross += a.gross;
    discount += a.discount;
    maxDiscountPct = Math.max(maxDiscountPct, line.discountPct || 0);
    byCode.set(line.taxCode, (byCode.get(line.taxCode) ?? 0) + a.amount);
    if (line.itemKind !== 'service') {
      goodsByCode.set(line.taxCode, (goodsByCode.get(line.taxCode) ?? 0) + a.amount);
    }
  }

  const taxes: TaxLine[] = [];
  let net = 0;
  let tax = 0;
  const exclusiveFactor = new Map<string, number>();
  for (const [code, base] of [...byCode.entries()].sort()) {
    const rate = rateOf(code, date);
    let t: Minor;
    let b: Minor;
    if (priceMode === 'exclusive') {
      b = base;
      t = roundHalfUp(base * rate);
    } else {
      t = roundHalfUp((base * rate) / (1 + rate));
      b = base - t;
    }
    exclusiveFactor.set(code, base === 0 ? 1 : b / base);
    taxes.push({ code, rate, base: b, amount: t });
    net += b;
    tax += t;
  }

  // Goods/services split of the tax-exclusive net.
  let netGoods = 0;
  for (const [code, amt] of goodsByCode) netGoods += roundHalfUp(amt * (exclusiveFactor.get(code) ?? 1));
  netGoods = Math.min(netGoods, net);
  const netServices = net - netGoods;

  for (const line of lines) {
    if (!line.whtCategory) continue;
    const a = lineAmounts(line);
    const ex = roundHalfUp(a.amount * (exclusiveFactor.get(line.taxCode) ?? 1));
    byWht.set(line.whtCategory, (byWht.get(line.whtCategory) ?? 0) + ex);
  }

  return {
    gross,
    discount,
    net,
    taxes,
    tax,
    total: net + tax,
    whtBases: [...byWht.entries()].map(([category, base]) => ({ category, base })),
    netGoods,
    netServices,
    maxDiscountPct,
  };
}
