/**
 * Socket.ts - Backwards-compatible wrapper
 *
 * This module re-exports everything from socket-manager.ts to maintain
 * compatibility with existing imports throughout the codebase.
 *
 * The actual implementation is in socket-manager.ts which provides:
 * - Cross-browser WebSocket stability (Chrome + Firefox parity)
 * - State machine for connection lifecycle
 * - No duplicate connections or listeners
 * - Clean reconnection with exponential backoff
 * - Proper teardown on navigation
 *
 * Migration: All new code should import from '$lib/socket-manager' directly.
 * This file exists for backwards compatibility only.
 */

import { writable, get } from 'svelte/store';
import type { Emoji, User } from './socket-types';
import { getSocket, connected } from './socketConnection';
import { getWabiDB } from '$lib/wabidb';
import { loadOlderHistory } from './messagePagination';
import {
	joinVoiceChannel as joinCallVoiceChannel,
	leaveVoiceChannel as leaveCallVoiceChannel
} from './calling_impl_core';

// Re-export everything from the new socket manager

// Stubs for symbols no longer exported by socket-manager but still imported downstream
export class socketManager {
	static getInstance() { return this; }
}
export const dmPanelSignal = writable<{ channelId: string; otherUser: User } | null>(null);
export { emojis } from './emoji-store';

export async function joinVoiceChannel(channelId: string) {
	const sock = getSocket();
	if (!sock) throw new Error('Socket is not connected');
	return joinCallVoiceChannel(sock, channelId);
}

export async function leaveVoiceChannel(channelId?: string) {
	const sock = getSocket();
	if (!sock) throw new Error('Socket is not connected');
	if (!channelId) return;
	return leaveCallVoiceChannel(sock, channelId);
}

export function retryDecryptLoadedDmMessages() { console.warn('[stub] retryDecryptLoadedDmMessages'); }
export function loadOlderMessages(channelId: string) { return loadOlderHistory(channelId); }

export async function updateProfile(...args: any[]) {
	const sock = getSocket();
	if (!sock) return;
	const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
	const [first, profilePicture, bio, username] = args;
	const patch =
		first && typeof first === 'object'
			? first
			: {
					...(typeof first === 'string' ? { status: first } : {}),
					...(typeof profilePicture === 'string' ? { profilePicture } : {}),
					...(typeof bio === 'string' ? { bio } : {}),
					...(typeof username === 'string' ? { username } : {})
				};
	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({ scopeId: 'corechat', type: 'update-profile', payload: patch });
		return;
	}
	sock.emit('update-profile', patch, callback);
}

export function createDM(userId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('create-dm', { targetUserId: userId });
}

export async function deleteDM(channelId: string) {
	const sock = getSocket();
	if (!sock) return;
	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({ scopeId: 'corechat', type: 'delete-dm', payload: { channelId } });
		return;
	}
	sock.emit('delete-dm', { channelId });
}

export function getDMChannelIdForUser(current: User, target: User): string {
	const a = current.dbUserId;
	const b = target.dbUserId;
	if (a == null || b == null) return '';
	const ids = [a, b].sort();
	return `dm-user-${ids[0]}-user-${ids[1]}`;
}
export function uploadEmote(_file: File) { console.warn('[stub] uploadEmote'); }
export function deleteEmote(_emoteId: string) { console.warn('[stub] deleteEmote'); }
export function uploadEmoji(_file: File) { console.warn('[stub] uploadEmoji'); }
export function deleteEmoji(_emojiId: string) { console.warn('[stub] deleteEmoji'); }

export {
	// Singleton manager
// socketManager,

	// Connection
	getSocket,
	initSocket,
	disconnect,

	// Stores
	socket,
	channels,
	pinnedChannels,
	currentChannel,
	channelMessages,
	users,
	serverMembers,
	typingUsers,
	currentUser,
	connected,
	unreadCount,
	lastReadMessageId,
	channelUnreadCounts,
// dmPanelSignal,
	activeVoiceChannel,
	voiceChannelMembers,
	roleDefinitions,
// emojis,
	connectionState,

	// Pagination stores (client-side)
	channelLoadedArchives,
	channelAvailableArchives,
	channelLoadingOlder,

	// Server-side history pagination stores
	channelHistoryLoading,
	channelHasMoreHistory,
	channelOldestMessageId,

	// Channel operations
	joinChannel,
	switchChannel,
// joinVoiceChannel,
// leaveVoiceChannel,
	subscribeVoiceChannel,
	unsubscribeVoiceChannel,
	setVoiceTransmitMode,
	createChannel,
	createBreakoutRooms,
	closeBreakoutRooms,
	moveUserToBreakout,
	moveUserToVoiceChannel,
	createThread,
	deleteChannel,
	pinChannel,
	unpinChannel,
	updateChannelSettings,
	reorderChannels,

	// Message operations
	sendMessage,
	retryMessagePersistence,
// retryDecryptLoadedDmMessages,
	editMessage,
	deleteMessage,
	togglePinMessage,
// loadOlderMessages,

	// Server-side history loading
	loadHistory,
	loadOlderHistory,
	syncNewerMessages,

	// User operations
	sendTyping,
// updateProfile,
	markMessagesAsRead,
	markChannelAsRead,

	// DM/Group operations
// undefined,
// deleteDM,
// "",
	createGroup,
	leaveGroup,
	kickGroupMember,
	addGroupMember,
	updateGroupAvatar,

	// Role operations
	assignRole,
	removeUserRole,
	banUser,

	// Emote operations
// uploadEmote,
// deleteEmote,

	// Emoji operations
// uploadEmoji,
// deleteEmoji,

	// Reaction operations
	addReaction,
	removeReaction,

	// Types
	type ConnectionState
} from './socket-manager';

// Stub store still consumed by SyncLoadingOverlay.svelte
export const syncProgress = writable<{ current: string; loaded: number; total: number } | null>(null);

// Re-export types from socket-types
export type { FileAttachment, Message, Emoji, User, Channel, MessageEntity, VoiceChannelSettings } from './socket-types';

// Re-export user lookup store
export { userLookup, getUserByUsername, getUserByIdentityId, getUserByMessageAuthor, getUserByMentionValue, getDMOtherUser, resolvePayTargetUser, getCurrentReactionIdentityIds, getReactionTooltip, isOwnMessage } from './userLookupStore';
