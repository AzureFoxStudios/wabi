import { getEmojiSearchTerms } from './emoji-store';
import type { Emoji } from './socket-types';

export type ReactionEmojiSource = 'all' | 'bundled' | 'custom';
export const REACTION_EMOJI_PAGE_SIZE = 40;

export function getReactionEmojiLabel(emoji: Emoji): string {
	return emoji.displayName?.trim() || emoji.name.replace(/_/g, ' ');
}

export function filterReactionEmojis(catalog: Emoji[], query: string, source: ReactionEmojiSource): Emoji[] {
	const words = query.trim().toLowerCase().replace(/[_-]+/g, ' ').split(/\s+/).filter(Boolean);
	return catalog.filter((emoji) => {
		// Stickers are message content, not quick-reaction choices.
		if (emoji.type === 'sticker') return false;
		const custom = emoji.isCustom || emoji.source === 'custom';
		if (source === 'custom' && !custom || source === 'bundled' && custom) return false;
		const terms = getEmojiSearchTerms(emoji).join(' ');
		return words.every((word) => terms.includes(word));
	});
}
