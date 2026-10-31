/**
 * Words and marks for the notebook view (design contract §8.7 Notes, §9.3 locality, §5.5 colors).
 * Pure helpers, tested without a browser.
 */
import type { NoteDraft } from './editor';

type Status = NoteDraft['status'];

function sameDay(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Clock time in the reader's locale, 24-hour where the locale is (the reference shows 09:41). */
export function noteClock(ms: number, locale?: string): string {
	return new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

/**
 * The date a note list shows: the time for today, "Yesterday", the day and month this year, the
 * full date before that. Mono in the list; never "9/21/2026".
 */
export function noteListDate(ms: number, now = Date.now(), locale?: string): string {
	const date = new Date(ms);
	const today = new Date(now);
	if (sameDay(date, today)) return noteClock(ms, locale);
	const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
	if (sameDay(date, yesterday)) return 'Yesterday';
	if (date.getFullYear() === today.getFullYear()) return date.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
	return date.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The save word (§9.3 "Saved 09:41"). Locality is said once per screen by row A's or the
 * companion's "Only you · this device", so the word itself carries only the state. It always
 * starts with "Saved" once the note is safely stored, which the companion reads.
 */
export function noteSaveWord(status: Status, savedAt: number, locale?: string): string {
	switch (status) {
		case 'saved':
			return `Saved ${noteClock(savedAt, locale)}`;
		case 'saving':
			return 'Saving…';
		case 'conflict':
			return 'Conflicting changes';
		case 'failed':
			return 'Could not save';
		default:
			return 'Unsaved changes';
	}
}

/** The color names the note color menu shows, in NOTE_COLORS order. */
export const NOTE_COLOR_NAMES: readonly string[] = Object.freeze(['Accent', 'Green', 'Amber', 'Red', 'Purple', 'Muted']);

/**
 * A note's color only ever comes from the preset list: anything else (an imported backup with
 * another value) draws no dot, so stored data never reaches a style unchecked.
 */
export function noteColorIndex(color: string | undefined | null, presets: readonly string[]): number {
	if (!color) return -1;
	return presets.indexOf(color);
}
