/**
 * messageReactions.ts
 * Reaction management for messages
 *
 * Extracted from messageStore.ts for single responsibility.
 * Manages:
 * - Adding/removing emoji reactions to messages
 */

import { get } from 'svelte/store';
import { getSocket, connected } from './socketConnection';
import { getWabiDB } from '$lib/wabidb';

export async function addReaction(channelId: string, messageId: string, emojiId: string): Promise<void> {
	const sock = getSocket();
	if (!sock) return;
	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({ scopeId: 'corechat', type: 'add-reaction', payload: { channelId, messageId, emojiId } });
		return;
	}
	sock.emit('add-emoji-reaction', { channelId, messageId, emojiId });
}

export async function removeReaction(channelId: string, messageId: string, emojiId: string): Promise<void> {
	const sock = getSocket();
	if (!sock) return;
	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({ scopeId: 'corechat', type: 'remove-reaction', payload: { channelId, messageId, emojiId } });
		return;
	}
	sock.emit('remove-emoji-reaction', { channelId, messageId, emojiId });
}
