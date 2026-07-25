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
import type { MessageType } from '../../../packages/wabi-protocol/src/generated/MessageType';
import { getSocket, connected } from './socketConnection';
import { getWabiDB } from '$lib/wabidb';
import { currentUser } from './presenceStore';

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

export async function sendMessage(
	channelId: string,
	content: string,
	type: MessageType = 'text',
	options: Record<string, unknown> = {}
): Promise<void> {
	const sock = getSocket();
	if (!sock) return;

	const trimmed = content.trim();
	if (!trimmed && type === 'text') return;

	const clientMessageId = createClientMessageId(channelId);
	const me = get(currentUser);
	const optimisticMessage: Message = {
		id: clientMessageId,
		clientMessageId,
		user: me?.username || 'You',
		userId: me?.id || sock.id || 'local',
		senderStableId: me?.id || sock.id || 'local',
		color: me?.color || '#98D8C8',
		text: trimmed,
		timestamp: Date.now(),
		type,
		deliveryState: 'sending',
		...(options as Partial<Message>)
	};

	appendOptimisticMessage(channelId, optimisticMessage);

	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({
			scopeId: 'corechat',
			type: 'send-message',
			payload: { channelId, text: trimmed, type, clientMessageId, ...options }
		});
		updateOptimisticMessage(
			channelId,
			(m) => m.clientMessageId === clientMessageId,
			{ deliveryState: 'failed', deliveryError: 'Queued — will send when online' }
		);
		return;
	}

	sock.emit('message', {
		channelId,
		text: trimmed,
		type,
		clientMessageId,
		...options
	});
}

export async function editMessage(channelId: string, messageId: string, newText: string): Promise<void> {
	const sock = getSocket();
	if (!sock) return;
	// Optimistic UI — server will confirm via message-edited or edit-error
	updateOptimisticMessage(
		channelId,
		(m) => m.id === messageId,
		{ text: newText, isEdited: true }
	);
	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({
			scopeId: 'corechat',
			type: 'edit-message',
			payload: { channelId, messageId, newText }
		});
		updateOptimisticMessage(
			channelId,
			(m) => m.id === messageId,
			{ deliveryState: 'failed', deliveryError: 'Queued — will send when online' }
		);
		return;
	}
	sock.emit('edit-message', { channelId, messageId, newText });
}

export async function deleteMessage(channelId: string, messageId: string): Promise<void> {
	const sock = getSocket();
	if (!sock) return;

	// Remove immediately from the open channel view (Discord-style hard delete in UI).
	// Server confirms via message-deleted; edit/delete-error can restore if needed.
	removeOptimisticMessage(channelId, messageId);
	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({
			scopeId: 'corechat',
			type: 'delete-message',
			payload: { channelId, messageId }
		});
		return;
	}
	sock.emit('delete-message', { channelId, messageId });
}

export async function togglePinMessage(channelId: string, messageId: string): Promise<void> {
	const sock = getSocket();
	if (!sock) return;
	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({
			scopeId: 'corechat',
			type: 'toggle-pin-message',
			payload: { channelId, messageId }
		});
		return;
	}
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
