import type { MessageRetentionDuration } from "../../../shared/messageRetention.js";

interface UserLike {
  id: string;
  username: string;
  color?: string;
  status?: string;
  profilePicture?: string | null;
  dbUserId?: number;
}

interface ChannelLike {
  id: string;
  type?: 'text' | 'voice' | 'dm' | 'group' | 'public' | 'thread_public' | 'thread_private';
  members?: string[];
  recipientNotified?: boolean;
  autoDeleteAfter?: MessageRetentionDuration | null;
  persistMessages?: boolean;
}

interface MessageLike {
  id: string;
  user: string;
  userId: string;
  senderStableId?: string;
  color?: string;
  text: string;
  timestamp: number;
  type: string;
  scheduledDeletionTime?: number;
  encrypted?: boolean;
  entities?: unknown[];
  isEdited?: boolean;
  clientMessageId?: string;
  reactions?: Record<string, string[]>;
  isPinned?: boolean;
  [key: string]: unknown;
}

interface MessagePipelineSocketLike {
  id: string;
  emit(event: string, payload: unknown): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

interface HistoryRequestPayload {
  channelId: string;
  beforeMessageId?: string;
  afterMessageId?: string;
  limit?: number;
  requestId?: string;
}

interface MessageSendPayload {
  text: string;
  type: 'text' | 'gif' | 'file' | 'emoji' | 'role_gate';
  channelId: string;
  clientMessageId?: string;
  gifUrl?: string;
  emojiUrl?: string;
  emojiName?: string;
  fileUrl?: string;
  fileName?: string;
  fileSize?: number;
  files?: unknown[];
  attachmentEncryption?: unknown;
  attachmentStorage?: unknown;
  replyTo?: string;
  entities?: unknown;
  isSpoiler?: boolean;
  encrypted?: boolean;
  iv?: string;
  roleGatePersist?: boolean;
}

interface RegisterMessagePipelineHandlersOptions<
  TUser extends UserLike,
  TChannel extends ChannelLike,
  TMessage extends MessageLike
> {
  socket: MessagePipelineSocketLike;
  users: Map<string, TUser>;
  channels: Map<string, TChannel>;
  channelMessages: Map<string, TMessage[]>;
  typingUsers: Set<string>;
  channelTypingUsers: Map<string, Set<string>>;
  historyLoadInFlight: Set<string>;
  getAccessibleChannel: (channelId: string) => TChannel | undefined;
  canAccessChannel: (channel: TChannel) => boolean;
  getSocketStableId: () => string;
  getSocketHighestRole: () => string;
  getRetryAttempts: (messageId: string) => number;
  loadPersistedHistory: (payload: {
    channelId: string;
    limit: number;
    beforeMessageId?: string;
    afterMessageId?: string;
  }) => TMessage[];
  handleTestingRoleCheatcode: (normalizedText: string, user: TUser) => boolean;
  validateRoleGateMessage: (user: TUser, data: MessageSendPayload) => string | null;
  createMessageId: (senderStableId: string) => string;
  normalizeClientUploadUrl: (rawUrl?: string) => string | null | undefined;
  normalizeClientFileAttachment: (file: unknown) => unknown | null;
  normalizeClientMessageEntities: (entities: unknown, text: string, allowClientParsing: boolean) => unknown[];
  sanitizeUploadFileName: (fileName: string) => string;
  buildDeletionConfig: (channel: TChannel) => {
    scheduledDeletionTime?: number;
    deletionDuration: MessageRetentionDuration | null;
  };
  emitToStableUser: (stableUserId: string, event: string, payload: unknown) => boolean;
  emitToChannel: (channelId: string, event: string, payload: unknown) => void;
  scheduleMessageDeletion: (channelId: string, messageId: string, deletionDuration: MessageRetentionDuration | null) => void;
  persistMessageOnSend: (socket: MessagePipelineSocketLike, channel: TChannel, data: MessageSendPayload, message: TMessage) => void;
  retryPersistMessage: (socket: MessagePipelineSocketLike, channelId: string, message: TMessage) => Promise<void>;
  markMessageEdited: (messageId: string, newText: string) => void;
  findPersistedMessageSenderId: (messageId: string) => string | null;
  deleteRealtimeMessage: (channelId: string, messageId: string, reason: string) => void;
  emitMessageCreatedSideEffects: (payload: {
    channelId: string;
    message: TMessage;
    user: TUser;
    data: MessageSendPayload;
    senderStableId: string;
  }) => void;
  logEnabled: boolean;
  log: (...args: unknown[]) => void;
}

function getHistoryDirection(data: HistoryRequestPayload): 'older' | 'newer' | 'initial' {
  if (data.beforeMessageId) return 'older';
  if (data.afterMessageId) return 'newer';
  return 'initial';
}

function getFallbackHistoryDirection(data: HistoryRequestPayload): 'older' | 'initial' {
  return data.beforeMessageId ? 'older' : 'initial';
}

export function registerMessagePipelineHandlers<
  TUser extends UserLike,
  TChannel extends ChannelLike,
  TMessage extends MessageLike
>({
  socket,
  users,
  channels,
  channelMessages,
  typingUsers,
  channelTypingUsers,
  historyLoadInFlight,
  getAccessibleChannel,
  canAccessChannel,
  getSocketStableId,
  getSocketHighestRole,
  getRetryAttempts,
  loadPersistedHistory,
  handleTestingRoleCheatcode,
  validateRoleGateMessage,
  createMessageId,
  normalizeClientUploadUrl,
  normalizeClientFileAttachment,
  normalizeClientMessageEntities,
  sanitizeUploadFileName,
  buildDeletionConfig,
  emitToStableUser,
  emitToChannel,
  scheduleMessageDeletion,
  persistMessageOnSend,
  retryPersistMessage,
  markMessageEdited,
  findPersistedMessageSenderId,
  deleteRealtimeMessage,
  emitMessageCreatedSideEffects,
  logEnabled,
  log
}: RegisterMessagePipelineHandlersOptions<TUser, TChannel, TMessage>): void {
  socket.on("load-history", (data: HistoryRequestPayload) => {
    const historyKey = `${data.channelId}|${data.beforeMessageId || ''}|${data.afterMessageId || ''}|${data.limit || 50}`;
    if (historyLoadInFlight.has(historyKey)) {
      if (logEnabled) {
        log(`[load-history] duplicate in-flight for ${historyKey} ignored`);
      }
      return;
    }

    historyLoadInFlight.add(historyKey);
    const channel = channels.get(data.channelId);
    if (!channel) {
      socket.emit("history-loaded", {
        channelId: data.channelId,
        messages: [],
        hasMore: false,
        direction: getFallbackHistoryDirection(data),
        requestId: data.requestId
      });
      historyLoadInFlight.delete(historyKey);
      return;
    }

    if (!canAccessChannel(channel)) {
      socket.emit("channel-error", "Access denied to this channel");
      historyLoadInFlight.delete(historyKey);
      return;
    }

    try {
      const limit = data.limit || 50;

      if (channel.persistMessages === true) {
        const clientMessages = loadPersistedHistory({
          channelId: data.channelId,
          limit,
          beforeMessageId: data.beforeMessageId,
          afterMessageId: data.afterMessageId
        });
        socket.emit("history-loaded", {
          channelId: data.channelId,
          messages: clientMessages,
          hasMore: clientMessages.length === limit,
          direction: getHistoryDirection(data),
          requestId: data.requestId
        });
        if (logEnabled) {
          log(`[load-history] Loaded ${clientMessages.length} messages for ${data.channelId}`);
        }
        return;
      }

      const messages = channelMessages.get(data.channelId) || [];
      let resultMessages: TMessage[] = [];
      let hasMore = false;

      if (data.beforeMessageId) {
        const endIndex = messages.findIndex((message) => message.id === data.beforeMessageId);
        if (endIndex > 0) {
          const startIndex = Math.max(0, endIndex - limit);
          resultMessages = messages.slice(startIndex, endIndex);
          hasMore = startIndex > 0;
        }
      } else if (data.afterMessageId) {
        const startIndex = messages.findIndex((message) => message.id === data.afterMessageId);
        if (startIndex >= 0) {
          resultMessages = messages.slice(startIndex + 1, startIndex + 1 + limit);
          hasMore = startIndex + 1 + limit < messages.length;
        }
      } else {
        resultMessages = messages.slice(-limit);
        hasMore = messages.length > limit;
      }

      socket.emit("history-loaded", {
        channelId: data.channelId,
        messages: resultMessages,
        hasMore,
        direction: getHistoryDirection(data),
        requestId: data.requestId
      });
    } catch (error) {
      console.error('[load-history] Failed to load history:', error);
      socket.emit("history-loaded", {
        channelId: data.channelId,
        messages: [],
        hasMore: false,
        direction: getFallbackHistoryDirection(data),
        requestId: data.requestId
      });
    } finally {
      historyLoadInFlight.delete(historyKey);
    }
  });

  socket.on("message", (data: MessageSendPayload) => {
    const user = users.get(socket.id);
    if (!user) return;

    const channel = getAccessibleChannel(data.channelId);
    if (!channel) return;

    const normalizedText = typeof data.text === 'string' ? data.text.trim().toLowerCase() : '';
    if (data.type === 'text' && handleTestingRoleCheatcode(normalizedText, user)) {
      return;
    }

    if (data.type === 'role_gate') {
      const roleGateError = validateRoleGateMessage(user, data);
      if (roleGateError) {
        socket.emit("channel-error", roleGateError);
        return;
      }
    }

    const { scheduledDeletionTime, deletionDuration } = buildDeletionConfig(channel);
    const senderStableId = getSocketStableId();
    const normalizedClientMessageId =
      typeof data.clientMessageId === 'string' && /^[A-Za-z0-9:_-]{8,120}$/.test(data.clientMessageId.trim())
        ? data.clientMessageId.trim()
        : null;

    const message = {
      id: normalizedClientMessageId || createMessageId(senderStableId),
      user: user.username,
      userId: socket.id,
      senderStableId,
      color: user.color,
      text: data.text,
      timestamp: Date.now(),
      type: data.type,
      scheduledDeletionTime
    } as TMessage;

    const normalizedSingleFileUrl = normalizeClientUploadUrl(data.fileUrl);
    const normalizedFiles = Array.isArray(data.files)
      ? data.files
          .map((file) => normalizeClientFileAttachment(file))
          .filter((file): file is Exclude<ReturnType<typeof normalizeClientFileAttachment>, null> => Boolean(file))
      : [];
    const normalizedEntities = normalizeClientMessageEntities(data.entities, data.text, !data.encrypted);

    if (data.gifUrl) message.gifUrl = data.gifUrl;
    if (data.emojiUrl) message.emojiUrl = data.emojiUrl;
    if (data.emojiName) message.emojiName = data.emojiName;
    if (normalizedSingleFileUrl) message.fileUrl = normalizedSingleFileUrl;
    if (data.fileName) message.fileName = sanitizeUploadFileName(data.fileName);
    if (data.fileSize) message.fileSize = Math.max(0, Math.floor(data.fileSize));
    if (normalizedFiles.length > 0) message.files = normalizedFiles;
    if (normalizedEntities.length > 0) message.entities = normalizedEntities;
    if (normalizedClientMessageId) message.clientMessageId = normalizedClientMessageId;
    if (data.attachmentEncryption) message.attachmentEncryption = data.attachmentEncryption;
    if (data.attachmentStorage) message.attachmentStorage = data.attachmentStorage;
    if (data.replyTo) message.replyTo = data.replyTo;
    if (data.isSpoiler) message.isSpoiler = data.isSpoiler;
    if (data.encrypted) message.encrypted = true;
    if (data.iv) message.iv = data.iv;

    const messages = channelMessages.get(data.channelId) || [];
    messages.push(message);
    channelMessages.set(data.channelId, messages);

    socket.emit("message-accepted", {
      channelId: data.channelId,
      messageId: message.id,
      clientMessageId: normalizedClientMessageId,
      timestamp: message.timestamp,
      scheduledDeletionTime: message.scheduledDeletionTime
    });

    if (channel.type === 'dm' && !channel.recipientNotified && channel.members) {
      const myStableId = getSocketStableId();
      const recipientStableId = channel.members.find((memberId) => memberId !== myStableId);
      if (recipientStableId) {
        emitToStableUser(recipientStableId, "dm-channel-added", {
          channelId: data.channelId,
          channel,
          otherUser: {
            id: user.id,
            username: user.username,
            color: user.color,
            status: user.status,
            profilePicture: user.profilePicture,
            dbUserId: user.dbUserId
          }
        });
        channel.recipientNotified = true;
      }
    }

    emitToChannel(data.channelId, "message", { channelId: data.channelId, message });
    if (deletionDuration) {
      scheduleMessageDeletion(data.channelId, message.id, deletionDuration);
    }

    persistMessageOnSend(socket, channel, data, message);
    emitMessageCreatedSideEffects({
      channelId: data.channelId,
      message,
      user,
      data,
      senderStableId
    });

    if (typingUsers.has(socket.id)) {
      typingUsers.delete(socket.id);
      const channelTyping = channelTypingUsers.get(data.channelId);
      if (channelTyping) {
        channelTyping.delete(socket.id);
        const typingUsernames = Array.from(channelTyping)
          .map((id) => users.get(id)?.username)
          .filter((value): value is string => Boolean(value));
        emitToChannel(data.channelId, "typing", { channelId: data.channelId, usernames: typingUsernames });
      }
    }
  });

  socket.on("edit-message", (data: { messageId: string; newText: string; channelId: string }) => {
    if (!getAccessibleChannel(data.channelId)) return;

    const messages = channelMessages.get(data.channelId);
    if (!messages) return;

    const message = messages.find((entry) => entry.id === data.messageId);
    if (!message) return;

    const stableId = getSocketStableId();
    if (message.userId !== socket.id && message.userId !== stableId && message.senderStableId !== stableId) return;
    if (message.encrypted) return;

    message.text = data.newText;
    delete message.entities;
    message.isEdited = true;

    try {
      markMessageEdited(data.messageId, data.newText);
    } catch (error) {
      console.error('[MessageRepository] Failed to persist edit:', error);
    }

    emitToChannel(data.channelId, "message-edited", {
      channelId: data.channelId,
      messageId: data.messageId,
      newText: data.newText,
      entities: []
    });
  });

  socket.on("delete-message", (data: { messageId: string; channelId: string }) => {
    if (!getAccessibleChannel(data.channelId)) return;

    const messages = channelMessages.get(data.channelId);
    if (!messages) return;

    const message = messages.find((entry) => entry.id === data.messageId);
    if (!message) return;

    const stableId = getSocketStableId();
    let canDelete =
      message.userId === socket.id ||
      message.userId === stableId ||
      message.senderStableId === stableId;

    if (!canDelete) {
      try {
        canDelete = findPersistedMessageSenderId(data.messageId) === stableId;
      } catch (error) {
        console.error('[MessageRepository] Failed ownership check for delete-message:', error);
      }
    }

    if (!canDelete && ['owner', 'admin', 'mod'].includes(getSocketHighestRole())) {
      canDelete = true;
    }
    if (!canDelete) return;

    deleteRealtimeMessage(data.channelId, data.messageId, 'socket-delete');
  });

  socket.on("retry-message-persist", async (data: { channelId: string; messageId: string }) => {
    if (!getAccessibleChannel(data.channelId)) return;

    const channel = channels.get(data.channelId);
    if (!channel?.persistMessages) {
      socket.emit("message-persist-failed", {
        channelId: data.channelId,
        messageId: data.messageId,
        attempts: getRetryAttempts(data.messageId),
        error: 'This channel is not configured for persistent messages.',
        detail: 'persistMessages=false'
      });
      return;
    }

    const messages = channelMessages.get(data.channelId);
    if (!messages) return;

    const message = messages.find((entry) => entry.id === data.messageId);
    if (!message) return;

    const stableId = getSocketStableId();
    if (message.userId !== socket.id && message.userId !== stableId && message.senderStableId !== stableId) {
      return;
    }

    await retryPersistMessage(socket, data.channelId, message);
  });
}
