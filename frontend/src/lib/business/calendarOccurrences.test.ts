import { expect, test } from 'bun:test';
import { occurrencesForRange } from './calendarOccurrences';
import type { CalendarEvent } from './types';

// Run with TZ=America/New_York to exercise daylight-saving boundaries.

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
	return {
		id: 'evt-1',
		title: 'Test Event',
		startDate: new Date(2024, 0, 15).getTime(),
		endDate: undefined,
		allDay: true,
		createdBy: 'user-1',
		...overrides
	};
}

function d(year: number, month: number, day: number, h = 0, m = 0, s = 0, ms = 0): Date {
	return new Date(year, month, day, h, m, s, ms);
}

function ts(year: number, month: number, day: number, h = 0, m = 0, s = 0, ms = 0): number {
	return new Date(year, month, day, h, m, s, ms).getTime();
}

const NY_TZ = 'America/New_York';

test('TZ is America/New_York', () => {
	expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(NY_TZ);
});

// --- Non-recurring: single day ---
test('non-recurring single-day event within range returns one occurrence', () => {
	const ev = makeEvent({ allDay: true, startDate: ts(2024, 0, 15) });
	const result = occurrencesForRange(ev, d(2024, 0, 1), d(2024, 1, 1));
	expect(result).toHaveLength(1);
	expect(result[0].start).toBe(ts(2024, 0, 15));
	expect(result[0].end).toBe(ts(2024, 0, 15));
});

test('non-recurring event before range returns empty', () => {
	const ev = makeEvent({ allDay: true, startDate: ts(2024, 0, 15) });
	const result = occurrencesForRange(ev, d(2024, 2, 1), d(2024, 2, 28));
	expect(result).toHaveLength(0);
});

test('non-recurring event after range returns empty', () => {
	const ev = makeEvent({ allDay: true, startDate: ts(2024, 3, 15) });
	const result = occurrencesForRange(ev, d(2024, 0, 1), d(2024, 2, 28));
	expect(result).toHaveLength(0);
});

// --- Non-recurring: multi-day span ---
test('non-recurring multi-day event span preserved in local calendar days', () => {
	const ev = makeEvent({ allDay: true, startDate: ts(2024, 0, 15), endDate: ts(2024, 0, 17) });
	const result = occurrencesForRange(ev, d(2024, 0, 1), d(2024, 1, 1));
	expect(result).toHaveLength(1);
	expect(result[0].start).toBe(ts(2024, 0, 15));
	expect(result[0].end).toBe(ts(2024, 0, 17));
});

test('non-recurring non-allDay event preserves time-of-day', () => {
	const ev = makeEvent({ allDay: false, startDate: ts(2024, 0, 15, 10, 30), endDate: ts(2024, 0, 15, 14, 0) });
	const result = occurrencesForRange(ev, d(2024, 0, 1), d(2024, 1, 1));
	expect(result).toHaveLength(1);
	expect(result[0].start).toBe(ts(2024, 0, 15, 10, 30));
	expect(result[0].end).toBe(ts(2024, 0, 15, 14, 0));
});

test('non-recurring event out of range (after) returns empty', () => {
	const ev = makeEvent({ allDay: true, startDate: ts(2024, 0, 15), endDate: ts(2024, 0, 17) });
	const result = occurrencesForRange(ev, d(2023, 10, 1), d(2023, 11, 30));
	expect(result).toHaveLength(0);
});

// --- Range bounds validation ---
test('range exceeding maxRange366days returns empty', () => {
	const ev = makeEvent({ allDay: true, startDate: ts(2024, 0, 15) });
	const result = occurrencesForRange(ev, d(2024, 0, 1), d(2024, 12, 31));
	expect(result).toHaveLength(0);
});

test('event span exceeding maxSpan366days returns empty', () => {
	const ev = makeEvent({ allDay: true, startDate: ts(2024, 0, 1), endDate: ts(2025, 1, 15) });
	const result = occurrencesForRange(ev, d(2024, 0, 1), d(2024, 12, 31));
	expect(result).toHaveLength(0);
});

test('invalid inputs return empty', () => {
	expect(occurrencesForRange(null as unknown as CalendarEvent, d(2024, 0, 1), d(2024, 1, 1))).toHaveLength(0);
	expect(occurrencesForRange(makeEvent(), null as unknown as Date, d(2024, 1, 1))).toHaveLength(0);
	expect(occurrencesForRange(makeEvent(), d(2024, 1, 1), d(2024, 0, 1))).toHaveLength(0);
});

// --- Daily recurrence ---
test('daily interval 1 recurrences within range', () => {
	const ev = makeEvent({
		allDay: true,
		startDate: ts(2024, 0, 15),
		recurring: { frequency: 'daily', interval: 1 }
	});
	const result = occurrencesForRange(ev, d(2024, 0, 15), d(2024, 0, 20));
	expect(result).toHaveLength(6);
	for (let i = 0; i < 6; i++) {
		expect(result[i].start).toBe(ts(2024, 0, 15 + i));
	}
});

test('daily interval 2 skips alternate days', () => {
	const ev = makeEvent({
		allDay: true,
		startDate: ts(2024, 0, 1),
		recurring: { frequency: 'daily', interval: 2 }
	});
	const result = occurrencesForRange(ev, d(2024, 0, 1), d(2024, 0, 10));
	expect(result).toHaveLength(5);
	for (let i = 0; i < 5; i++) {
		expect(result[i].start).toBe(ts(2024, 0, 1 + i * 2));
	}
});

// --- Weekly recurrence ---
test('weekly interval 1 recurrences within range', () => {
	const ev = makeEvent({
		allDay: true,
		startDate: ts(2024, 0, 15),
		recurring: { frequency: 'weekly', interval: 1 }
	});
	const result = occurrencesForRange(ev, d(2024, 0, 15), d(2024, 2, 15));
	expect(result.length).toBeGreaterThanOrEqual(8);
	expect(result.length).toBeLessThanOrEqual(15);
	for (const occ of result) {
		const od = new Date(occ.start);
		const diffMs = od.getTime() - ts(2024, 0, 15);
		expect(od.getDay()).toBe(new Date(ev.startDate).getDay());
		expect(od.getHours()).toBe(new Date(ev.startDate).getHours());
	}
});

test('weekly interval 2 recurrences every 14 days', () => {
	const ev = makeEvent({
		allDay: true,
		startDate: ts(2024, 0, 15),
		recurring: { frequency: 'weekly', interval: 2 }
	});
	const result = occurrencesForRange(ev, d(2024, 0, 15), d(2024, 1, 15));
	expect(result.length).toBeGreaterThanOrEqual(3);
	for (const occ of result) {
		const od = new Date(occ.start);
		const diffMs = od.getTime() - ts(2024, 0, 15);
		expect(od.getDay()).toBe(new Date(ev.startDate).getDay());
	}
});

// --- Monthly recurrence with missing dates (Jan 31 skips Feb) ---
test('monthly interval 1 from Jan 31 skips Feb (missing date)', () => {
	const ev = makeEvent({
		allDay: true,
		startDate: ts(2024, 0, 31),
		recurring: { frequency: 'monthly', interval: 1 }
	});
	const result = occurrencesForRange(ev, d(2024, 0, 1), d(2024, 5, 30));
	expect(result.length).toBe(3);
	const months = result.map(r => new Date(r.start).getMonth());
	expect(months).toEqual([0, 2, 4]);
});

test('monthly interval 1 from Jan 31 includes Mar 31, May 31', () => {
	const ev = makeEvent({
		allDay: true,
		startDate: ts(2024, 0, 31),
		recurring: { frequency: 'monthly', interval: 1 }
	});
	const result = occurrencesForRange(ev, d(2024, 0, 1), d(2024, 11, 31));
	const months = result.map(r => new Date(r.start).getMonth());
	expect(months).toEqual([0, 2, 4, 6, 7, 9, 11]);
});

// --- Leap year: Feb 29 skips non-leap years ---
test('yearly interval 1 from Feb 29 skips non-leap years', () => {
	const ev = makeEvent({
		allDay: true,
		startDate: ts(2024, 1, 29),
		recurring: { frequency: 'yearly', interval: 1 }
	});
	const result = [2024, 2025, 2026, 2027, 2028].flatMap(year => occurrencesForRange(ev, d(year, 1, 1), d(year, 2, 1)));
	expect(result.length).toBe(2);
	const years = result.map(r => new Date(r.start).getFullYear());
	expect(years).toEqual([2024, 2028]);
});

test('leap year Feb 29 occurrence has correct date', () => {
	const ev = makeEvent({
		allDay: true,
		startDate: ts(2024, 1, 29),
		recurring: { frequency: 'yearly', interval: 1 }
	});
	const result = occurrencesForRange(ev, d(2024, 1, 29), d(2024, 2, 1));
	expect(result).toHaveLength(1);
	expect(result[0].start).toBe(ts(2024, 1, 29));
});

// --- endDate inclusive ---
test('recurring endDate inclusive stop at specified local day', () => {
	const ev = makeEvent({
		allDay: true,
		startDate: ts(2024, 0, 1),
		recurring: { frequency: 'daily', interval: 1, endDate: ts(2024, 0, 5) }
	});
	const result = occurrencesForRange(ev, d(2024, 0, 1), d(2024, 0, 31));
	expect(result).toHaveLength(5);
	expect(result[0].start).toBe(ts(2024, 0, 1));
	expect(result[4].start).toBe(ts(2024, 0, 5));
});

test('recurring endDate before first occurrence returns empty', () => {
	const ev = makeEvent({
		allDay: true,
		startDate: ts(2024, 0, 10),
		recurring: { frequency: 'daily', interval: 1, endDate: ts(2024, 0, 5) }
	});
	const result = occurrencesForRange(ev, d(2024, 0, 1), d(2024, 1, 1));
	expect(result).toHaveLength(0);
});

// --- cancelled dates ---
test('cancelledDates numeric array skips matching local day', () => {
	const ev = makeEvent({
		allDay: true,
		startDate: ts(2024, 0, 1),
		recurring: { frequency: 'daily', interval: 1 },
		cancelledDates: [ts(2024, 0, 3), ts(2024, 0, 5)]
	});
	const result = occurrencesForRange(ev, d(2024, 0, 1), d(2024, 0, 7));
	expect(result).toHaveLength(5);
	const dates = result.map(r => new Date(r.start).getDate());
	expect(dates).not.toContain(3);
	expect(dates).not.toContain(5);
	expect(dates).toEqual([1, 2, 4, 6, 7]);
});

test('cancelledDates BigInt64Array skips matching local day', () => {
	const cancelled = new BigInt64Array([BigInt(ts(2024, 0, 3)), BigInt(ts(2024, 0, 5))]);
	const ev = makeEvent({
		allDay: true,
		startDate: ts(2024, 0, 1),
		recurring: { frequency: 'daily', interval: 1 },
		cancelledDates: cancelled
	});
	const result = occurrencesForRange(ev, d(2024, 0, 1), d(2024, 0, 7));
	expect(result).toHaveLength(5);
	const dates = result.map(r => new Date(r.start).getDate());
	expect(dates).not.toContain(3);
	expect(dates).not.toContain(5);
});

// --- Multi-day non-recurring span in local days with DST ---
test('non-recurring multi-day event across DST boundary preserves local span', () => {
	const ev = makeEvent({ allDay: true, startDate: ts(2024, 2, 10), endDate: ts(2024, 3, 10) });
	const result = occurrencesForRange(ev, d(2024, 2, 1), d(2024, 4, 1));
	expect(result).toHaveLength(1);
	expect(result[0].start).toBe(ts(2024, 2, 10));
	expect(result[0].end).toBe(ts(2024, 3, 10));
});

// --- At most 1 occurrence per day ---
test('at most 1 occurrence per day', () => {
	const ev = makeEvent({
		allDay: true,
		startDate: ts(2024, 0, 1),
		recurring: { frequency: 'daily', interval: 1 }
	});
	const result = occurrencesForRange(ev, d(2024, 0, 1), d(2024, 0, 10));
	const dateStrings = result.map(r => new Date(r.start).toDateString());
	const unique = new Set(dateStrings);
	expect(dateStrings.length).toBe(unique.size);
});

// --- Bounded computation: not iterating from decades-old start ---
test('recurrence from decades-old start is bounded near range', () => {
	const ev = makeEvent({
		allDay: true,
		startDate: ts(1990, 0, 1),
		recurring: { frequency: 'daily', interval: 1 }
	});
	const result = occurrencesForRange(ev, d(2024, 0, 1), d(2024, 0, 5));
	expect(result).toHaveLength(5);
	for (let i = 0; i < 5; i++) {
		expect(result[i].start).toBe(ts(2024, 0, 1 + i));
	}
});

test('monthly recurrence from decades-old start bounded near range', () => {
	const ev = makeEvent({
		allDay: true,
		startDate: ts(1990, 0, 1),
		recurring: { frequency: 'monthly', interval: 1 }
	});
	const result = occurrencesForRange(ev, d(2024, 0, 1), d(2024, 0, 31));
	expect(result.length).toBeGreaterThan(0);
	for (const occ of result) {
		const year = new Date(occ.start).getFullYear();
		expect(year).toBe(2024);
	}
});

// --- Non-recurring overlap ---
test('non-recurring event partially overlapping range', () => {
	const ev = makeEvent({ allDay: true, startDate: ts(2024, 0, 15), endDate: ts(2024, 0, 20) });
	const result = occurrencesForRange(ev, d(2024, 0, 18), d(2024, 1, 1));
	expect(result).toHaveLength(1);
	expect(result[0].start).toBe(ts(2024, 0, 15));
	expect(result[0].end).toBe(ts(2024, 0, 20));
});

// --- Time-of-day preservation for recurring ---
test('recurring non-allDay preserves time-of-day', () => {
	const ev = makeEvent({
		allDay: false,
		startDate: ts(2024, 0, 15, 10, 30),
		endDate: ts(2024, 0, 15, 14, 0),
		recurring: { frequency: 'daily', interval: 1 }
	});
	const result = occurrencesForRange(ev, d(2024, 0, 15), d(2024, 0, 17));
	expect(result).toHaveLength(3);
	expect(result[0].start).toBe(ts(2024, 0, 15, 10, 30));
	expect(result[0].end).toBe(ts(2024, 0, 15, 14, 0));
	expect(result[1].start).toBe(ts(2024, 0, 16, 10, 30));
	expect(result[2].start).toBe(ts(2024, 0, 17, 10, 30));
});

// --- Multi-day recurring ---
test('recurring multi-day event spans correct local calendar days', () => {
	const ev = makeEvent({
		allDay: true,
		startDate: ts(2024, 0, 1),
		endDate: ts(2024, 0, 3),
		recurring: { frequency: 'weekly', interval: 1 }
	});
	const result = occurrencesForRange(ev, d(2024, 0, 1), d(2024, 0, 31));
	for (const occ of result) {
		const occEnd = new Date(occ.end);
		const occStart = new Date(occ.start);
		expect(occEnd.getDate() - occStart.getDate()).toBe(2);
		expect(occEnd.getDate() - occStart.getDate()).toBe(2);
	}
});

test('recurring multi-day weekly: each occurrence is 3 days', () => {
	const ev = makeEvent({
		allDay: true,
		startDate: ts(2024, 0, 1),
		endDate: ts(2024, 0, 3),
		recurring: { frequency: 'weekly', interval: 1 }
	});
	const result = occurrencesForRange(ev, d(2024, 0, 1), d(2024, 0, 31));
	for (const occ of result) {
		const startD = new Date(occ.start);
		const endD = new Date(occ.end);
		expect(endD.getDate() - startD.getDate()).toBe(2);
		expect(endD.getMonth()).toBe(startD.getMonth());
	}
});

// --- No UI/store/persistence side effects ---
test('pure function: does not mutate event or inputs', () => {
	const ev = makeEvent({ allDay: true, startDate: ts(2024, 0, 15) });
	const originalStartDate = ev.startDate;
	occurrencesForRange(ev, d(2024, 0, 1), d(2024, 1, 1));
	expect(ev.startDate).toBe(originalStartDate);
});


test('multi-day recurrence beginning before the visible window still overlaps it', () => {
	const ev = makeEvent({ startDate: ts(2024, 2, 8, 9), endDate: ts(2024, 2, 11, 10), allDay: false, recurring: { frequency: 'weekly', interval: 1 } });
	const result = occurrencesForRange(ev, d(2024, 2, 10), d(2024, 2, 10));
	expect(result).toEqual([{ start: ts(2024, 2, 8, 9), end: ts(2024, 2, 11, 10) }]);
});

test('nonrecurring event on the final visible day includes afternoon times', () => {
	const ev = makeEvent({ startDate: ts(2024, 2, 10, 15), allDay: false });
	expect(occurrencesForRange(ev, d(2024, 2, 10), d(2024, 2, 10))).toHaveLength(1);
});
