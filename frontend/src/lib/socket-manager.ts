/**
 * socket-manager.ts
 * Unified re-export layer maintaining 100% backward compatibility
 *
 * Re-exports all modules:
 * - socketConnection.ts
 * - channelStore.ts
 * - messageStore.ts
 * - typingStore.ts
 * - presenceStore.ts
 *
 * Total exports: 82 (fully backward compatible)
 */

// ============================================================================
// RE-EXPORTS FROM socketConnection.ts
// ============================================================================

export {
	socket,
	connected,
	connectionState,
	type ConnectionState,
	type SocketManager,
	getSocket,
	initSocket,
	disconnect,
	getConnectionState
} from './socketConnection';

// ============================================================================
// RE-EXPORTS FROM channelStore.ts
// ============================================================================

export {
	channels,
	pinnedChannels,
	currentChannel,
	channelLoadedArchives,
	channelAvailableArchives,
	channelLoadingOlder,
	joinChannel,
	switchChannel,
	createChannel,
	createBreakoutRooms,
	closeBreakoutRooms,
	moveUserToBreakout,
	moveUserToVoiceChannel,
	kickVoiceMember,
	createThread,
	deleteChannel,
	pinChannel,
	unpinChannel,
	updateChannelSettings,
	reorderChannels,
	_updatePinnedChannels,
	_getChannelById
} from './channelStore';

// ============================================================================
// RE-EXPORTS FROM messageStore.ts
// ============================================================================

export {
	channelMessages,
	channelMessagesStore,
	dropChannelMessagesStore,
	unreadCount,
	lastReadMessageId,
	channelUnreadCounts,
	markMessagesAsRead,
	markChannelAsRead,
	retryMessagePersistence,
	sendMessage,
	editMessage,
	deleteMessage,
	togglePinMessage,
	_incrementUnreadCount,
	_appendOptimisticMessage,
	_removeOptimisticMessage,
	_updateOptimisticMessage
} from './messageStore';

// ============================================================================
// RE-EXPORTS FROM messagePagination.ts
// ============================================================================

export {
	channelHistoryLoading,
	channelHasMoreHistory,
	channelOldestMessageId,
	loadHistory,
	loadOlderHistory,
	syncNewerMessages,
	_getPendingHistoryRequest,
	_deletePendingHistoryRequest
} from './messagePagination';

// ============================================================================
// RE-EXPORTS FROM messageReactions.ts
// ============================================================================

export {
	addReaction,
	removeReaction
} from './messageReactions';

// ============================================================================
// RE-EXPORTS FROM typingStore.ts
// ============================================================================

export {
	typingUsers,
	sendTyping,
	_setTypingUsers,
	_addTypingUser,
	_removeTypingUser,
	_clearTypingUsers
} from './typingStore';

// ============================================================================
// RE-EXPORTS FROM presenceStore.ts
// ============================================================================

export {
	users,
	serverMembers,
	currentUser,
	activeVoiceChannel,
	voiceChannelMembers,
	roleDefinitions,
	type VoiceChannelParticipant,
	type RoleDefinition,
	subscribeVoiceChannel,
	unsubscribeVoiceChannel,
	setVoiceTransmitMode,
	assignRole,
	removeUserRole,
	banUser,
	createGroup,
	leaveGroup,
	kickGroupMember,
	addGroupMember,
	updateGroupAvatar,
	_setUsers,
	_setCurrentUser,
	_setServerMembers,
	_setActiveVoiceChannel,
	_setVoiceChannelMembers,
	_setRoleDefinitions,
	_updateVoiceChannelMember,
	_removeVoiceChannelMember
} from './presenceStore';
