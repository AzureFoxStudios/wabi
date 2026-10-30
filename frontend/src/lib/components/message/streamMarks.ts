/**
 * Stream marks (design contract §7.17-§7.18): which rendered rows open a new day, which row
 * carries the unread rule, and which rows continue the previous author's group.
 *
 * MessageList renders these inside its existing keyed `{#each}` — the marks never become rows
 * of their own and never touch message keys (AGENTS.md rule 3). The pass works on the rows that
 * are actually drawn: a row hidden by the chat filter (or not renderable at all) neither opens a
 * day nor anchors a group, so a hidden message can never swallow the next author's header.
 */

/** Same author within this window (and the same day) reads as one group. */
export const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;

export interface StreamRow {
	id?: string | null;
	user?: string | null;
	timestamp: number;
	replyTo?: string | null;
}

export interface DayLabel {
	/** Local calendar day, YYYY-MM-DD. */
	key: string;
	/** "Today" / "Yesterday" for the two most recent days, else null. */
	relative: string | null;
	/** Weekday and date in the reader's locale; the year only when it is not this year. */
	date: string;
	/** The full date for the separator's accessible name. */
	full: string;
}

export interface StreamMark {
	/** The row is drawn (not hidden by a filter, renderable). */
	rendered: boolean;
	/** Day rule drawn before this row, or null. */
	day: DayLabel | null;
	/** The unread rule is drawn before this row. */
	unread: boolean;
	groupedWithPrevious: boolean;
	groupedWithNext: boolean;
}

export interface StreamMarkOptions {
	/** False for rows the list will not draw. Defaults to every row. */
	isRendered?: (row: StreamRow, index: number) => boolean;
	/** The row the unread rule sits before (the list's existing firstUnreadMessageId). */
	firstUnreadId?: string | null;
	/** "Now" for Today / Yesterday. */
	now?: number;
	/** BCP 47 locale for the weekday and month names. */
	locale?: string | null;
	words?: { today: string; yesterday: string };
	groupWindowMs?: number;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** Local calendar day of a timestamp as YYYY-MM-DD ('' for an unusable timestamp). */
export function localDayKey(timestamp: number): string {
	const date = new Date(Number(timestamp));
	if (!Number.isFinite(date.getTime())) return '';
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatter(locale: string | null | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	try {
		return new Intl.DateTimeFormat(locale || undefined, options);
	} catch {
		return new Intl.DateTimeFormat(undefined, options);
	}
}

/** The date in the locale's own order, with the comma that follows the weekday dropped
 *  ("Monday 21 September", not "Monday, 21 September"): the rule is a typeset line, not a list. */
function format(timestamp: number, locale: string | null | undefined, options: Intl.DateTimeFormatOptions): string {
	const parts = formatter(locale, options).formatToParts(new Date(timestamp));
	return parts
		.map((part, index) => {
			const nextToWeekday = parts[index - 1]?.type === 'weekday' || parts[index + 1]?.type === 'weekday';
			return part.type === 'literal' && nextToWeekday && /^,\s*$/.test(part.value) ? ' ' : part.value;
		})
		.join('')
		.trim();
}

/** The label of the day rule for a timestamp, relative to `now`. */
export function formatDayLabel(
	timestamp: number,
	now: number,
	locale?: string | null,
	words: { today: string; yesterday: string } = { today: 'Today', yesterday: 'Yesterday' }
): DayLabel {
	const key = localDayKey(timestamp);
	const today = new Date(now);
	const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
	const relative =
		key === localDayKey(now) ? words.today : key === localDayKey(yesterday.getTime()) ? words.yesterday : null;
	const sameYear = new Date(timestamp).getFullYear() === today.getFullYear();
	const date = format(timestamp, locale, {
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		...(sameYear ? {} : { year: 'numeric' })
	});
	const full = format(timestamp, locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
	return { key, relative, date, full };
}

function continues(previous: StreamRow, current: StreamRow, windowMs: number): boolean {
	if (!previous.user || current.user !== previous.user) return false;
	if (current.replyTo || previous.replyTo) return false;
	const delta = Number(current.timestamp) - Number(previous.timestamp);
	if (!(delta >= 0 && delta <= windowMs)) return false;
	return localDayKey(current.timestamp) === localDayKey(previous.timestamp);
}

/**
 * One mark per input row, in input order. The first drawn row always opens its day (the top of
 * the rendered window); grouping breaks at day boundaries, at the unread rule and at replies.
 */
export function computeStreamMarks(rows: readonly StreamRow[], options: StreamMarkOptions = {}): StreamMark[] {
	const isRendered = options.isRendered ?? (() => true);
	const now = options.now ?? Date.now();
	const windowMs = options.groupWindowMs ?? MESSAGE_GROUP_WINDOW_MS;
	const marks: StreamMark[] = [];
	let previousIndex = -1;
	let previousDay = '';
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		const rendered = Boolean(row) && isRendered(row, index);
		const mark: StreamMark = { rendered, day: null, unread: false, groupedWithPrevious: false, groupedWithNext: false };
		marks.push(mark);
		if (!rendered) continue;
		const dayKey = localDayKey(row.timestamp);
		if (dayKey && dayKey !== previousDay) {
			mark.day = formatDayLabel(row.timestamp, now, options.locale, options.words);
		}
		mark.unread = Boolean(options.firstUnreadId) && row.id === options.firstUnreadId;
		if (previousIndex >= 0 && !mark.day && !mark.unread && continues(rows[previousIndex], row, windowMs)) {
			mark.groupedWithPrevious = true;
			marks[previousIndex].groupedWithNext = true;
		}
		if (dayKey) previousDay = dayKey;
		previousIndex = index;
	}
	return marks;
}
