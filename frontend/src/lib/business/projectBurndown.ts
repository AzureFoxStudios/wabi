export type BurnRevision = {
 taskId: string; updatedAtMicros: number; revision: number; status: string;
 isArchived: boolean; humanEstimateMinutes?: number | null;
};
export function projectBurndown(history: BurnRevision[]) {
 const cards = new Map<string, BurnRevision>();
 const points: { at: number; remainingMinutes: number; scopeMinutes: number; unestimated: number }[] = [];
 for (const row of [...history].sort((a,b) => a.updatedAtMicros - b.updatedAtMicros || a.revision - b.revision)) {
  const old = cards.get(row.taskId);
  if (old && row.revision <= old.revision) continue;
  cards.set(row.taskId, row);
  let remainingMinutes = 0, scopeMinutes = 0, unestimated = 0;
  for (const card of cards.values()) {
   if (card.isArchived || ['archived', 'scrapped', 'ideas'].includes(card.status)) continue;
   if (card.humanEstimateMinutes == null) { unestimated++; continue; }
   scopeMinutes += card.humanEstimateMinutes;
   if (card.status !== 'done') remainingMinutes += card.humanEstimateMinutes;
  }
  points.push({at: row.updatedAtMicros / 1000, remainingMinutes, scopeMinutes, unestimated});
 }
 return points;
}
