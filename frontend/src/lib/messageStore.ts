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

import { writable, get, type Writable } from 'svelte/store';
import type { Message } from './socket-types';
import type { MessageType } from '../../../packages/wabi-protocol/src/generated/MessageType';
import { getSocket, connected } from './socketConnection';
import { getWabiDB } from '$lib/wabidb';
import { currentUser } from './presenceStore';

// ============================================================================
// STORES
// ============================================================================

// God-store fix (perf audit finding #2): `channelMessages` remains ONE map so
// all existing `$channelMessages[id]` subscribers keep working unchanged.
// Scoped invalidation is provided by `channelMessagesStore(id)` below: a
// per-channel writable that re-emits ONLY when that channel's array reference
// changes. Our mutators guarantee untouched channels keep their previous
// array reference, so a component subscribed to channel A never re-runs its
// reactive blocks when channel B receives a message. High-traffic message
// lists are migrated to the scoped store; low-frequency readers stay on the
// compat map.
export const channelMessages = writable<Record<string, Message[]>>({ general: [] });
export const unreadCount = writable(0);
export const lastReadMessageId = writable<string | null>(null);
export const channelUnreadCounts = writable<Record<string, number>>({});

const channelSliceStores = new Map<string, Writable<Message[]>>();

/**
 * Per-channel view of `channelMessages`. Emits only when THIS channel's
 * array identity changes (which is exactly what our mutators preserve).
 * Subscribe once per (component, channelId); safe to call every derive pass.
 */
export function channelMessagesStore(channelId: string): Writable<Message[]> {
	if (!channelId) return writable([]);
	let store = channelSliceStores.get(channelId);
	if (!store) {
		store = writable<Message[]>(get(channelMessages)[channelId] || []);
		channelSliceStores.set(channelId, store);
		let prev: Message[] = get(store);
		const unsub = channelMessages.subscribe((map) => {
			const next = map[channelId];
			// Reference guard: skip emission when this channel didn't change.
			// (`next` may be undefined after channel deletion -> emit empty.)
			if ((next || []) !== prev && !(next === undefined && prev.length === 0)) {
				prev = next || [];
				store!.set(prev);
			}
		});
		void unsub;
	}
	return store;
}

/** Drop a channel's scoped store (call when the channel is deleted/left). */
export function dropChannelMessagesStore(channelId: string): void {
	channelSliceStores.delete(channelId);
}

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
	// Read the prior count BEFORE zeroing — decrementing after the reset
	// always subtracts 0, letting the global unread badge drift upward.
	const prior = get(channelUnreadCounts)[channelId] || 0;
	channelUnreadCounts.update((counts) => ({ ...counts, [channelId]: 0 }));
	unreadCount.update((count) => Math.max(0, count - prior));
}

export function retryMessagePersistence(channelId: string, messageId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('retry-message', { channelId, messageId });
}

export type SendMessageResult =
	| { ok: true; clientMessageId: string; queuedOffline?: boolean }
	| { ok: false; reason: 'no_socket' | 'empty' | 'no_channel' };

/**
 * Send a chat message. Returns a result so the composer can keep the draft
 * when the socket is missing instead of silently clearing the input.
 */
export async function sendMessage(
	channelId: string,
	content: string,
	type: MessageType = 'text',
	options: Record<string, unknown> = {}
): Promise<SendMessageResult> {
	if (!channelId) return { ok: false, reason: 'no_channel' };

	const trimmed = content.trim();
	// Non-text types (gif/file/emoji) may have empty text with media in options.
	if (!trimmed && type === 'text') return { ok: false, reason: 'empty' };

	const sock = getSocket();
	const online = get(connected);
	const db = getWabiDB();
	// Offline with local queue: allow enqueue without a live socket.
	if (!sock && !(db && !online)) {
		return { ok: false, reason: 'no_socket' };
	}

	const clientMessageId = createClientMessageId(channelId);
	const me = get(currentUser);
	// Prefer stable user-<dbId> so optimistic rows match server echoes and isOwnMessage.
	const stableId =
		(typeof me?.dbUserId === 'number' && me.dbUserId > 0
			? `user-${me.dbUserId}`
			: null) ||
		me?.id ||
		sock?.id ||
		'local';

	// Only lift known message fields from options — avoid polluting the row with
	// upload metadata keys the renderer does not expect on text messages.
	const {
		replyTo,
		isSpoiler,
		entities,
		gifUrl,
		emojiUrl,
		emojiName,
		fileUrl,
		fileName,
		fileSize,
		files,
		attachmentEncryption,
		attachmentStorage,
		encrypted,
		iv
	} = options as Partial<Message>;

	const optimisticMessage: Message = {
		id: clientMessageId,
		clientMessageId,
		user: me?.username || 'You',
		userId: stableId,
		senderStableId: stableId,
		color: me?.color || '#98D8C8',
		text: trimmed,
		timestamp: Date.now(),
		type,
		deliveryState: 'sending',
		...(replyTo !== undefined ? { replyTo } : {}),
		...(isSpoiler !== undefined ? { isSpoiler } : {}),
		...(entities !== undefined ? { entities } : {}),
		...(gifUrl !== undefined ? { gifUrl } : {}),
		...(emojiUrl !== undefined ? { emojiUrl } : {}),
		...(emojiName !== undefined ? { emojiName } : {}),
		...(fileUrl !== undefined ? { fileUrl } : {}),
		...(fileName !== undefined ? { fileName } : {}),
		...(fileSize !== undefined ? { fileSize } : {}),
		...(files !== undefined ? { files } : {}),
		...(attachmentEncryption !== undefined ? { attachmentEncryption } : {}),
		...(attachmentStorage !== undefined ? { attachmentStorage } : {}),
		...(encrypted !== undefined ? { encrypted } : {}),
		...(iv !== undefined ? { iv } : {})
	};

	appendOptimisticMessage(channelId, optimisticMessage);

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
		return { ok: true, clientMessageId, queuedOffline: true };
	}

	// sock is defined here (guarded above unless offline queue path returned).
	sock!.emit('message', {
		channelId,
		text: trimmed,
		type,
		clientMessageId,
		...options
	});
	return { ok: true, clientMessageId };
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
