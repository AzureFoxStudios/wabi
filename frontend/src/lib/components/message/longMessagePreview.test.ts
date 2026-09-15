import { describe, expect, test } from 'bun:test';
import {
	LONG_MESSAGE_PREVIEW_LENGTH,
	LONG_MESSAGE_READER_THRESHOLD,
	createLongMessageExcerpt,
	getLongMessageStats,
	shouldPromoteLongMessage
} from './longMessagePreview';

describe('long message Reader promotion', () => {
	test('keeps ordinary chat text inline through the 2,000 character threshold', () => {
		expect(shouldPromoteLongMessage('text', 'a'.repeat(LONG_MESSAGE_READER_THRESHOLD))).toBe(false);
	});

	test('promotes text above the threshold but leaves specialized message types alone', () => {
		const longText = 'a'.repeat(LONG_MESSAGE_READER_THRESHOLD + 1);
		expect(shouldPromoteLongMessage('text', longText)).toBe(true);
		expect(shouldPromoteLongMessage('file', longText)).toBe(false);
		expect(shouldPromoteLongMessage('gif', longText)).toBe(false);
		expect(shouldPromoteLongMessage('emoji', longText)).toBe(false);
		expect(shouldPromoteLongMessage('role_gate', longText)).toBe(false);
	});

	test('counts Unicode characters rather than UTF-16 code units', () => {
		const emoji = '🦊'.repeat(LONG_MESSAGE_READER_THRESHOLD);
		expect(emoji.length).toBe(LONG_MESSAGE_READER_THRESHOLD * 2);
		expect(shouldPromoteLongMessage('text', emoji)).toBe(false);
		expect(shouldPromoteLongMessage('text', `${emoji}🦊`)).toBe(true);
	});

	test('builds a bounded, human-readable excerpt', () => {
		const source = `${'word '.repeat(180)}tail`;
		const excerpt = createLongMessageExcerpt(source);
		expect(Array.from(excerpt).length).toBeLessThanOrEqual(LONG_MESSAGE_PREVIEW_LENGTH + 1);
		expect(excerpt.endsWith('…')).toBe(true);
	});

	test('reports useful Reader metadata', () => {
		const stats = getLongMessageStats('one two three four');
		expect(stats.characterCount).toBe(18);
		expect(stats.wordCount).toBe(4);
		expect(stats.readMinutes).toBe(1);
	});
});
