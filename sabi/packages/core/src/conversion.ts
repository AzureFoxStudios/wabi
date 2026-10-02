import { roundQty } from './money.ts';
import type { DocLine, Document } from './types.ts';

/**
 * How much of each source line has already been carried into non-void child
 * documents of a given type. Keyed by source line id.
 */
export function consumedQty(children: Document[], childType?: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of children) {
    if (c.phase === 'void') continue;
    if (childType && c.type !== childType) continue;
    for (const l of c.lines) {
      if (!l.sourceLineId) continue;
      m.set(l.sourceLineId, roundQty((m.get(l.sourceLineId) ?? 0) + l.qty));
    }
  }
  return m;
}

/** Lines still open on `source` for conversion into `childType`. */
export function openLines(source: Document, children: Document[], childType: string): DocLine[] {
  const used = consumedQty(children, childType);
  const out: DocLine[] = [];
  for (const l of source.lines) {
    const remaining = roundQty(l.qty - (used.get(l.id) ?? 0));
    if (remaining <= 0) continue;
    out.push({ ...l, qty: remaining, sourceLineId: l.id });
  }
  return out;
}

/** 0..1 progress of children against source quantities. */
export function fulfilment(source: Document, children: Document[], childType?: string): number {
  const used = consumedQty(children, childType);
  let need = 0;
  let got = 0;
  for (const l of source.lines) {
    need += l.qty;
    got += Math.min(l.qty, used.get(l.id) ?? 0);
  }
  return need === 0 ? 0 : got / need;
}
