import type { CalendarEvent, ItemSignature } from './types';

export function parseLocalDate(dateStr: string): { year: number; month: number; day: number } | null {
	const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!match) return null;
	const year = parseInt(match[1], 10);
	const month = parseInt(match[2], 10) - 1;
	const day = parseInt(match[3], 10);
	if (isNaN(year) || isNaN(month) || isNaN(day)) return null;
	const d = new Date(year, month, day);
	if (d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day) return null;
	return { year, month, day };
}

export function parseTime(timeStr: string): { hours: number; minutes: number } | null {
	const match = timeStr.match(/^(\d{2}):(\d{2})$/);
	if (!match) return null;
	const hours = parseInt(match[1], 10);
	const minutes = parseInt(match[2], 10);
	if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
	return { hours, minutes };
}

export function createLocalDate(year: number, month: number, day: number): Date {
	return new Date(year, month, day);
}

export function applyStartTime(date: Date, hours: number, minutes: number): void {
	date.setHours(hours, minutes, 0, 0);
}

export function validateDateComponents(year: number, month: number, day: number): boolean {
	const d = new Date(year, month, day);
	return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day;
}

export function isValidTime(hours: number, minutes: number): boolean {
	return !isNaN(hours) && !isNaN(minutes) && hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

export interface BuildEventResult {
	eventData: Omit<CalendarEvent, 'id'> | null;
	errors: string[];
}

export function buildCalendarEventData(params: {
	formTitle: string;
	formDescription: string;
	formStartDate: string;
	formStartTime: string;
	formEndDate: string;
	formAllDay: boolean;
	formColor: string;
	formRecurring: boolean;
	formRecurringFrequency: string;
	formRecurringInterval: number;
	formRecurringEndDate: string;
	draftSignatures: ItemSignature[];
	currentUserId: string;
}): BuildEventResult {

	if (!params.formTitle.trim() || !params.formStartDate) {
		return { eventData: null, errors: ['Title and start date are required'] };
	}

	const startParts = parseLocalDate(params.formStartDate);
	if (!startParts) {
		return { eventData: null, errors: ['Invalid start date'] };
	}

	const startDate = createLocalDate(startParts.year, startParts.month, startParts.day);

	if (!params.formAllDay) {
		const time = parseTime(params.formStartTime);
		if (params.formStartTime && !time) {
			return { eventData: null, errors: ['Invalid start time'] };
		}
		if (time) {
			applyStartTime(startDate, time.hours, time.minutes);
		}
	}

	let endDate: number | undefined;
	if (params.formEndDate) {
		const endParts = parseLocalDate(params.formEndDate);
		if (!endParts) {
			return { eventData: null, errors: ['Invalid end date'] };
		}
		const endDateObj = createLocalDate(endParts.year, endParts.month, endParts.day);
		if (!params.formAllDay && params.formStartTime) {
			const time = parseTime(params.formStartTime);
			if (time) {
				endDateObj.setHours(time.hours, time.minutes, 0, 0);
			}
		}
		if (endDateObj < startDate) {
			return { eventData: null, errors: ['End date must not be before start date'] };
		}
		endDate = endDateObj.getTime();
	}

	if (params.formRecurring && (!['daily', 'weekly', 'monthly', 'yearly'].includes(params.formRecurringFrequency) || !Number.isInteger(params.formRecurringInterval) || params.formRecurringInterval < 1)) {
		return { eventData: null, errors: ['Choose a valid repeat frequency and positive whole-number interval'] };
	}

	let recurringEndDate: number | undefined;
	if (params.formRecurring && params.formRecurringEndDate) {
		const recEndParts = parseLocalDate(params.formRecurringEndDate);
		if (!recEndParts) {
			return { eventData: null, errors: ['Invalid recurring end date'] };
		}
		recurringEndDate = createLocalDate(recEndParts.year, recEndParts.month, recEndParts.day).getTime();
		if (recurringEndDate < createLocalDate(startParts.year, startParts.month, startParts.day).getTime()) {
			return { eventData: null, errors: ['Repeat end date must not be before start date'] };
		}
	}

	const eventData: Omit<CalendarEvent, 'id'> = {
		title: params.formTitle.trim(),
		description: params.formDescription.trim() || undefined,
		startDate: startDate.getTime(),
		endDate,
		allDay: params.formAllDay,
		color: params.formColor,
		createdBy: params.currentUserId,
		signatures: params.draftSignatures.length > 0 ? [...params.draftSignatures] : undefined,
		signedBy: params.draftSignatures.length > 0 ? params.draftSignatures[0].name : undefined,
		recurring: params.formRecurring
			? {
					frequency: params.formRecurringFrequency as NonNullable<CalendarEvent['recurring']>['frequency'],
					interval: params.formRecurringInterval,
					endDate: recurringEndDate
			  }
			: undefined
	};

	return { eventData, errors: [] };
}
