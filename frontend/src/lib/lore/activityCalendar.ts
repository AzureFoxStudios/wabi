import { revisionTime } from './workspacePresentation';
export function revisionCalendar(revisions: readonly { timestamp: number }[], now = new Date()) {
 const end = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
 const start = new Date(end); start.setUTCDate(start.getUTCDate() - 364); start.setUTCDate(start.getUTCDate() - start.getUTCDay());
 const counts = new Map<string, number>();
 for (const revision of revisions) {
  const time = revisionTime(revision.timestamp);
  if (time === null) continue;
  const date = new Date(time).toISOString().slice(0, 10);
  counts.set(date, (counts.get(date) || 0) + 1);
 }
 const days: { date: string; count: number }[] = [];
 for (let time = start.getTime(); time <= end.getTime(); time += 86400000) {
  const date = new Date(time).toISOString().slice(0, 10);
  days.push({ date, count: counts.get(date) || 0 });
 }
 return days;
}
