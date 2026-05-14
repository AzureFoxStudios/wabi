/**
 * typingStore.ts
 * Typing indicator state and events
 *
 * Extracted from socket-manager.ts for modularity.
 * Manages:
 * - Typing user tracking per channel
 * - Typing event emission
 */

import { writable, get } from 'svelte/store';
import type { Socket } from 'socket.io-client';
import { getSocket } from './socketConnection';

// ============================================================================
// STORES
// ============================================================================

export const typingUsers = writable<Record<string, string[]>>({});

// ============================================================================
// PUBLIC API
// ============================================================================

export function sendTyping(isTyping: boolean, channelId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('typing', { channelId, isTyping });
}

// ============================================================================
// INTERNAL EXPORTS FOR SOCKET-MANAGER
// ============================================================================

export function _setTypingUsers(channelId: string, userIds: string[]): void {
	typingUsers.update((typing) => ({
		...typing,
		[channelId]: userIds
	}));
}

export function _addTypingUser(channelId: string, userId: string): void {
	typingUsers.update((typing) => {
		const current = typing[channelId] || [];
		if (current.includes(userId)) return typing;
		return {
			...typing,
			[channelId]: [...current, userId]
		};
	});
}

export function _removeTypingUser(channelId: string, userId: string): void {
	typingUsers.update((typing) => {
		const current = typing[channelId] || [];
		const filtered = current.filter((id) => id !== userId);
		if (filtered.length === 0) {
			const { [channelId]: _, ...rest } = typing;
			return rest;
		}
		return {
			...typing,
			[channelId]: filtered
		};
	});
}

export function _clearTypingUsers(channelId: string): void {
	typingUsers.update((typing) => {
		const { [channelId]: _, ...rest } = typing;
		return rest;
	});
}
