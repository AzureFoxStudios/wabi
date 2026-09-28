import { writable, get } from 'svelte/store';
import type { Emoji } from './socket-types';
import { resolveServerAssetUrl } from './serverAssetUrl';

export const emojis = writable<Emoji[]>([]);

/** Server-side custom emote record (matches Rust `Emote` domain struct). */
export interface ServerEmote {
	emote_id: string;
	name: string;
	image_url: string;
	created_at_micros: number;
	created_by_user_id: number;
	display_name?: string;
	artist?: string;
	category?: string;
	type?: string;
}

function toEmoji(server: ServerEmote, authorityUrl?: string): Emoji {
	const kind = server.type || 'emoji';
	return {
		id: server.emote_id,
		name: server.name,
		displayName: server.display_name || undefined,
		artist: server.artist || undefined,
		url: authorityUrl ? resolveServerAssetUrl(authorityUrl, server.image_url) || server.image_url : server.image_url,
		category: server.category || 'custom',
		isCustom: true,
		type: kind === 'sticker' ? 'sticker' : 'emoji',
		source: 'custom'
	};
}

const SEARCH_ALIASES: Record<string, string[]> = {
	joy: ['happy', 'laugh', 'smile', 'funny'],
	smile: ['happy', 'friendly'],
	heart: ['love', 'like', 'romance'],
	love: ['heart', 'romance', 'affection'],
	dizzy: ['star', 'sparkle', 'giddy'],
	sweat: ['nervous', 'awkward', 'anxious'],
	angry: ['mad', 'rage', 'annoyed'],
	sad: ['cry', 'unhappy', 'upset'],
	party: ['celebrate', 'celebration', 'fun', 'hype'],
	fire: ['hot', 'lit', 'hype'],
	eyes: ['look', 'watch', 'see'],
	skull: ['dead', 'dying', 'lol'],
	clap: ['applause', 'congrats', 'congratulations'],
	thinking: ['think', 'hmm', 'confused', 'question'],
	pray: ['please', 'thanks', 'thank you', 'hope'],
	hug: ['comfort', 'support', 'love'],
	kiss: ['love', 'romance'],
	hundred: ['agree', 'perfect', '100'],
	thumbsup: ['approve', 'yes', 'good', 'like'],
	thumbsdown: ['no', 'bad', 'disapprove', 'dislike'],
	'thumbs up': ['thumbsup', 'approve', 'yes', 'good', 'like'],
	'thumbs down': ['thumbsdown', 'no', 'bad', 'disapprove', 'dislike'],
	smiling: ['smile', 'happy', 'friendly'],
	grinning: ['grin', 'smile', 'happy'],
	laughing: ['laugh', 'happy', 'funny'],
	hearts: ['heart', 'love', 'like', 'romance'],
	crying: ['cry', 'sad', 'unhappy'],
	'check mark': ['yes', 'done', 'correct', 'approve'],
	'cross mark': ['no', 'wrong', 'reject'],
	warning: ['alert', 'caution'],
	'question mark': ['question', 'help', 'confused']
};

export function getEmojiSearchTerms(emoji: Emoji): string[] {
	const base = [emoji.name, emoji.displayName || '', emoji.category || ''];
	const normalized = base.map((term) => term.toLowerCase().replace(/[_-]+/g, ' '));
	const aliases = normalized.flatMap((term) => [term, ...term.split(/\s+/)])
		.flatMap((term) => SEARCH_ALIASES[term] || []);
	return [...new Set([...base, ...normalized, ...aliases].map((term) => term.trim().toLowerCase()).filter(Boolean))];
}

/**
 * A few canonical reactions are front-loaded in the shared store. The full
 * OpenMoji catalog still follows untouched; this only prevents legacy callers
 * that sample the first few hundred entries from surfacing keycaps/flags as
 * their default reaction choices.
 */
const CATALOG_FRONT_IDS = ['1F44D', '2764', '1F602', '1F525'];

function frontloadEverydayEmoji(entries: Emoji[]): Emoji[] {
	const rank = new Map(CATALOG_FRONT_IDS.map((id, index) => [id, index]));
	return [...entries].sort((a, b) => {
		const aRank = rank.get(a.id);
		const bRank = rank.get(b.id);
		if (aRank === undefined && bRank === undefined) return 0;
		if (aRank === undefined) return 1;
		if (bRank === undefined) return -1;
		return aRank - bRank;
	});
}

/**
 * Apply the complete server emote snapshot. Entries omitted from a refreshed
 * list were deleted or belong to a previously connected server. Bundled
 * entries are left untouched.
 */
export function mergeServerEmotes(serverEmotes: ServerEmote[], authorityUrl?: string): void {
	const mapped = serverEmotes.map((emote) => toEmoji(emote, authorityUrl));
	emojis.update((current) => {
		const kept = current.filter((e) => !e.isCustom && e.source !== 'custom');
		return [...kept, ...mapped];
	});
}

/** Remove a custom emote by name after server deletion. */
export function removeServerEmote(name: string): void {
	emojis.update((current) => current.filter((e) => e.name !== name || (!e.isCustom && e.source !== 'custom')));
}

/** Reset the custom emote portion of the store (used on explicit reload). */
export function clearServerEmotes(): void {
	emojis.update((current) => current.filter((e) => !e.isCustom && e.source !== 'custom'));
}

export async function initEmojis(): Promise<void> {
	const bundled: Emoji[] = [];
	try {
		const res = await fetch('/openmoji/emojis.json');
		if (!res.ok) throw new Error(`Failed to load emoji manifest: ${res.status}`);
		const data: Emoji[] = await res.json();
		bundled.push(...frontloadEverydayEmoji(data));
	} catch (err) {
		console.warn('[emoji] Failed to load OpenMoji emojis:', err);
	}

	try {
		const res = await fetch('/stickers/manifest.json');
		if (res.ok) {
			const data: Emoji[] = await res.json();
			bundled.push(...data);
		}
	} catch (err) {
		console.warn('[emoji] Failed to load sticker manifest:', err);
	}

	// Keep any custom emotes already merged from the server.
	const existing = get(emojis);
	const custom = existing.filter((e) => e.isCustom);
	emojis.set([...bundled, ...custom]);
}
