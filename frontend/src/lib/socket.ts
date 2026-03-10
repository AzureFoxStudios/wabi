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

// Re-export everything from the new socket manager
export {
	// Singleton manager
	socketManager,

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
	dmPanelSignal,
	activeVoiceChannel,
	voiceChannelMembers,
	roleDefinitions,
	emojis,
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
	joinVoiceChannel,
	leaveVoiceChannel,
	subscribeVoiceChannel,
	unsubscribeVoiceChannel,
	setVoiceTransmitMode,
	createChannel,
	createBreakoutRooms,
	closeBreakoutRooms,
	moveUserToBreakout,
	createThread,
	deleteChannel,
	pinChannel,
	unpinChannel,
	updateChannelSettings,

	// Message operations
	sendMessage,
	retryDecryptLoadedDmMessages,
	editMessage,
	deleteMessage,
	togglePinMessage,
	loadOlderMessages,

	// Server-side history loading
	loadHistory,
	loadOlderHistory,
	syncNewerMessages,

	// User operations
	sendTyping,
	updateProfile,
	markMessagesAsRead,
	markChannelAsRead,

	// DM/Group operations
	createDM,
	deleteDM,
	getDMChannelIdForUser,
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
	uploadEmote,
	deleteEmote,

	// Emoji operations
	uploadEmoji,
	deleteEmoji,

	// Reaction operations
	addReaction,
	removeReaction,

	// Types
	type ConnectionState
} from './socket-manager';

// Re-export types from socket-types
export type { FileAttachment, Message, Emoji, User, Channel } from './socket-types';
