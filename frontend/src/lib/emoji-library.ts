import { getEmojiSearchTerms } from './emoji-store';
import type { Emoji } from './socket-types';

export type EmojiLibraryCollection =
	| 'essentials'
	| 'recent'
	| 'favorites'
	| 'community'
	| 'library'
	| 'built-in'
	| 'all';

export type EssentialEmojiGroup = 'faces' | 'gestures' | 'hearts' | 'hype';
export type StickerGroup = 'feelings' | 'reactions' | 'social' | 'celebration';

export interface EmojiLibraryFilter {
	mode: 'emoji' | 'sticker';
	collection: EmojiLibraryCollection;
	query?: string;
	recentIds?: string[];
	favoriteIds?: string[];
	group?: string;
}

export interface EmojiLibraryGroupOption {
	id: string;
	label: string;
}

export const ESSENTIAL_EMOJI_GROUPS: Array<{
	id: EssentialEmojiGroup;
	label: string;
	ids: readonly string[];
}> = [
	{
		id: 'faces',
		label: 'Faces',
		ids: [
			'1F600', '1F603', '1F604', '1F601', '1F606', '1F605', '1F602', '1F923',
			'1F60A', '1F642', '1F609', '1F60D', '1F970', '1F618', '1F61C', '1F92A',
			'1F914', '1F928', '1F644', '1F610', '1F611', '1F62C', '1F614', '1F622',
			'1F62D', '1F620', '1F621', '1F92C', '1F631', '1F92F', '1F60E', '1F973',
			'1F480'
		]
	},
	{
		id: 'gestures',
		label: 'Gestures',
		ids: [
			'1F44D', '1F44E', '1F44F', '1F64C', '1F64F', '1F91D', '1F4AA', '1F44B',
			'270C', '1F91E', '1FAF6', '1F448', '1F449', '1F446', '1F447', '1F918',
			'1F919', '1F90C', '1F91F', '1F44C'
		]
	},
	{
		id: 'hearts',
		label: 'Hearts & social',
		ids: [
			'2764', '1FA77', '1F9E1', '1F49B', '1F49A', '1F499', '1F49C', '1F90E',
			'1F5A4', '1F90D', '1F495', '1F496', '1F497', '1F493', '1F494', '1F49E',
			'1F48C', '1F48B'
		]
	},
	{
		id: 'hype',
		label: 'Hype & useful',
		ids: [
			'1F525', '2728', '2B50', '1F4AF', '1F389', '1F38A', '1F381', '1F388',
			'1F382', '1F680', '1F4A1', '1F440', '1F4AC', '1F4A4', '2705', '274C',
			'26A0', '2757', '2753', '1F6A8', '1F514', '1F3AF', '1F3C6', '1F3B5'
		]
	}
];

const ESSENTIAL_IDS = ESSENTIAL_EMOJI_GROUPS.flatMap((group) => group.ids);
const ESSENTIAL_RANK = new Map(ESSENTIAL_IDS.map((id, index) => [id, index]));
const ESSENTIAL_GROUP_BY_ID = new Map(
	ESSENTIAL_EMOJI_GROUPS.flatMap((group) => group.ids.map((id) => [id, group.id] as const))
);

const STICKER_GROUPS: EmojiLibraryGroupOption[] = [
	{ id: 'feelings', label: 'Feelings' },
	{ id: 'reactions', label: 'Reactions' },
	{ id: 'social', label: 'Hearts & social' },
	{ id: 'celebration', label: 'Celebration' }
];

const STICKER_GROUP_RANK = new Map(STICKER_GROUPS.map((group, index) => [group.id, index]));

function labelFor(emoji: Emoji): string {
	return (emoji.displayName?.trim() || emoji.name.replace(/[_-]+/g, ' ')).toLowerCase();
}

function emojiIdIndex(ids: string[], id: string): number {
	const index = ids.indexOf(id);
	return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function wordsFromQuery(query: string): string[] {
	return query
		.trim()
		.toLowerCase()
		.replace(/[_-]+/g, ' ')
		.split(/\s+/)
		.filter(Boolean);
}

function matchesQuery(emoji: Emoji, query: string): boolean {
	const words = wordsFromQuery(query);
	if (words.length === 0) return true;
	const haystack = [
		...getEmojiSearchTerms(emoji),
		emoji.artist?.toLowerCase() || ''
	].join(' ');
	return words.every((word) => haystack.includes(word));
}

function searchRank(emoji: Emoji, query: string): number {
	const normalized = query.trim().toLowerCase().replace(/[_-]+/g, ' ');
	if (!normalized) return 0;
	const label = labelFor(emoji);
	if (label === normalized) return 0;
	if (label.startsWith(normalized)) return 1;
	if (getEmojiSearchTerms(emoji).some((term) => term === normalized)) return 2;
	if (isEssentialEmoji(emoji)) return 3;
	if (emoji.isCustom || emoji.source === 'custom') return 4;
	return 5;
}

export function isEssentialEmoji(emoji: Emoji): boolean {
	return !emoji.isCustom && (emoji.type || 'emoji') === 'emoji' && ESSENTIAL_RANK.has(emoji.id);
}

export function getEssentialEmojiGroup(emoji: Emoji): EssentialEmojiGroup | null {
	return ESSENTIAL_GROUP_BY_ID.get(emoji.id) ?? null;
}

export function getStickerGroup(emoji: Emoji): StickerGroup {
	const value = `${emoji.name} ${emoji.displayName || ''}`.toLowerCase();
	if (/heart|hug|kiss|handshake|pray/.test(value)) return 'social';
	if (/party|balloon|fire|hundred|muscle|clap|gift|celebrat/.test(value)) return 'celebration';
	if (/thumb|eyes|skull|poop|no-evil|hear no evil|see no evil|speak no evil/.test(value)) return 'reactions';
	return 'feelings';
}

export function getBuiltInStickerGroups(catalog: Emoji[]): EmojiLibraryGroupOption[] {
	const available = new Set(
		catalog
			.filter((emoji) => (emoji.type || 'emoji') === 'sticker' && !emoji.isCustom)
			.map(getStickerGroup)
	);
	return STICKER_GROUPS.filter((group) => available.has(group.id as StickerGroup));
}

export function getCommunityGroups(catalog: Emoji[], mode: 'emoji' | 'sticker'): EmojiLibraryGroupOption[] {
	const values = new Set(
		catalog
			.filter((emoji) => (emoji.type || 'emoji') === mode && (emoji.isCustom || emoji.source === 'custom'))
			.map((emoji) => emoji.category?.trim() || 'custom')
	);
	return [...values]
		.sort((a, b) => a.localeCompare(b))
		.map((value) => ({ id: value, label: value.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase()) }));
}

export function getEssentialEmojiCount(catalog: Emoji[]): number {
	return catalog.filter(isEssentialEmoji).length;
}

export function sortEmojiLibrary(catalog: Emoji[], query = ''): Emoji[] {
	return [...catalog].sort((a, b) => {
		if (query.trim()) {
			const searchDelta = searchRank(a, query) - searchRank(b, query);
			if (searchDelta !== 0) return searchDelta;
		}

		const aEssential = ESSENTIAL_RANK.get(a.id);
		const bEssential = ESSENTIAL_RANK.get(b.id);
		if (aEssential !== undefined || bEssential !== undefined) {
			if (aEssential === undefined) return 1;
			if (bEssential === undefined) return -1;
			return aEssential - bEssential;
		}

		if ((a.type || 'emoji') === 'sticker' && (b.type || 'emoji') === 'sticker') {
			const groupDelta = (STICKER_GROUP_RANK.get(getStickerGroup(a)) ?? 99) - (STICKER_GROUP_RANK.get(getStickerGroup(b)) ?? 99);
			if (groupDelta !== 0) return groupDelta;
		}

		return labelFor(a).localeCompare(labelFor(b));
	});
}

export function filterEmojiLibrary(catalog: Emoji[], filter: EmojiLibraryFilter): Emoji[] {
	const recentIds = filter.recentIds || [];
	const favoriteIds = filter.favoriteIds || [];
	const modeEntries = catalog.filter((emoji) => (emoji.type || 'emoji') === filter.mode);
	const query = filter.query?.trim() || '';

	if (query) {
		return sortEmojiLibrary(modeEntries.filter((emoji) => matchesQuery(emoji, query)), query);
	}

	let entries: Emoji[];
	switch (filter.collection) {
		case 'essentials':
			entries = modeEntries.filter(isEssentialEmoji);
			break;
		case 'recent':
			entries = modeEntries
				.filter((emoji) => recentIds.includes(emoji.id))
				.sort((a, b) => emojiIdIndex(recentIds, a.id) - emojiIdIndex(recentIds, b.id));
			break;
		case 'favorites':
			entries = modeEntries
				.filter((emoji) => favoriteIds.includes(emoji.id))
				.sort((a, b) => emojiIdIndex(favoriteIds, a.id) - emojiIdIndex(favoriteIds, b.id));
			break;
		case 'community':
			entries = modeEntries.filter((emoji) => emoji.isCustom || emoji.source === 'custom');
			break;
		case 'built-in':
			entries = modeEntries.filter((emoji) => !emoji.isCustom && emoji.source !== 'custom');
			break;
		case 'library':
			entries = modeEntries.filter((emoji) => !emoji.isCustom && emoji.source !== 'custom');
			break;
		case 'all':
		default:
			entries = modeEntries;
			break;
	}

	if (filter.group) {
		if (filter.collection === 'essentials') {
			entries = entries.filter((emoji) => getEssentialEmojiGroup(emoji) === filter.group);
		} else if (filter.collection === 'built-in' && filter.mode === 'sticker') {
			entries = entries.filter((emoji) => getStickerGroup(emoji) === filter.group);
		} else if (filter.collection === 'community') {
			entries = entries.filter((emoji) => (emoji.category?.trim() || 'custom') === filter.group);
		}
	}

	if (filter.collection === 'recent' || filter.collection === 'favorites') return entries;
	return sortEmojiLibrary(entries);
}
