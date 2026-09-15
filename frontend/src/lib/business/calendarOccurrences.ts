import type { CalendarEvent } from './types';
const DAY = 86_400_000;
function ordinal(date: Date): number {
	const utc = new Date(0);
	utc.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
	utc.setUTCHours(0, 0, 0, 0);
	return utc.getTime() / DAY;
}
/** Visible local days, inclusive. Missing month/year dates are skipped.
 * Scan only the requested days plus the event span; never replay years of history.
 */
export function occurrencesForRange(event: CalendarEvent, rangeStart: Date, rangeEnd: Date): Array<{ start: number; end: number }> {
	if (!event || !rangeStart || !rangeEnd) return [];
	const start = new Date(event.startDate), end = new Date(event.endDate ?? event.startDate);
	if (![start, end, rangeStart, rangeEnd].every(d => Number.isFinite(d.getTime())) || end < start) return [];
	const first = ordinal(rangeStart), last = ordinal(rangeEnd), original = ordinal(start), span = ordinal(end) - original;
	if (last < first || last - first > 366 || span < 0 || span > 366) return [];
	const rule = event.recurring;
	if (rule && (!Number.isSafeInteger(rule.interval) || rule.interval < 1 || !['daily', 'weekly', 'monthly', 'yearly'].includes(rule.frequency))) return [];
	const until = rule?.endDate === undefined ? Infinity : ordinal(new Date(rule.endDate));
	if (Number.isNaN(until)) return [];
	const cancelled = new Set<number>();
	for (const value of event.cancelledDates ?? []) cancelled.add(ordinal(new Date(Number(value))));
	if (!rule) return original <= last && ordinal(end) >= first && !cancelled.has(original) ? [{ start: start.getTime(), end: end.getTime() }] : [];
	const cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate() - span);
	const results: Array<{ start: number; end: number }> = [];
	for (let count = 0; count <= 733; count++, cursor.setDate(cursor.getDate() + 1)) {
		const day = ordinal(cursor);
		if (day > last || day > until) break;
		if (day < original || cancelled.has(day)) continue;
		const days = day - original;
		const months = (cursor.getFullYear() - start.getFullYear()) * 12 + cursor.getMonth() - start.getMonth();
		const years = cursor.getFullYear() - start.getFullYear();
		const matches = rule.frequency === 'daily' ? days % rule.interval === 0
			: rule.frequency === 'weekly' ? days % (7 * rule.interval) === 0
			: rule.frequency === 'monthly' ? months % rule.interval === 0 && cursor.getDate() === start.getDate()
			: years % rule.interval === 0 && cursor.getMonth() === start.getMonth() && cursor.getDate() === start.getDate();
		if (!matches) continue;
		const occurrenceStart = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds());
		const occurrenceEnd = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + span, end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds());
		results.push({ start: occurrenceStart.getTime(), end: occurrenceEnd.getTime() });
	}
	return results;
}
