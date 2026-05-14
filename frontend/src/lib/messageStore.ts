/**
 * messageStore.ts
 * Core message state and operations
 *
 * Extracted from socket-manager.ts for modularity.
 * Manages:
 * - Channel message lists
 * - Unread message tracking
 * - Message CRUD operations (edit, delete, pin)
 * - Optimistic message updates
 */

import { writable, get } from 'svelte/store';
import type { Message } from './socket-types';
import { getSocket } from './socketConnection';

// ============================================================================
// STORES
// ============================================================================

export const channelMessages = writable<Record<string, Message[]>>({ general: [] });
export const unreadCount = writable(0);
export const lastReadMessageId = writable<string | null>(null);
export const channelUnreadCounts = writable<Record<string, number>>({});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function createClientMessageId(channelId: string): string {
	return `optimistic:${channelId}:${Date.now()}:${Math.random().toString(36).substring(7)}`;
}

function computeOptimisticDeletionTime(channelId: string, timestamp: number): number | undefined {
	const OPTIMISTIC_DELETE_WINDOW_MS = 10 * 60 * 1000;
	const age = Date.now() - timestamp;
	return age < OPTIMISTIC_DELETE_WINDOW_MS ? Date.now() + (OPTIMISTIC_DELETE_WINDOW_MS - age) : undefined;
}

function appendOptimisticMessage(channelId: string, message: Message): void {
	channelMessages.update((msgs) => ({
		...msgs,
		[channelId]: [...(msgs[channelId] || []), message]
	}));
}

function removeOptimisticMessage(channelId: string, messageId: string): void {
	channelMessages.update((msgs) => ({
		...msgs,
		[channelId]: (msgs[channelId] || []).filter((m) => m.id !== messageId)
	}));
}

function updateOptimisticMessage(
	channelId: string,
	matcher: (message: Message) => boolean,
	patch: Partial<Message>
): void {
	channelMessages.update((msgs) => {
		const existing = msgs[channelId] || [];
		let changed = false;

		const nextMessages = existing.map((message) => {
			if (!matcher(message)) return message;
			changed = true;
			return {
				...message,
				...patch
			};
		});
		if (!changed) return msgs;
		return {
			...msgs,
			[channelId]: nextMessages
		};
	});
}

// ============================================================================
// PUBLIC API - Message Operations
// ============================================================================

export function markMessagesAsRead(): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('mark-messages-as-read');
}

export function markChannelAsRead(channelId: string): void {
	const sock = getSocket();
	if (!sock) return;

	const messages = get(channelMessages)[channelId] || [];
	if (messages.length > 0) {
		const lastMessage = messages[messages.length - 1];
		lastReadMessageId.set(lastMessage.id);
	}

	sock.emit('mark-channel-as-read', { channelId });
	channelUnreadCounts.update((counts) => ({ ...counts, [channelId]: 0 }));
	unreadCount.update((count) => Math.max(0, count - (get(channelUnreadCounts)[channelId] || 0)));
}

export function retryMessagePersistence(channelId: string, messageId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('retry-message', { channelId, messageId });
}

export function editMessage(channelId: string, messageId: string, newText: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('edit-message', { channelId, messageId, newText });
}

export function deleteMessage(channelId: string, messageId: string): void {
	const sock = getSocket();
	if (!sock) return;

	const messages = get(channelMessages)[channelId] || [];
	const message = messages.find((m) => m.id === messageId);

	if (message) {
		const deletionTime = computeOptimisticDeletionTime(channelId, message.timestamp);
		updateOptimisticMessage(
			channelId,
			(m) => m.id === messageId,
			{ isDeleted: true, deletionExpireTime: deletionTime }
		);
	}

	sock.emit('delete-message', { channelId, messageId });
}

export function togglePinMessage(channelId: string, messageId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('toggle-pin-message', { channelId, messageId });
}

// ============================================================================
// INTERNAL EXPORTS FOR SOCKET-MANAGER
// ============================================================================

export function _incrementUnreadCount(channelId: string, messageId: string): void {
	channelUnreadCounts.update((counts) => ({
		...counts,
		[channelId]: (counts[channelId] || 0) + 1
	}));
	unreadCount.update((count) => count + 1);
	lastReadMessageId.set(messageId);
}

export function _appendOptimisticMessage(channelId: string, message: Message): void {
	appendOptimisticMessage(channelId, message);
}

export function _removeOptimisticMessage(channelId: string, messageId: string): void {
	removeOptimisticMessage(channelId, messageId);
}

export function _updateOptimisticMessage(
	channelId: string,
	matcher: (message: Message) => boolean,
	patch: Partial<Message>
): void {
	updateOptimisticMessage(channelId, matcher, patch);
}
