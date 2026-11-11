import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSharedNote, SharedNoteError, sharedNoteErrorText, type SharedNoteWire } from './sharedConversationNotes';

const wire = (content: string): SharedNoteWire => ({
	id: 'note-1', channelId: 'dm-1', authorUserId: 7, content, encrypted: false,
	createdAt: 1, updatedAt: 2, revision: 1,
});

// frontend/AGENTS.md rule 14: never show a raw Error.message.
describe('shared note errors shown to the reader', () => {
	test('a runtime error becomes the fallback words, never its own message', () => {
		expect(sharedNoteErrorText(new TypeError('Failed to fetch'), 'Could not load shared notes.')).toBe('Could not load shared notes.');
		expect(sharedNoteErrorText(new SyntaxError('JSON Parse error: Unexpected identifier'), 'fallback')).toBe('fallback');
		expect(sharedNoteErrorText('a string', 'fallback')).toBe('fallback');
	});

	test('an error written for the reader keeps its words', () => {
		expect(sharedNoteErrorText(new SharedNoteError('Give the shared note a title.'), 'fallback')).toBe('Give the shared note a title.');
	});

	test('a note whose saved content does not parse is locked with fixed words', async () => {
		const note = await openSharedNote('dm-1', wire('not json {'));
		expect(note.locked).toBe(true);
		expect(note.openError).toBe('This note cannot be opened on this device.');
	});

	test('a note with the wrong saved shape says so in its own words', async () => {
		const note = await openSharedNote('dm-1', wire(JSON.stringify({ title: 3 })));
		expect(note.locked).toBe(true);
		expect(note.openError).toBe('This note has an invalid saved format.');
	});

	test('a locked note is not titled "Encrypted": the word needs "experimental", and the note may not be encrypted', async () => {
		const note = await openSharedNote('dm-1', wire('not json {'));
		expect(note.title).not.toMatch(/encrypt/i);
	});

	test('the notes panel never prints a caught error message, and labels encryption as experimental', () => {
		const source = readFileSync(join(import.meta.dir, '../components/SharedConversationNotes.svelte'), 'utf8');
		expect(source.includes('failure.message')).toBe(false);
		expect(source.includes('sharedNoteErrorText(failure,')).toBe(true);
		// Member UI says "Experimental encryption", never a bare "Encrypted" (rule 12).
		expect(/'Encrypted\b/.test(source)).toBe(false);
	});
});
