import { describe, expect, test } from 'bun:test';
import catalog from '../../static/openmoji/emojis.json';
import { REACTION_EMOJI_PAGE_SIZE, filterReactionEmojis, getReactionEmojiLabel } from './reactionEmojiOptions';
import { getEmojiSearchTerms } from './emoji-store';
import type { Emoji } from './socket-types';

const bundled = catalog as Emoji[];
const custom: Emoji = { id: 'custom-heart', name: 'wabi_heart', displayName: 'Wabi heart', url: '/custom.png', category: 'custom', isCustom: true, source: 'custom' };
const sticker: Emoji = { ...custom, id: 'sticker-heart', type: 'sticker' };

describe('reaction emoji choices', () => {
	test('bundled labels are human-readable without renaming stored IDs or shortcodes', () => {
		expect(bundled).toHaveLength(4284);
		for (const emoji of bundled) {
			expect(emoji.displayName?.length).toBeGreaterThan(0);
			expect(emoji.artist?.length).toBeGreaterThan(0);
			expect(emoji.name).toBe(`openmoji_${emoji.id}`);
			expect(emoji.url).toBe(`/openmoji/png/${emoji.id}.png`);
		}
		expect(getReactionEmojiLabel(bundled.find((emoji) => emoji.id === '2764')!)).toBe('red heart');
	});

	test.each(['heart', 'happy', 'smile', 'thumbs up', 'THUMBS_UP', 'red heart'])('finds familiar names/aliases: %s', (query) => {
		expect(filterReactionEmojis(bundled, query, 'all').length).toBeGreaterThan(0);
	});

	test('combines search words regardless of case and word order', () => {
		expect(filterReactionEmojis(bundled, ' HEART red ', 'all').map((emoji) => emoji.id)).toContain('2764');
		expect(filterReactionEmojis(bundled, 'not-a-real-emoji-query', 'all')).toEqual([]);
	});

	test('excludes stickers and preserves the selected source', () => {
		const entries = [...bundled, custom, sticker];
		expect(filterReactionEmojis(entries, '', 'custom')).toEqual([custom]);
		expect(filterReactionEmojis(entries, '', 'bundled')).toEqual(bundled);
		expect(filterReactionEmojis(entries, '', 'all')).toHaveLength(bundled.length + 1);
	});

	test('caps the initial rendered set and retains original identifiers', () => {
		const results = filterReactionEmojis(bundled, '', 'all');
		expect(results.slice(0, REACTION_EMOJI_PAGE_SIZE)).toHaveLength(40);
		expect(results[0]).toBe(bundled[0]);
	});

	test('keeps custom display names and searches readable shortcodes', () => {
		expect(getReactionEmojiLabel(custom)).toBe('Wabi heart');
		expect(getReactionEmojiLabel({ ...custom, displayName: undefined })).toBe('wabi heart');
		expect(getEmojiSearchTerms(custom)).toContain('love');
		expect(filterReactionEmojis([custom], 'wabi heart', 'all')).toEqual([custom]);
	});
});
