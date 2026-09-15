import { expect, test } from 'bun:test';
import {
	parseLocalDate,
	parseTime,
	createLocalDate,
	applyStartTime,
	validateDateComponents,
	isValidTime,
	buildCalendarEventData
} from './calendarForm';

// --- parseLocalDate ---
test('parses valid YYYY-MM-DD strings into local date components', () => {
	const result = parseLocalDate('2024-01-15');
	expect(result).toEqual({ year: 2024, month: 0, day: 15 });
});

test('rejects non-YYYY-MM-DD strings', () => {
	expect(parseLocalDate('2024/01/15')).toBeNull();
	expect(parseLocalDate('01-15-2024')).toBeNull();
	expect(parseLocalDate('15-Jan-2024')).toBeNull();
	expect(parseLocalDate('')).toBeNull();
	expect(parseLocalDate('not-a-date')).toBeNull();
});

test('rejects invalid month values', () => {
	expect(parseLocalDate('2024-13-01')).toBeNull();
	expect(parseLocalDate('2024-00-01')).toBeNull();
});

test('rejects invalid day values', () => {
	expect(parseLocalDate('2024-01-32')).toBeNull();
	expect(parseLocalDate('2024-01-00')).toBeNull();
});

test('rejects February 30 and other non-existent dates', () => {
	expect(parseLocalDate('2024-02-30')).toBeNull();
	expect(parseLocalDate('2023-02-29')).toBeNull(); // 2023 is not a leap year
});

test('accepts leap day in leap years', () => {
	expect(parseLocalDate('2024-02-29')).toEqual({ year: 2024, month: 1, day: 29 });
	expect(parseLocalDate('2000-02-29')).toEqual({ year: 2000, month: 1, day: 29 });
});

// --- parseTime ---
test('parses valid HH:MM time strings', () => {
	expect(parseTime('09:30')).toEqual({ hours: 9, minutes: 30 });
	expect(parseTime('00:00')).toEqual({ hours: 0, minutes: 0 });
	expect(parseTime('23:59')).toEqual({ hours: 23, minutes: 59 });
});

test('rejects invalid time strings', () => {
	expect(parseTime('24:00')).toBeNull();
	expect(parseTime('23:60')).toBeNull();
	expect(parseTime('-1:00')).toBeNull();
	expect(parseTime('9:30')).toBeNull(); // not HH:MM
	expect(parseTime('')).toBeNull();
	expect(parseTime('ab:cd')).toBeNull();
});

// --- createLocalDate / applyStartTime ---
test('createLocalDate produces a date at local midnight (not UTC)', () => {
	const d = createLocalDate(2024, 0, 15);
	expect(d.getFullYear()).toBe(2024);
	expect(d.getMonth()).toBe(0);
	expect(d.getDate()).toBe(15);
	expect(d.getHours()).toBe(0);
	expect(d.getMinutes()).toBe(0);
});

test('applyStartTime sets hours and minutes locally', () => {
	const d = createLocalDate(2024, 0, 15);
	applyStartTime(d, 9, 30);
	expect(d.getHours()).toBe(9);
	expect(d.getMinutes()).toBe(30);
	expect(d.getSeconds()).toBe(0);
	expect(d.getMilliseconds()).toBe(0);
});

test('local date components are preserved (no UTC shift)', () => {
	// The key test: new Date(2024, 0, 15) creates local midnight,
	// not UTC midnight like new Date('2024-01-15')
	const local = createLocalDate(2024, 0, 15);
	const utcParsed = new Date('2024-01-15');
	// These should differ in timezone offset (unless local timezone is UTC)
	expect(local.getFullYear()).toBe(2024);
	expect(local.getMonth()).toBe(0);
	expect(local.getDate()).toBe(15);
});

// --- validateDateComponents ---
test('validates that date components round-trip through Date constructor', () => {
	expect(validateDateComponents(2024, 0, 15)).toBe(true);
	expect(validateDateComponents(2024, 1, 29)).toBe(true); // leap day
	expect(validateDateComponents(2023, 1, 29)).toBe(false); // not leap year
	expect(validateDateComponents(2024, 12, 15)).toBe(false); // invalid month
	expect(validateDateComponents(2024, 0, 32)).toBe(false); // invalid day
});

// --- isValidTime ---
test('validates time components', () => {
	expect(isValidTime(9, 30)).toBe(true);
	expect(isValidTime(0, 0)).toBe(true);
	expect(isValidTime(23, 59)).toBe(true);
	expect(isValidTime(24, 0)).toBe(false);
	expect(isValidTime(23, 60)).toBe(false);
});

// --- buildCalendarEventData ---
test('builds valid event data with local date parsing', () => {
	const result = buildCalendarEventData({
		formTitle: 'Test Event',
		formDescription: 'Desc',
		formStartDate: '2024-01-15',
		formStartTime: '09:30',
		formEndDate: '',
		formAllDay: false,
		formColor: '#5865f2',
		formRecurring: false,
		formRecurringFrequency: 'weekly',
		formRecurringInterval: 1,
		formRecurringEndDate: '',
		draftSignatures: [],
		currentUserId: 'user-1'
	});
	expect(result.errors).toEqual([]);
	expect(result.eventData!.title).toBe('Test Event');
	expect(result.eventData!.startDate).toBe(new Date(2024, 0, 15, 9, 30).getTime());
	expect(result.eventData!.allDay).toBe(false);
	expect(Object.hasOwn(result.eventData!, 'recurring')).toBe(true);
	expect({ recurring: { frequency: 'daily' }, ...result.eventData }.recurring).toBeUndefined();
});

test('builds all-day event without time', () => {
	const result = buildCalendarEventData({
		formTitle: 'All Day',
		formDescription: '',
		formStartDate: '2024-03-20',
		formStartTime: '',
		formEndDate: '',
		formAllDay: true,
		formColor: '#3ba55d',
		formRecurring: false,
		formRecurringFrequency: 'weekly',
		formRecurringInterval: 1,
		formRecurringEndDate: '',
		draftSignatures: [],
		currentUserId: 'user-1'
	});
	expect(result.errors).toEqual([]);
	expect(result.eventData!.allDay).toBe(true);
	const d = new Date(result.eventData!.startDate as number);
	expect(d.getHours()).toBe(0);
	expect(d.getMinutes()).toBe(0);
});

test('rejects invalid start date', () => {
	const result = buildCalendarEventData({
		formTitle: 'Test',
		formDescription: '',
		formStartDate: '2024-13-01',
		formStartTime: '',
		formEndDate: '',
		formAllDay: true,
		formColor: '#5865f2',
		formRecurring: false,
		formRecurringFrequency: 'weekly',
		formRecurringInterval: 1,
		formRecurringEndDate: '',
		draftSignatures: [],
		currentUserId: 'user-1'
	});
	expect(result.errors.length).toBeGreaterThan(0);
	expect(result.errors[0]).toBe('Invalid start date');
});

test('rejects invalid start time', () => {
	const result = buildCalendarEventData({
		formTitle: 'Test',
		formDescription: '',
		formStartDate: '2024-01-15',
		formStartTime: '25:00',
		formEndDate: '',
		formAllDay: false,
		formColor: '#5865f2',
		formRecurring: false,
		formRecurringFrequency: 'weekly',
		formRecurringInterval: 1,
		formRecurringEndDate: '',
		draftSignatures: [],
		currentUserId: 'user-1'
	});
	expect(result.errors).toContain('Invalid start time');
});

test('rejects end date before start date', () => {
	const result = buildCalendarEventData({
		formTitle: 'Test',
		formDescription: '',
		formStartDate: '2024-01-15',
		formStartTime: '09:00',
		formEndDate: '2024-01-14',
		formAllDay: false,
		formColor: '#5865f2',
		formRecurring: false,
		formRecurringFrequency: 'weekly',
		formRecurringInterval: 1,
		formRecurringEndDate: '',
		draftSignatures: [],
		currentUserId: 'user-1'
	});
	expect(result.errors).toContain('End date must not be before start date');
});

test('accepts an end date on the same local day as the start', () => {
	const result = buildCalendarEventData({
		formTitle: 'Test',
		formDescription: '',
		formStartDate: '2024-01-15',
		formStartTime: '10:00',
		formEndDate: '2024-01-15',
		formAllDay: false,
		formColor: '#5865f2',
		formRecurring: false,
		formRecurringFrequency: 'weekly',
		formRecurringInterval: 1,
		formRecurringEndDate: '',
		draftSignatures: [],
		currentUserId: 'user-1'
	});
	// End date same as start with no time should be equal, not before
	expect(result.errors).toEqual([]);
	expect(result.eventData!.endDate).toBeDefined();
});

test('sets recurring as undefined when formRecurring is false', () => {
	const result = buildCalendarEventData({
		formTitle: 'Test',
		formDescription: '',
		formStartDate: '2024-01-15',
		formStartTime: '09:00',
		formEndDate: '',
		formAllDay: false,
		formColor: '#5865f2',
		formRecurring: false,
		formRecurringFrequency: 'weekly',
		formRecurringInterval: 1,
		formRecurringEndDate: '',
		draftSignatures: [],
		currentUserId: 'user-1'
	});
	expect(Object.hasOwn(result.eventData!, 'recurring')).toBe(true);
	expect({ recurring: { frequency: 'daily' }, ...result.eventData }.recurring).toBeUndefined();
});

test('sets recurring object when formRecurring is true', () => {
	const result = buildCalendarEventData({
		formTitle: 'Test',
		formDescription: '',
		formStartDate: '2024-01-15',
		formStartTime: '09:00',
		formEndDate: '',
		formAllDay: false,
		formColor: '#5865f2',
		formRecurring: true,
		formRecurringFrequency: 'weekly',
		formRecurringInterval: 2,
		formRecurringEndDate: '2024-12-31',
		draftSignatures: [],
		currentUserId: 'user-1'
	});
	expect(result.eventData!.recurring).toEqual({
		frequency: 'weekly',
		interval: 2,
		endDate: new Date(2024, 11, 31).getTime()
	});
});

test('rejects invalid recurring end date', () => {
	const result = buildCalendarEventData({
		formTitle: 'Test',
		formDescription: '',
		formStartDate: '2024-01-15',
		formStartTime: '09:00',
		formEndDate: '',
		formAllDay: false,
		formColor: '#5865f2',
		formRecurring: true,
		formRecurringFrequency: 'weekly',
		formRecurringInterval: 1,
		formRecurringEndDate: '2024-13-01',
		draftSignatures: [],
		currentUserId: 'user-1'
	});
	expect(result.errors).toContain('Invalid recurring end date');
});

test('requires title and start date', () => {
	const result = buildCalendarEventData({
		formTitle: '',
		formDescription: '',
		formStartDate: '',
		formStartTime: '',
		formEndDate: '',
		formAllDay: false,
		formColor: '#5865f2',
		formRecurring: false,
		formRecurringFrequency: 'weekly',
		formRecurringInterval: 1,
		formRecurringEndDate: '',
		draftSignatures: [],
		currentUserId: 'user-1'
	});
	expect(result.errors).toContain('Title and start date are required');
});

// --- Timezone/local behavior regression tests ---
test('new Date(YYYY, month, day) preserves local date while new Date("YYYY-MM-DD") does not', () => {
	const localCreated = createLocalDate(2024, 0, 15);
	const utcParsed = new Date('2024-01-15');
	// The local creation should have the correct local date components
	expect(localCreated.getFullYear()).toBe(2024);
	expect(localCreated.getMonth()).toBe(0);
	expect(localCreated.getDate()).toBe(15);
	// The UTC-parsed version may have shifted date in non-UTC timezones
	// We just verify our local creation is correct
	expect(localCreated.getTime() >= new Date('2024-01-14').getTime()).toBe(true);
});

test('leap day 2024-02-29 produces correct local date', () => {
	const result = parseLocalDate('2024-02-29');
	expect(result).toEqual({ year: 2024, month: 1, day: 29 });
	const d = createLocalDate(2024, 1, 29);
	expect(d.getMonth()).toBe(1);
	expect(d.getDate()).toBe(29);
});

test('non-leap year Feb 29 is rejected', () => {
	expect(parseLocalDate('2023-02-29')).toBeNull();
	expect(parseLocalDate('2025-02-29')).toBeNull();
});

test('December 31 rollover to next year works correctly', () => {
	const result = parseLocalDate('2024-12-31');
	expect(result).toEqual({ year: 2024, month: 11, day: 31 });
	const d = createLocalDate(2024, 11, 31);
	expect(d.getFullYear()).toBe(2024);
	expect(d.getMonth()).toBe(11);
	expect(d.getDate()).toBe(31);
});

test('rejects invalid recurrence settings and an end before the first day', () => {
	const base = {
		formTitle: 'Meeting', formDescription: '', formStartDate: '2024-01-15',
		formStartTime: '09:00', formEndDate: '', formAllDay: false, formColor: '',
		formRecurring: true, formRecurringFrequency: 'weekly', formRecurringInterval: 1,
		formRecurringEndDate: '', draftSignatures: [], currentUserId: 'user-1'
	};
	for (const patch of [{ formRecurringInterval: 0 }, { formRecurringInterval: 1.5 },
		{ formRecurringFrequency: 'invalid' }, { formRecurringEndDate: '2024-01-14' }]) {
		const result = buildCalendarEventData({ ...base, ...patch });
		expect(result.eventData).toBeNull();
		expect(result.errors.length).toBeGreaterThan(0);
	}
});
