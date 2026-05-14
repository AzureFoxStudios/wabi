/**
 * messageReactions.ts
 * Reaction management for messages
 *
 * Extracted from messageStore.ts for single responsibility.
 * Manages:
 * - Adding/removing emoji reactions to messages
 */

import { getSocket } from './socketConnection';

export function addReaction(channelId: string, messageId: string, emojiId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('add-reaction', { channelId, messageId, emojiId });
}

export function removeReaction(channelId: string, messageId: string, emojiId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('remove-reaction', { channelId, messageId, emojiId });
}
