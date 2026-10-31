import { describe, expect, test } from 'bun:test';
import { computeStreamMarks, formatDayLabel, localDayKey, MESSAGE_GROUP_WINDOW_MS } from './streamMarks';

// Local times, so the day boundaries do not depend on the machine's time zone.
const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 9, 21, 12);
const words = { today: 'Today', yesterday: 'Yesterday' };

describe('day rules', () => {
	test('the first drawn row opens its day; later rows only at a day change', () => {
		const rows = [
			{ id: 'a', user: 'theo', timestamp: at(2026, 9, 20, 23, 58) },
			{ id: 'b', user: 'theo', timestamp: at(2026, 9, 20, 23, 59) },
			{ id: 'c', user: 'theo', timestamp: at(2026, 9, 21, 0, 1) },
			{ id: 'd', user: 'nora', timestamp: at(2026, 9, 21, 9, 18) }
		];
		const marks = computeStreamMarks(rows, { now: NOW, locale: 'en-GB', words });
		expect(marks.map((mark) => mark.day?.relative ?? null)).toEqual(['Yesterday', null, 'Today', null]);
		expect(marks[2].day?.date).toBe('Monday 21 September');
		expect(marks[2].day?.full).toBe('Monday 21 September 2026');
	});

	test('grouping always breaks at a day boundary, even within the group window', () => {
		const rows = [
			{ id: 'a', user: 'theo', timestamp: at(2026, 9, 20, 23, 59) },
			{ id: 'b', user: 'theo', timestamp: at(2026, 9, 21, 0, 1) }
		];
		const marks = computeStreamMarks(rows, { now: NOW, words });
		expect(marks[1].groupedWithPrevious).toBe(false);
		expect(marks[0].groupedWithNext).toBe(false);
	});

	test('older days have no relative word, and another year names its year', () => {
		expect(formatDayLabel(at(2026, 9, 19, 10), NOW, 'en-GB', words)).toMatchObject({ relative: null, date: 'Saturday 19 September' });
		expect(formatDayLabel(at(2025, 9, 19, 10), NOW, 'en-GB', words).date).toBe('Friday 19 September 2025');
	});

	test('an unknown locale falls back instead of throwing', () => {
		expect(() => formatDayLabel(at(2026, 9, 19, 10), NOW, 'not a locale!!', words)).not.toThrow();
	});

	test('localDayKey is the local calendar day', () => {
		expect(localDayKey(at(2026, 1, 2, 0, 0))).toBe('2026-01-02');
		expect(localDayKey(Number.NaN)).toBe('');
	});
});

describe('grouping', () => {
	const base = at(2026, 9, 21, 9, 0);
	test('same author inside the window continues; the window is exclusive of later gaps', () => {
		const rows = [
			{ id: 'a', user: 'mira', timestamp: base },
			{ id: 'b', user: 'mira', timestamp: base + MESSAGE_GROUP_WINDOW_MS },
			{ id: 'c', user: 'mira', timestamp: base + 2 * MESSAGE_GROUP_WINDOW_MS + 1 }
		];
		const marks = computeStreamMarks(rows, { now: NOW, words });
		expect(marks.map((mark) => mark.groupedWithPrevious)).toEqual([false, true, false]);
		expect(marks.map((mark) => mark.groupedWithNext)).toEqual([true, false, false]);
	});

	test('the unread rule and replies break a group', () => {
		const rows = [
			{ id: 'a', user: 'mira', timestamp: base },
			{ id: 'b', user: 'mira', timestamp: base + 1000 },
			{ id: 'c', user: 'mira', timestamp: base + 2000, replyTo: 'a' }
		];
		const marks = computeStreamMarks(rows, { now: NOW, words, firstUnreadId: 'b' });
		expect(marks.map((mark) => mark.unread)).toEqual([false, true, false]);
		expect(marks.map((mark) => mark.groupedWithPrevious)).toEqual([false, false, false]);
	});

	test('a hidden row neither opens a day nor anchors the next author', () => {
		const rows = [
			{ id: 'a', user: 'nora', timestamp: at(2026, 9, 20, 22) },
			{ id: 'hidden', user: 'mira', timestamp: at(2026, 9, 21, 9) },
			{ id: 'b', user: 'mira', timestamp: at(2026, 9, 21, 9, 1) }
		];
		const marks = computeStreamMarks(rows, { now: NOW, words, isRendered: (row) => row.id !== 'hidden' });
		expect(marks[1]).toMatchObject({ rendered: false, day: null, groupedWithPrevious: false });
		// The day rule moves to the first drawn row of the day, and that row starts its own group.
		expect(marks[2].day?.relative).toBe('Today');
		expect(marks[2].groupedWithPrevious).toBe(false);
	});

	test('rows without an author never group', () => {
		const rows = [
			{ id: 'a', timestamp: base },
			{ id: 'b', timestamp: base + 1000 }
		];
		expect(computeStreamMarks(rows, { now: NOW, words })[1].groupedWithPrevious).toBe(false);
	});
});
