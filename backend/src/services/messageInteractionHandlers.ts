interface UserLike {
  id: string;
  username: string;
  dbUserId?: number;
}

interface ChannelLike {
  id: string;
  pinnedBy?: string[];
}

interface MessageLike {
  id: string;
  userId: string;
  senderStableId?: string;
  isPinned?: boolean;
  reactions?: Record<string, string[]>;
}

interface MessageInteractionSocketLike {
  id: string;
  emit(event: string, payload: unknown): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

interface RegisterMessageInteractionHandlersOptions<TUser extends UserLike, TChannel extends ChannelLike, TMessage extends MessageLike> {
  socket: MessageInteractionSocketLike;
  users: Map<string, TUser>;
  channels: Map<string, TChannel>;
  channelMessages: Map<string, TMessage[]>;
  pinnedMessages: Map<string, Set<string>>;
  typingUsers: Set<string>;
  channelTypingUsers: Map<string, Set<string>>;
  getAccessibleChannel: (channelId: string) => TChannel | undefined;
  getSocketStableId: () => string;
  applyEmojiRoleRules: (targetDbUserId: number | undefined, channelId: string, messageId: string, emojiId: string, removed: boolean) => void;
  persistMessagePinState: (messageId: string, isPinned: boolean) => void;
  persistMessageReactions: (messageId: string, reactions: Record<string, string[]>) => void;
  emitToChannel: (channelId: string, event: string, payload: unknown) => void;
  emitToAllSockets: (event: string, payload: unknown) => void;
}

export function registerMessageInteractionHandlers<TUser extends UserLike, TChannel extends ChannelLike, TMessage extends MessageLike>({
  socket,
  users,
  channels,
  channelMessages,
  pinnedMessages,
  typingUsers,
  channelTypingUsers,
  getAccessibleChannel,
  getSocketStableId,
  applyEmojiRoleRules,
  persistMessagePinState,
  persistMessageReactions,
  emitToChannel,
  emitToAllSockets
}: RegisterMessageInteractionHandlersOptions<TUser, TChannel, TMessage>): void {
  socket.on("toggle-pin-message", (data: { messageId: string; channelId: string }) => {
    if (!getAccessibleChannel(data.channelId)) return;

    const messages = channelMessages.get(data.channelId);
    if (!messages) return;

    const message = messages.find((entry) => entry.id === data.messageId);
    if (!message) return;

    message.isPinned = !message.isPinned;

    let channelPins = pinnedMessages.get(data.channelId);
    if (!channelPins) {
      channelPins = new Set();
      pinnedMessages.set(data.channelId, channelPins);
    }

    if (message.isPinned) {
      channelPins.add(data.messageId);
    } else {
      channelPins.delete(data.messageId);
    }

    try {
      persistMessagePinState(data.messageId, Boolean(message.isPinned));
    } catch (error) {
      console.error('[MessageRepository] Failed to update pin state:', error);
    }

    emitToChannel(data.channelId, "message-pin-toggled", {
      channelId: data.channelId,
      messageId: data.messageId,
      isPinned: message.isPinned
    });
  });

  socket.on("pin-channel", (data: { channelId: string }) => {
    const channel = channels.get(data.channelId);
    if (!channel) return;

    if (!channel.pinnedBy) {
      channel.pinnedBy = [];
    }

    if (!channel.pinnedBy.includes(socket.id)) {
      channel.pinnedBy.push(socket.id);
    }

    channels.set(data.channelId, channel);
    emitToAllSockets("channel-pinned", { channelId: data.channelId, channel });
  });

  socket.on("unpin-channel", (data: { channelId: string }) => {
    const channel = channels.get(data.channelId);
    if (!channel || !channel.pinnedBy) return;

    channel.pinnedBy = channel.pinnedBy.filter((id) => id !== socket.id);
    channels.set(data.channelId, channel);
    emitToAllSockets("channel-unpinned", { channelId: data.channelId, channel });
  });

  socket.on("add-reaction", (data: { messageId: string; channelId: string; emojiId: string }) => {
    if (!getAccessibleChannel(data.channelId)) return;

    const messages = channelMessages.get(data.channelId);
    if (!messages) return;

    const message = messages.find((entry) => entry.id === data.messageId);
    if (!message) return;

    const user = users.get(socket.id);
    if (!user) return;

    const stableReactionUserId = getSocketStableId();
    if (!message.reactions) {
      message.reactions = {};
    }
    if (!message.reactions[data.emojiId]) {
      message.reactions[data.emojiId] = [];
    }

    const reactionUserIds = message.reactions[data.emojiId];
    const hasStableReaction = reactionUserIds.includes(stableReactionUserId);
    const hasLegacySocketReaction = reactionUserIds.includes(user.id);

    if (!hasStableReaction && !hasLegacySocketReaction) {
      reactionUserIds.push(stableReactionUserId);
      applyEmojiRoleRules(user.dbUserId, data.channelId, data.messageId, data.emojiId, false);
    } else if (!hasStableReaction && hasLegacySocketReaction) {
      message.reactions[data.emojiId] = reactionUserIds.filter((id) => id !== user.id);
      message.reactions[data.emojiId].push(stableReactionUserId);
    }

    try {
      persistMessageReactions(data.messageId, message.reactions);
    } catch (error) {
      console.error('[MessageRepository] Failed to update reactions:', error);
    }

    emitToChannel(data.channelId, "reaction-added", {
      channelId: data.channelId,
      messageId: data.messageId,
      emojiId: data.emojiId,
      userId: stableReactionUserId,
      reactions: message.reactions
    });
  });

  socket.on("remove-reaction", (data: { messageId: string; channelId: string; emojiId: string }) => {
    if (!getAccessibleChannel(data.channelId)) return;

    const messages = channelMessages.get(data.channelId);
    if (!messages) return;

    const message = messages.find((entry) => entry.id === data.messageId);
    if (!message || !message.reactions) return;

    const user = users.get(socket.id);
    if (!user) return;

    const stableReactionUserId = getSocketStableId();
    if (message.reactions[data.emojiId]) {
      const hadReaction =
        message.reactions[data.emojiId].includes(stableReactionUserId) ||
        message.reactions[data.emojiId].includes(user.id);
      message.reactions[data.emojiId] = message.reactions[data.emojiId].filter(
        (id) => id !== stableReactionUserId && id !== user.id
      );
      if (hadReaction) {
        applyEmojiRoleRules(user.dbUserId, data.channelId, data.messageId, data.emojiId, true);
      }

      if (message.reactions[data.emojiId].length === 0) {
        delete message.reactions[data.emojiId];
      }
    }

    try {
      persistMessageReactions(data.messageId, message.reactions);
    } catch (error) {
      console.error('[MessageRepository] Failed to update reactions:', error);
    }

    emitToChannel(data.channelId, "reaction-removed", {
      channelId: data.channelId,
      messageId: data.messageId,
      emojiId: data.emojiId,
      userId: stableReactionUserId,
      reactions: message.reactions
    });
  });

  socket.on("typing", (data: { isTyping: boolean; channelId: string }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const channelId = data.channelId;
    if (!channelId) return;

    let channelTyping = channelTypingUsers.get(channelId);
    if (!channelTyping) {
      channelTyping = new Set<string>();
      channelTypingUsers.set(channelId, channelTyping);
    }

    if (data.isTyping) {
      typingUsers.add(socket.id);
      channelTyping.add(socket.id);
    } else {
      typingUsers.delete(socket.id);
      channelTyping.delete(socket.id);
    }

    const typingUsernames = Array.from(channelTyping)
      .map((id) => users.get(id)?.username)
      .filter((value): value is string => Boolean(value));
    emitToChannel(channelId, "typing", { channelId, usernames: typingUsernames });
  });
}
