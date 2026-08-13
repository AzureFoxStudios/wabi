import { writable, get } from 'svelte/store';
import type { Emoji } from './socket-types';

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

function toEmoji(server: ServerEmote): Emoji {
	const kind = server.type || 'emoji';
	return {
		id: server.emote_id,
		name: server.name,
		displayName: server.display_name || undefined,
		artist: server.artist || undefined,
		url: server.image_url,
		category: server.category || 'custom',
		isCustom: true,
		type: kind === 'sticker' ? 'sticker' : 'emoji',
		source: 'custom'
	};
}

const SEARCH_ALIASES: Record<string, string[]> = {
	joy: ['happy', 'laugh', 'smile'],
	smile: ['happy', 'friendly'],
	heart: ['love', 'like'],
	dizzy: ['star', 'sparkle', 'giddy'],
	sweat: ['nervous', 'awkward', 'anxious'],
	angry: ['mad', 'rage', 'annoyed'],
	sad: ['cry', 'unhappy', 'upset'],
	party: ['celebrate', 'celebration', 'fun'],
	thumbsup: ['approve', 'yes', 'good'],
	thumbsdown: ['no', 'bad', 'disapprove']
};

export function getEmojiSearchTerms(emoji: Emoji): string[] {
	const base = [emoji.name, emoji.displayName || '', emoji.category || ''];
	const aliases = base.flatMap((term) => SEARCH_ALIASES[term.toLowerCase()] || []);
	return [...new Set([...base, ...aliases].map((term) => term.trim().toLowerCase()).filter(Boolean))];
}

/**
 * Merge server emotes into the store, replacing any stale custom entries
 * for the same name (dedupe by emoji id). Bundled (non-custom) entries are
 * left untouched.
 */
export function mergeServerEmotes(serverEmotes: ServerEmote[]): void {
	const mapped = serverEmotes.map(toEmoji);
	const ids = new Set(mapped.map((e) => e.id));
	emojis.update((current) => {
		const kept = current.filter((e) => !e.isCustom || !ids.has(e.id));
		return [...kept, ...mapped];
	});
}

/** Remove a custom emote by name after server deletion. */
export function removeServerEmote(name: string): void {
	emojis.update((current) => current.filter((e) => e.name !== name || !e.isCustom));
}

/** Reset the custom emote portion of the store (used on explicit reload). */
export function clearServerEmotes(): void {
	emojis.update((current) => current.filter((e) => !e.isCustom));
}

export async function initEmojis(): Promise<void> {
	const bundled: Emoji[] = [];
	try {
		const res = await fetch('/openmoji/emojis.json');
		if (!res.ok) throw new Error(`Failed to load emoji manifest: ${res.status}`);
		const data: Emoji[] = await res.json();
		bundled.push(...data);
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
