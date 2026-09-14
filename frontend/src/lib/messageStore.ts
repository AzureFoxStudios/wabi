/**
 * messageStore.ts
 * Core message state and operations
 */

import { writable, get, type Writable } from 'svelte/store';
import type { Message } from './socket-types';
import type { MessageType } from '../../../packages/wabi-protocol/src/generated/MessageType';
import { getSocket, connected } from './socketConnection';
import { getWabiDB } from '$lib/wabidb';
import { currentUser } from './presenceStore';
import { groupMembership } from './groupAccess';
import { authSessionGeneration, getGuestSessionId, onAuthSessionCleared } from './authSession';
import { getServerUrl, normalizeServerUrl } from './serverUrl';
import { messageDeliveries, UNCONFIRMED_MESSAGE } from './messageDelivery';
import { MESSAGE_QUEUE_OWNERSHIP_ERROR } from './wabidb/queue/groupPolicy';
import { E2EE_MESSAGE_PREFIX, encryptMessageForChannel, prepareIncomingE2eeMessage } from './e2ee';
import { showToast } from './toast';

export const channelMessages = writable<Record<string, Message[]>>({ general: [] });
export const unreadCount = writable(0);
export const lastReadMessageId = writable<string | null>(null);
export const channelUnreadCounts = writable<Record<string, number>>({});

const channelSliceStores = new Map<string, Writable<Message[]>>();
const e2eeHydrating = new Set<string>();

/**
 * One receive boundary for live messages, history, reconnects and edits. The
 * socket layer is allowed to carry opaque ciphertext, but render/search/context
 * code downstream sees only authenticated plaintext or a safe failure marker.
 */
channelMessages.subscribe((state) => {
	for (const [channelId, messages] of Object.entries(state)) {
		for (const message of messages) {
			const ciphertext = typeof message?.text === 'string' ? message.text : '';
			if (!ciphertext.startsWith(E2EE_MESSAGE_PREFIX)) continue;
			const key = `${channelId}|${message.id}|${message.clientMessageId || ''}|${ciphertext}`;
			if (e2eeHydrating.has(key)) continue;
			e2eeHydrating.add(key);
			void prepareIncomingE2eeMessage(channelId, message)
				.then((prepared) => {
					channelMessages.update((current) => {
						const list = current[channelId];
						if (!list) return current;
						let changed = false;
						const next = list.map((candidate) => {
							const sameIdentity = candidate.id === message.id ||
								(Boolean(candidate.clientMessageId) && candidate.clientMessageId === message.clientMessageId);
							if (!sameIdentity || candidate.text !== ciphertext) return candidate;
							changed = true;
							return prepared;
						});
						return changed ? { ...current, [channelId]: next } : current;
					});
				})
				.catch((error) => console.warn('[e2ee] Message hydration failed', error))
				.finally(() => e2eeHydrating.delete(key));
		}
	}
});

export function channelMessagesStore(channelId: string): Writable<Message[]> {
	if (!channelId) return writable([]);
	let store = channelSliceStores.get(channelId);
	if (!store) {
		store = writable<Message[]>(get(channelMessages)[channelId] || []);
		channelSliceStores.set(channelId, store);
		let prev: Message[] = get(store);
		const unsub = channelMessages.subscribe((map) => {
			const next = map[channelId];
			if ((next || []) !== prev && !(next === undefined && prev.length === 0)) {
				prev = next || [];
				store!.set(prev);
			}
		});
		void unsub;
	}
	return store;
}

export function dropChannelMessagesStore(channelId: string): void { channelSliceStores.delete(channelId); }

function createClientMessageId(channelId: string): string {
	return `optimistic:${channelId}:${Date.now()}:${Math.random().toString(36).substring(7)}`;
}

function computeOptimisticDeletionTime(channelId: string, timestamp: number): number | undefined {
	const OPTIMISTIC_DELETE_WINDOW_MS = 10 * 60 * 1000;
	const age = Date.now() - timestamp;
	return age < OPTIMISTIC_DELETE_WINDOW_MS ? Date.now() + (OPTIMISTIC_DELETE_WINDOW_MS - age) : undefined;
}

function appendOptimisticMessage(channelId: string, message: Message): void {
	channelMessages.update((msgs) => ({ ...msgs, [channelId]: [...(msgs[channelId] || []), message] }));
}
function removeOptimisticMessage(channelId: string, messageId: string): void {
	channelMessages.update((msgs) => ({ ...msgs, [channelId]: (msgs[channelId] || []).filter((m) => m.id !== messageId) }));
}
function updateOptimisticMessage(channelId: string, matcher: (message: Message) => boolean, patch: Partial<Message>): void {
	channelMessages.update((msgs) => {
		const existing = msgs[channelId] || [];
		let changed = false;
		const nextMessages = existing.map((message) => {
			if (!matcher(message)) return message;
			changed = true;
			return { ...message, ...patch };
		});
		return changed ? { ...msgs, [channelId]: nextMessages } : msgs;
	});
}

export function markMessagesAsRead(): void {
	const sock = getSocket();
	if (sock) sock.emit('mark-messages-as-read');
}

export function markChannelAsRead(channelId: string): void {
	const sock = getSocket();
	if (!sock) return;
	const messages = get(channelMessages)[channelId] || [];
	if (messages.length > 0) lastReadMessageId.set(messages[messages.length - 1].id);
	sock.emit('mark-channel-as-read', { channelId });
	const prior = get(channelUnreadCounts)[channelId] || 0;
	channelUnreadCounts.update((counts) => ({ ...counts, [channelId]: 0 }));
	unreadCount.update((count) => Math.max(0, count - prior));
}

export type SendMessageResult =
	| { ok: true; clientMessageId: string; queuedOffline?: boolean }
	| { ok: false; reason: 'no_socket' | 'empty' | 'no_channel' | 'queue_failed' };

export async function sendMessage(
	channelId: string,
	content: string,
	type: MessageType = 'text',
	options: Record<string, unknown> = {}
): Promise<SendMessageResult> {
	if (!channelId || !groupMembership.acceptsContent(channelId)) return { ok: false, reason: 'no_channel' };
	const trimmed = content.trim();
	if (!trimmed && type === 'text') return { ok: false, reason: 'empty' };

	const sock = getSocket();
	const online = get(connected);
	const db = getWabiDB();
	if (!sock && !(db && !online)) return { ok: false, reason: 'no_socket' };

	let wireText = trimmed;
	let wireType: MessageType = type;
	let wireOptions: Record<string, unknown> = options;
	let e2eeEpoch: number | null = null;
	try {
		const encrypted = await encryptMessageForChannel(channelId, trimmed, type, options);
		if (encrypted) {
			wireText = encrypted.wireText;
			wireType = encrypted.wireType as MessageType;
			wireOptions = encrypted.wireOptions;
			e2eeEpoch = encrypted.epoch;
		}
	} catch (error) {
		showToast(error instanceof Error ? error.message : 'Could not encrypt this message.', 'error');
		return { ok: false, reason: 'queue_failed' };
	}

	const clientMessageId = createClientMessageId(channelId);
	const me = get(currentUser);
	const stableId =
		(typeof me?.dbUserId === 'number' && me.dbUserId > 0 ? `user-${me.dbUserId}` : null) ||
		me?.id || sock?.id || 'local';
	const {
		replyTo, isSpoiler, entities, gifUrl, emojiUrl, emojiName, fileUrl, fileName,
		fileSize, files, attachmentEncryption, attachmentStorage, encrypted, iv
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
		...(iv !== undefined ? { iv } : {}),
		...(e2eeEpoch !== null ? { encrypted: true, e2ee: true, e2eeVerified: true, e2eeEpoch } : {})
	};
	appendOptimisticMessage(channelId, optimisticMessage);

	if (db && !online) {
		const groupRealm = groupMembership.realm();
		const lease = groupMembership.tracks(channelId) ? groupMembership.capture(channelId) : null;
		const server = normalizeServerUrl(getServerUrl());
		const generation = authSessionGeneration(server);
		const guest = getGuestSessionId();
		let sessionCurrent = true;
		const unsubscribe = onAuthSessionCleared(clearedServer => {
			if (normalizeServerUrl(clearedServer) === server) sessionCurrent = false;
		});
		const canUpdate = () => sessionCurrent && authSessionGeneration(server) === generation && normalizeServerUrl(getServerUrl()) === server &&
			groupMembership.realm() === groupRealm && getGuestSessionId() === guest && (!lease || groupMembership.current(lease));
		try {
			await db.enqueue({
				scopeId: 'corechat',
				type: 'send-message',
				payload: { ...wireOptions, channelId, text: wireText, type: wireType, clientMessageId }
			});
			if (canUpdate()) updateOptimisticMessage(
				channelId,
				(m) => m.clientMessageId === clientMessageId && m.deliveryState === 'sending' &&
					!messageDeliveries.has(getSocket() ?? {}, { channelId, clientMessageId }),
				{ deliveryState: 'queued', deliveryError: undefined }
			);
			if (canUpdate() && get(connected)) {
				void import('./wabidb/drain').then(({ drainOutboundQueue }) => {
					if (canUpdate() && get(connected)) return drainOutboundQueue();
				}).catch(error => console.warn('[queue] Could not dispatch newly queued message', error));
			}
			return { ok: true, clientMessageId, queuedOffline: true };
		} catch (error) {
			if (canUpdate()) updateOptimisticMessage(
				channelId,
				(m) => m.clientMessageId === clientMessageId,
				{ deliveryState: 'failed', deliveryError: error instanceof Error && error.message === MESSAGE_QUEUE_OWNERSHIP_ERROR
					? 'Not queued — offline messages require a signed-in account. Your draft is still available.'
					: 'Not queued — local storage failed. Your draft is still available.' }
			);
			return { ok: false, reason: 'queue_failed' };
		} finally { unsubscribe(); }
	}

	_trackMessageDelivery(sock!, channelId, clientMessageId);
	try {
		sock!.emit('message', { ...wireOptions, channelId, text: wireText, type: wireType, clientMessageId });
	} catch {
		messageDeliveries.unconfirm(sock!, { channelId, clientMessageId });
	}
	return { ok: true, clientMessageId };
}

export function _trackMessageDelivery(sock: object, channelId: string, clientMessageId: string,
	onUnknown: () => void = () => {}): void {
	const realm = groupMembership.realm();
	const lease = groupMembership.tracks(channelId) ? groupMembership.capture(channelId) : null;
	const server = normalizeServerUrl(getServerUrl());
	const guest = getGuestSessionId();
	let sessionCurrent = true;
	let unsubscribe = () => {};
	const cancel = messageDeliveries.start(sock, { channelId, clientMessageId }, () => {
		if (sessionCurrent && normalizeServerUrl(getServerUrl()) === server && groupMembership.realm() === realm &&
			getGuestSessionId() === guest && (!lease || groupMembership.current(lease))) {
			updateOptimisticMessage(channelId, m => m.clientMessageId === clientMessageId && m.deliveryState === 'sending',
				{ deliveryState: 'failed', deliveryError: UNCONFIRMED_MESSAGE, deliveryOutcome: 'unknown' });
		}
		onUnknown();
	}, () => unsubscribe());
	unsubscribe = onAuthSessionCleared(clearedServer => {
		if (normalizeServerUrl(clearedServer) === server) { sessionCurrent = false; cancel(); }
	});
}

export async function editMessage(channelId: string, messageId: string, newText: string): Promise<void> {
	const sock = getSocket();
	if (!sock) return;
	updateOptimisticMessage(channelId, (m) => m.id === messageId, { text: newText, isEdited: true });

	let wireText = newText;
	try {
		const encrypted = await encryptMessageForChannel(channelId, newText, 'text', {});
		if (encrypted) wireText = encrypted.wireText;
	} catch (error) {
		showToast(error instanceof Error ? error.message : 'Could not encrypt this edit.', 'error');
		return;
	}

	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({
			scopeId: 'corechat',
			type: 'edit-message',
			payload: { channelId, messageId, newText: wireText }
		});
		updateOptimisticMessage(channelId, (m) => m.id === messageId,
			{ deliveryState: 'failed', deliveryError: 'Queued — will send when online' });
		return;
	}
	sock.emit('edit-message', { channelId, messageId, newText: wireText });
}

export async function deleteMessage(channelId: string, messageId: string): Promise<void> {
	const sock = getSocket();
	if (!sock) return;
	removeOptimisticMessage(channelId, messageId);
	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({ scopeId: 'corechat', type: 'delete-message', payload: { channelId, messageId } });
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
		await db.enqueue({ scopeId: 'corechat', type: 'toggle-pin-message', payload: { channelId, messageId } });
		return;
	}
	sock.emit('toggle-pin-message', { channelId, messageId });
}

export function _incrementUnreadCount(channelId: string, messageId: string): void {
	channelUnreadCounts.update((counts) => ({ ...counts, [channelId]: (counts[channelId] || 0) + 1 }));
	unreadCount.update((count) => count + 1);
	lastReadMessageId.set(messageId);
}
export function _appendOptimisticMessage(channelId: string, message: Message): void { appendOptimisticMessage(channelId, message); }
export function _removeOptimisticMessage(channelId: string, messageId: string): void { removeOptimisticMessage(channelId, messageId); }
export function _updateOptimisticMessage(channelId: string, matcher: (message: Message) => boolean, patch: Partial<Message>): void {
	updateOptimisticMessage(channelId, matcher, patch);
}
