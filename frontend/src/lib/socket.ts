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

// Re-export everything from the new socket manager

// Stubs for symbols no longer exported by socket-manager but still imported downstream
export class socketManager {
	static getInstance() { return this; }
}
export const dmPanelSignal = writable<{ channelId: string; otherUser: User } | null>(null);
export const emojis = writable<Emoji[]>([]);

export function joinVoiceChannel(_channelId: string) { console.warn('[stub] joinVoiceChannel'); }
export function leaveVoiceChannel(_channelId?: string) { console.warn('[stub] leaveVoiceChannel'); }
export function sendMessage(_channelId: string, _content: string, ..._rest: any[]) { console.warn('[stub] sendMessage'); }
export function retryDecryptLoadedDmMessages() { console.warn('[stub] retryDecryptLoadedDmMessages'); }
export function loadOlderMessages(_channelId: string) { console.warn('[stub] loadOlderMessages'); }
export function updateProfile(..._args: any[]) { console.warn('[stub] updateProfile'); }
export function createDM(_userId: string) { console.warn('[stub] createDM'); }
export function deleteDM(_channelId: string) { console.warn('[stub] deleteDM'); }
export function getDMChannelIdForUser(current: User | null | undefined, target: User): string {
	const currentKey = current?.dbUserId ? `user-${current.dbUserId}` : current?.id || 'me';
	const targetKey = target.dbUserId ? `user-${target.dbUserId}` : target.id;
	return `dm-${[currentKey, targetKey].sort().join('-')}`;
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

	// Message operations
// sendMessage,
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
// createDM,
// deleteDM,
// getDMChannelIdForUser,
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
