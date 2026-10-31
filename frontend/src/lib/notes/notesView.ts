/**
 * Words and marks for the notebook view (design contract §8.7 Notes, §9.3 locality, §5.5 colors).
 * Pure helpers, tested without a browser.
 */
import type { NoteDraft } from './editor';
import { NotebookError } from './types';

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
 * starts with "Saved" once the note is safely stored, which the companion reads. The time is
 * only a clock for a save made today; an older save says its day ("Saved yesterday",
 * "Saved 4 Mar"), so opening an old note never reads as saved this morning.
 */
export function noteSaveWord(status: Status, savedAt: number, locale?: string, now = Date.now()): string {
	switch (status) {
		case 'saved': {
			const when = noteListDate(savedAt, now, locale);
			return `Saved ${when === 'Yesterday' ? 'yesterday' : when}`;
		}
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

/**
 * The color names the note color menu shows, in NOTE_COLORS order. Color words people use, not
 * theme roles: the first preset follows the theme's own color, the last is the theme's gray.
 */
export const NOTE_COLOR_NAMES: readonly string[] = Object.freeze(['Theme color', 'Green', 'Amber', 'Red', 'Purple', 'Gray']);

/**
 * A note's color only ever comes from the preset list: anything else (an imported backup with
 * another value) draws no dot, so stored data never reaches a style unchecked.
 */
export function noteColorIndex(color: string | undefined | null, presets: readonly string[]): number {
	if (!color) return -1;
	return presets.indexOf(color);
}

/**
 * The words a notice shows for a failure (§7.16: a raw Error.message is never shown). The
 * notebook's own errors (NotebookError) are written for people and say what is unchanged, so
 * they are shown as they are; anything else (storage, the browser, a bug) shows `fallback`, a
 * plain cause plus what is unchanged, and the failure itself is only logged.
 */
export function noteProblem(failure: unknown, fallback: string): string {
	return failure instanceof NotebookError && failure.message.trim() ? failure.message : fallback;
}
