import { describe, expect, test } from 'bun:test';
import { NOTE_COLOR_NAMES, noteColorIndex, noteListDate, noteSaveWord } from './notesView';
import { NOTE_COLORS } from '../notesStore';

// Contract: design spec §8.7 Notes, §9.3 ("Saved 09:41"; locality said once per screen), §5.5
// (a note's color only as a dot from the preset list), critique forum-wiki#16.

describe('notes view words', () => {
	const now = new Date(2026, 8, 21, 15, 30).getTime();

	test('list dates: the time today, Yesterday, day and month this year, the full date before', () => {
		expect(noteListDate(new Date(2026, 8, 21, 9, 41).getTime(), now, 'en-GB')).toBe('09:41');
		expect(noteListDate(new Date(2026, 8, 20, 23, 0).getTime(), now, 'en-GB')).toBe('Yesterday');
		expect(noteListDate(new Date(2026, 2, 4).getTime(), now, 'en-GB')).toBe('4 Mar');
		expect(noteListDate(new Date(2025, 11, 31).getTime(), now, 'en-GB')).toBe('31 Dec 2025');
	});

	test('the save word says the state only, and starts with "Saved" once it is stored', () => {
		const at = new Date(2026, 8, 21, 9, 41).getTime();
		expect(noteSaveWord('saved', at, 'en-GB')).toBe('Saved 09:41');
		expect(noteSaveWord('saving', at)).toBe('Saving…');
		expect(noteSaveWord('unsaved', at)).toBe('Unsaved changes');
		expect(noteSaveWord('failed', at)).toBe('Could not save');
		expect(noteSaveWord('conflict', at)).toBe('Conflicting changes');
		for (const status of ['saving', 'unsaved', 'failed', 'conflict'] as const) {
			expect(noteSaveWord(status, at).startsWith('Saved')).toBe(false);
		}
		// Locality is row A's job ("Only you · this device"), never repeated in the status.
		expect(noteSaveWord('saved', at)).not.toContain('device');
	});

	test('a color dot only comes from the preset list', () => {
		expect(NOTE_COLOR_NAMES.length).toBe(NOTE_COLORS.length);
		expect(noteColorIndex(NOTE_COLORS[2], NOTE_COLORS)).toBe(2);
		expect(noteColorIndex('', NOTE_COLORS)).toBe(-1);
		expect(noteColorIndex(undefined, NOTE_COLORS)).toBe(-1);
		expect(noteColorIndex('red; background-image: url(https://example.com/x)', NOTE_COLORS)).toBe(-1);
	});
});
