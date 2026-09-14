import { describe, expect, test } from 'bun:test';
import catalog from '../../static/openmoji/emojis.json';
import stickers from '../../static/stickers/manifest.json';
import {
	filterEmojiLibrary,
	getBuiltInStickerGroups,
	getCommunityGroups,
	getEssentialEmojiCount,
	isEssentialEmoji
} from './emoji-library';
import type { Emoji } from './socket-types';

const bundled = catalog as Emoji[];
const bundledStickers = stickers as Emoji[];
const custom: Emoji[] = [
	{ id: 'community-wave', name: 'wave', displayName: 'Wave', url: '/wave.png', category: 'Reactions', isCustom: true, source: 'custom' },
	{ id: 'community-hug', name: 'hug', displayName: 'Big hug', url: '/hug.png', category: 'Characters', isCustom: true, source: 'custom', type: 'sticker' }
];

describe('emoji library organization', () => {
	test('ships a substantial everyday emoji set without exposing the whole catalog by default', () => {
		const count = getEssentialEmojiCount(bundled);
		expect(count).toBeGreaterThanOrEqual(70);
		expect(count).toBeLessThan(140);

		const essentials = filterEmojiLibrary(bundled, { mode: 'emoji', collection: 'essentials' });
		expect(essentials).toHaveLength(count);
		expect(essentials.every(isEssentialEmoji)).toBe(true);
		expect(essentials.length).toBeLessThan(bundled.length / 20);
	});

	test('global search ignores the current collection so obscure emoji remain reachable', () => {
		const results = filterEmojiLibrary(bundled, {
			mode: 'emoji',
			collection: 'essentials',
			query: 'mahjong red dragon'
		});
		expect(results.some((emoji) => emoji.id === '1F004')).toBe(true);
	});

	test('recent and favorites preserve the user order', () => {
		const ids = ['1F44D', '1F602', '2764'];
		const recent = filterEmojiLibrary(bundled, { mode: 'emoji', collection: 'recent', recentIds: ids });
		expect(recent.map((emoji) => emoji.id)).toEqual(ids);
		const favorites = filterEmojiLibrary(bundled, { mode: 'emoji', collection: 'favorites', favoriteIds: [...ids].reverse() });
		expect(favorites.map((emoji) => emoji.id)).toEqual([...ids].reverse());
	});

	test('community folders come from server-provided categories', () => {
		expect(getCommunityGroups(custom, 'emoji')).toEqual([{ id: 'Reactions', label: 'Reactions' }]);
		expect(getCommunityGroups(custom, 'sticker')).toEqual([{ id: 'Characters', label: 'Characters' }]);
	});

	test('built-in sticker set is split into a few useful browsing groups', () => {
		const groups = getBuiltInStickerGroups(bundledStickers);
		expect(groups.map((group) => group.id)).toEqual(['feelings', 'reactions', 'social', 'celebration']);
		const reactions = filterEmojiLibrary(bundledStickers, { mode: 'sticker', collection: 'built-in', group: 'reactions' });
		expect(reactions.length).toBeGreaterThan(0);
		expect(reactions.some((emoji) => emoji.name.includes('thumbs-up'))).toBe(true);
	});
});
